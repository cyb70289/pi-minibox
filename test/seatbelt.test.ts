import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { MACOS_SANDBOX_EXEC, buildSeatbeltCommand, buildSeatbeltProfile } from "../src/seatbelt.ts";
import { compilePolicy, type CompiledPolicy } from "../src/policy.ts";

const samplePolicy: CompiledPolicy = {
    platform: "darwin",
    projectRoot: "/proj",
    home: "/home/u",
    agentDir: "/home/u/.pi",
    configPath: "/home/u/.pi/minibox.json",
    writable: [
        { path: "/home/u/.npm", form: "dir", source: "config" },
        { path: "/home/u/.pi", form: "dir", source: "baseline" },
        { path: "/proj", form: "dir", source: "project" },
        { path: "/etc/hosts-probe", form: "file", source: "config" },
    ],
    denied: [
        { path: "/home/u/.pi/minibox.json", form: "file", source: "builtin" },
        { path: "/tmp/minibox-profiles", form: "dir", source: "builtin" },
    ],
    devices: ["/dev/null", "/dev/fd"],
    profileDir: "/tmp/minibox-profiles",
};

describe("buildSeatbeltProfile", () => {
    it("permits reads and refuses writes except where allowed", () => {
        const profile = buildSeatbeltProfile(samplePolicy);

        assert.equal(
            profile,
            [
                "(version 1)",
                "(allow default)",
                "(deny file-write*)",
                '(allow file-write* (subpath "/home/u/.npm"))',
                '(allow file-write* (subpath "/home/u/.pi"))',
                '(allow file-write* (subpath "/proj"))',
                '(allow file-write* (literal "/etc/hosts-probe"))',
                '(allow file-write* (literal "/dev/null"))',
                '(allow file-write* (literal "/dev/fd"))',
                '(deny file-write* (subpath "/tmp/minibox-profiles"))',
                '(deny file-write* (subpath "/home/u/.pi/minibox.json"))',
                "",
            ].join("\n"),
        );
    });

    it("places every rule-level deny after every allow, because Seatbelt applies the last match", () => {
        const lines = buildSeatbeltProfile(samplePolicy).split("\n");
        // The blanket `(deny file-write*)` is meant to come first; the invariant
        // that matters is that no allow is left after a rule-level deny.
        const allowIndexes = lines
            .map((line, index) => ({ line, index }))
            .filter(({ line }) => line.startsWith("(allow file-write*"))
            .map(({ index }) => index);
        const carveOutIndexes = lines
            .map((line, index) => ({ line, index }))
            .filter(({ line }) => line.startsWith("(deny file-write* (subpath"))
            .map(({ index }) => index);

        assert.ok(allowIndexes.length > 0, "the profile grants something");
        assert.ok(carveOutIndexes.length > 0, "the profile denies something");
        assert.ok(Math.max(...allowIndexes) < Math.min(...carveOutIndexes));
    });

    it("never grants a whole /dev subtree", () => {
        const profile = buildSeatbeltProfile(samplePolicy);

        assert.equal(profile.includes('(subpath "/dev")'), false);
        assert.equal(profile.includes("/dev/disk"), false);
    });

    it("escapes quotes and backslashes in a path", () => {
        const { profileDir: _dropped, ...withoutProfileDir } = samplePolicy;
        const profile = buildSeatbeltProfile({
            ...withoutProfileDir,
            writable: [{ path: '/proj/we"ird\\path', form: "dir", source: "config" }],
            denied: [],
            devices: [],
        });

        assert.ok(profile.includes(String.raw`(allow file-write* (subpath "/proj/we\"ird\\path"))`));
    });
});

describe("buildSeatbeltCommand", () => {
    it("writes the profile and wraps the target argv verbatim", () => {
        const written: Array<{ path: string; contents: string }> = [];
        const command = buildSeatbeltCommand({
            policy: samplePolicy,
            profilePath: "/tmp/probe.sb",
            execPath: "/bin/zsh",
            execArgs: ["-c", "echo hi"],
            writeProfile: (path, contents) => written.push({ path, contents }),
        });

        assert.equal(command.file, MACOS_SANDBOX_EXEC);
        assert.deepEqual(command.fileArgs, ["-f", "/tmp/probe.sb", "/bin/zsh", "-c", "echo hi"]);
        assert.equal(written.length, 1);
        assert.equal(written[0]?.path, "/tmp/probe.sb");
        assert.equal(written[0]?.contents, buildSeatbeltProfile(samplePolicy));
    });
});

