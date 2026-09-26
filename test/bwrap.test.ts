import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { BWRAP_PROBE_ARGS, buildBwrapArgs, isUserNamespaceFailure, materializeDenyPath, probeBwrap } from "../src/bwrap.ts";
import type { CompiledPolicy } from "../src/policy.ts";

const policy: CompiledPolicy = {
    platform: "linux",
    projectRoot: "/proj",
    home: "/home/u",
    agentDir: "/home/u/.pi",
    configPath: "/home/u/.pi/minibox.json",
    writable: [
        { path: "/home/u/.npm", form: "dir", source: "config" },
        { path: "/proj", form: "dir", source: "project" },
        { path: "/var/empty-root", form: "dir", source: "baseline" },
        { path: "/proj/service.conf", form: "file", source: "session" },
        { path: "/proj/missing.conf", form: "file", source: "session" },
    ],
    denied: [
        { path: "/home/u/.pi/minibox.json", form: "file", source: "builtin" },
        { path: "/proj/.env", form: "file", source: "config" },
    ],
    devices: [],
    profileDir: "/proj/profiles",
};

const existing = new Set([
    "/home/u/.npm",
    "/proj",
    "/proj/service.conf",
    "/home/u/.pi/minibox.json",
]);
const materialized: string[] = [];

function plan(overrides: Partial<CompiledPolicy> = {}) {
    materialized.length = 0;
    return buildBwrapArgs("/usr/bin/bwrap", { ...policy, ...overrides }, "/bin/bash", ["-c", "echo hi"], {
        exists: (path) => existing.has(path),
        materializeDenyPath: (path) => {
            materialized.push(path);
            return true;
        },
    });
}

describe("buildBwrapArgs", () => {
    it("starts from a read-only root and a fresh device tree", () => {
        const { file, fileArgs } = plan();

        assert.equal(file, "/usr/bin/bwrap");
        assert.deepEqual(fileArgs.slice(0, 5), ["--ro-bind", "/", "/", "--dev", "/dev"]);
    });

    it("never isolates the network, because minibox only controls writes", () => {
        const { fileArgs } = plan();

        assert.equal(fileArgs.includes("--unshare-net"), false);
        assert.equal(fileArgs.includes("--unshare-all"), false);
    });

    it("binds each writable root read-write", () => {
        const { fileArgs } = plan();

        assert.ok(fileArgs.join(" ").includes("--bind /proj /proj"));
        assert.ok(fileArgs.join(" ").includes("--bind /home/u/.npm /home/u/.npm"));
        assert.ok(fileArgs.join(" ").includes("--bind /proj/service.conf /proj/service.conf"));
    });

    it("falls back to --bind-try for a missing writable directory and reports a missing writable file", () => {
        const result = plan();

        assert.ok(result.fileArgs.join(" ").includes("--bind-try /var/empty-root /var/empty-root"));
        assert.deepEqual(result.inactiveWritablePaths, ["/proj/missing.conf"]);
        assert.equal(result.fileArgs.includes("/proj/missing.conf"), false);
    });

    it("mounts denies after every writable bind so they win", () => {
        const { fileArgs } = plan();
        const lastBind = fileArgs.findLastIndex((arg) => arg === "--bind" || arg === "--bind-try");
        const firstDeny = fileArgs.findIndex(
            (arg, index) => index >= 4 && (arg === "--ro-bind" || arg === "--ro-bind-try"),
        );

        assert.ok(lastBind < firstDeny, `last bind at ${lastBind} must precede first deny at ${firstDeny}`);
    });

    it("materializes an absent denied path inside a writable region so it can be denied", () => {
        const result = plan();

        assert.deepEqual(materialized, ["/proj/.env"]);
        assert.ok(result.fileArgs.join(" ").includes("--ro-bind /proj/.env /proj/.env"));
    });

    it("uses --ro-bind-try for a denied path it cannot create, instead of inventing one", () => {
        const result = buildBwrapArgs("/usr/bin/bwrap", policy, "/bin/bash", [], {
            exists: (path) => existing.has(path),
            materializeDenyPath: () => false,
        });

        assert.ok(result.fileArgs.join(" ").includes("--ro-bind-try /proj/.env /proj/.env"));
    });

    it("denies the generated profile directory", () => {
        const { fileArgs } = plan();

        assert.ok(fileArgs.join(" ").includes("--ro-bind-try /proj/profiles /proj/profiles"));
    });

    it("puts the target command after the option terminator", () => {
        const { fileArgs } = plan();

        assert.deepEqual(fileArgs.slice(-4), ["--", "/bin/bash", "-c", "echo hi"]);
    });
});

describe("probeBwrap", () => {
    it("probes with the same sandbox shape a real launch uses", () => {
        assert.deepEqual(BWRAP_PROBE_ARGS.slice(0, 5), ["--ro-bind", "/", "/", "--dev", "/dev"]);
        assert.deepEqual(BWRAP_PROBE_ARGS.slice(-3), ["/bin/sh", "-c", "exit 0"]);
        assert.ok(BWRAP_PROBE_ARGS.includes("--"));
    });

    it("reports success when the probe process exits cleanly", () => {
        assert.deepEqual(probeBwrap("/bin/true"), { ok: true });
    });

    it("reports the exit status when the probe fails without stderr", () => {
        const probe = probeBwrap("/bin/false");

        assert.equal(probe.ok, false);
        assert.match(probe.ok === false ? probe.reason : "", /status 1/);
    });

    it("reports a missing executable instead of throwing", () => {
        const probe = probeBwrap("/definitely/not/here");

        assert.equal(probe.ok, false);
        assert.match(probe.ok === false ? probe.reason : "", /ENOENT|no such file/i);
    });
});

describe("isUserNamespaceFailure", () => {
    it("recognizes the AppArmor denial Ubuntu 24.04 produces", () => {
        assert.equal(isUserNamespaceFailure("bwrap: setting up uid map: Permission denied"), true);
        assert.equal(isUserNamespaceFailure("bwrap: Creating new namespace failed: Operation not permitted"), true);
    });

    it("does not blame an unrelated failure on user namespaces", () => {
        assert.equal(isUserNamespaceFailure("bwrap: execvp /bin/sh: No such file or directory"), false);
    });
});

describe("materializeDenyPath", () => {
    const root = mkdtempSync(join(tmpdir(), "minibox-bwrap-"));

    after(() => rmSync(root, { recursive: true, force: true }));

    it("creates an empty file for an absent denied path", () => {
        const target = join(root, "nested", ".env");

        assert.equal(materializeDenyPath(target), true);
        assert.equal(readFileSync(target, "utf-8"), "");
    });

    it("leaves an existing file alone", () => {
        const target = join(root, "existing.env");
        writeFileSync(target, "secret");

        assert.equal(materializeDenyPath(target), true);
        assert.equal(readFileSync(target, "utf-8"), "secret");
    });

    it("reports failure when the path cannot be created", () => {
        const blocker = join(root, "blocker");
        writeFileSync(blocker, "not a directory");

        assert.equal(materializeDenyPath(join(blocker, "child")), false);
        assert.equal(existsSync(join(blocker, "child")), false);
    });
});
