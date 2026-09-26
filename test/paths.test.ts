import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { canonicalizePath, contains, expandHome, pathKind, resolveEntryPath } from "../src/paths.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "minibox-paths-"));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe("canonicalizePath", () => {
    it("resolves an existing path through its symlinks", () => {
        const real = join(fixtureRoot, "real");
        const link = join(fixtureRoot, "link");
        mkdirSync(real, { recursive: true });
        symlinkSync(real, link);

        assert.equal(canonicalizePath(link), realpathSync(real));
    });

    it("canonicalizes a path that does not exist yet through its real parent", () => {
        const real = join(fixtureRoot, "parent");
        const link = join(fixtureRoot, "parent-link");
        mkdirSync(real, { recursive: true });
        symlinkSync(real, link);

        assert.equal(canonicalizePath(join(link, "not", "created.txt")), join(realpathSync(real), "not", "created.txt"));
    });

    it("returns a relative path resolved against the process cwd", () => {
        assert.equal(canonicalizePath("."), realpathSync(process.cwd()));
    });

    it("handles the filesystem root without recursing forever", () => {
        assert.equal(canonicalizePath("/"), "/");
    });
});

describe("contains", () => {
    it("accepts the root itself", () => {
        assert.equal(contains("/a/b", "/a/b"), true);
    });

    it("accepts descendants", () => {
        assert.equal(contains("/a/b", "/a/b/c/d"), true);
    });

    it("rejects siblings that share a name prefix", () => {
        assert.equal(contains("/a/b", "/a/bc"), false);
    });

    it("rejects ancestors", () => {
        assert.equal(contains("/a/b", "/a"), false);
    });
});

describe("expandHome", () => {
    it("expands a bare tilde", () => {
        assert.equal(expandHome("~", "/home/u"), "/home/u");
    });

    it("expands a tilde prefix", () => {
        assert.equal(expandHome("~/x/y", "/home/u"), "/home/u/x/y");
    });

    it("leaves other entries untouched", () => {
        assert.equal(expandHome("~other/x", "/home/u"), "~other/x");
        assert.equal(expandHome("/abs/x", "/home/u"), "/abs/x");
        assert.equal(expandHome("rel/x", "/home/u"), "rel/x");
    });
});

describe("resolveEntryPath", () => {
    it("resolves relative entries against the project root", () => {
        assert.equal(resolveEntryPath("vendor/out", "/proj", "/home/u"), "/proj/vendor/out");
    });

    it("resolves absolute entries as written", () => {
        assert.equal(resolveEntryPath("/var/out", "/proj", "/home/u"), "/var/out");
    });

    it("resolves tilde entries against home", () => {
        assert.equal(resolveEntryPath("~/.npm", "/proj", "/home/u"), "/home/u/.npm");
    });

    it("normalizes dot segments", () => {
        assert.equal(resolveEntryPath("../sibling", "/proj/sub", "/home/u"), "/proj/sibling");
    });
});

describe("pathKind", () => {
    it("reports directories, files, and missing paths", () => {
        const dir = join(fixtureRoot, "kind");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "file.txt"), "x");

        assert.equal(pathKind(dir), "directory");
        assert.equal(pathKind(join(dir, "file.txt")), "file");
        assert.equal(pathKind(join(dir, "nope.txt")), "missing");
    });
});