describe("macOS kernel enforcement", { skip: process.platform !== "darwin" }, () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "minibox-seatbelt-")));
    const projectRoot = join(fixtureRoot, "proj");
    const profileDir = join(fixtureRoot, "profiles");
    const outsidePath = join(fixtureRoot, "outside.txt");
    const literalPath = join(fixtureRoot, "literal.txt");
    const profilePath = join(profileDir, "probe.sb");

    before(() => {
        mkdirSync(projectRoot, { recursive: true });
        mkdirSync(profileDir, { recursive: true });
        // A whitelisted entry stays inactive while it is missing, because minibox
        // never creates files itself; seed it so the rule becomes a single-file allow.
        writeFileSync(literalPath, "seed\n");

        const { policy } = compilePolicy({
            platform: "darwin",
            projectRoot,
            home: join(fixtureRoot, "home"),
            agentDir: join(fixtureRoot, "home", ".pi"),
            configPath: join(fixtureRoot, "home", ".pi", "minibox.json"),
            allowWrite: [literalPath],
            tempDirs: [],
            profileDir,
        });
        buildSeatbeltCommand({ policy, profilePath, execPath: "/bin/sh", execArgs: ["-c", "true"] });
    });

    after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

    function run(script: string) {
        return spawnSync(MACOS_SANDBOX_EXEC, ["-f", profilePath, "/bin/sh", "-c", script], { encoding: "utf-8" });
    }

    it("allows a write inside the project root", () => {
        const result = run(`echo hello > ${join(projectRoot, "inside.txt")}`);

        assert.equal(result.status, 0, result.stderr);
        assert.ok(existsSync(join(projectRoot, "inside.txt")));
    });

    it("refuses a write outside the project root and leaves nothing behind", () => {
        const result = run(`echo hello > ${outsidePath}`);

        assert.notEqual(result.status, 0);
        assert.equal(existsSync(outsidePath), false);
    });

    it("allows a whitelisted single file but not its sibling", () => {
        const sibling = join(fixtureRoot, "literal-sibling.txt");

        assert.equal(run(`echo ok > ${literalPath}`).status, 0);
        assert.notEqual(run(`echo no > ${sibling}`).status, 0);
        assert.equal(existsSync(sibling), false);
    });

    it("refuses a write into the generated profile directory", () => {
        const target = join(profileDir, "rewritten.sb");

        assert.notEqual(run(`echo x > ${target}`).status, 0);
        assert.equal(existsSync(target), false);
    });

    it("keeps reads unrestricted and /dev/null usable", () => {
        assert.equal(run("head -c 10 /etc/hosts > /dev/null").status, 0);
        assert.equal(run("echo x > /dev/null").status, 0);
    });

    it("does not grant the rest of /dev", () => {
        // Block devices are root-owned, so this proves the policy refuses the
        // path rather than proving anything about device permissions.
        assert.notEqual(run("echo x > /dev/disk0").status, 0);
    });

    it("confines a child process, not just the shell builtin that spawned it", () => {
        const target = join(projectRoot, "from-node.txt");
        // Single-quoted for the shell, double-quoted for JS: the path is data in
        // both layers, never re-tokenized by either.
        const writeJs = (path: string) => `require("fs").writeFileSync(${JSON.stringify(path)}, "x")`;

        assert.equal(run(`${process.execPath} -e '${writeJs(target)}'`).status, 0, "a node child inside the project must be allowed");
        assert.ok(existsSync(target));

        const outside = join(fixtureRoot, "from-node-outside.txt");
        assert.notEqual(run(`${process.execPath} -e '${writeJs(outside)}'`).status, 0);
        assert.equal(existsSync(outside), false);
    });
});

describe("writeFileSync is the default profile writer", () => {
    it("writes the profile to disk when no seam is supplied", () => {
        const dir = mkdtempSync(join(tmpdir(), "minibox-writer-"));
        const path = join(dir, "p.sb");
        try {
            buildSeatbeltCommand({ policy: samplePolicy, profilePath: path, execPath: "/bin/sh", execArgs: [] });
            assert.ok(existsSync(path));
            writeFileSync(join(dir, "keep"), "x");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
