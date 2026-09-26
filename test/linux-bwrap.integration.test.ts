/**
 * Linux integration: real bubblewrap children run the production argv builder
 * and prove the kernel-enforced write boundary by filesystem effects.
 *
 * This file self-skips unless `bwrap` is on PATH, so `npm test` on macOS stays
 * green while a Linux machine gets a real kernel check for free. Until someone
 * runs it there, the Linux backend is generated and unit-tested but NOT
 * kernel-verified -- see the README.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { buildBwrapArgs } from "../src/bwrap.ts";
import { compilePolicy, type CompiledPolicy } from "../src/policy.ts";
import { executableFromPath } from "../src/state.ts";

const bwrap = executableFromPath("bwrap");
const skip =
    bwrap === undefined
        ? "bubblewrap (bwrap) is not installed; this check only runs on a Linux machine that has it"
        : false;

describe("linux bubblewrap kernel enforcement", { skip }, () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "minibox-linux-")));
    const projectRoot = join(fixtureRoot, "proj");
    const home = join(fixtureRoot, "home");
    const agentDir = join(home, ".pi");
    const configPath = join(agentDir, "minibox.json");
    const cacheDir = join(home, "cache");
    const outsidePath = join(fixtureRoot, "outside.txt");
    const profileDir = join(fixtureRoot, "profiles");

    before(() => {
        mkdirSync(projectRoot, { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(cacheDir, { recursive: true });
        mkdirSync(profileDir, { recursive: true });
    });

    after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

    const { policy } = compilePolicy({
        platform: "linux",
        projectRoot,
        home,
        agentDir,
        configPath,
        allowWrite: [`${cacheDir}/`],
        denyWrite: [".env"],
        tempDirs: [],
        profileDir,
    });

    function run(script: string, compiled: CompiledPolicy = policy) {
        assert.ok(bwrap, "this suite only runs with bwrap present");
        const planned = buildBwrapArgs(bwrap, compiled, "/bin/sh", ["-c", script]);
        return spawnSync(planned.file, [...planned.fileArgs], { encoding: "utf-8" });
    }

    it("allows a write inside the project root", () => {
        const result = run(`echo hello > ${join(projectRoot, "inside.txt")}`);

        assert.equal(result.status, 0, result.stderr);
        assert.ok(existsSync(join(projectRoot, "inside.txt")));
    });

    it("refuses a write outside the writable roots and leaves nothing behind", () => {
        const result = run(`echo hello > ${outsidePath}`);

        assert.notEqual(result.status, 0);
        assert.equal(existsSync(outsidePath), false);
    });

    it("refuses a denied file inside the project root", () => {
        const result = run(`echo secret > ${join(projectRoot, ".env")}`);

        assert.notEqual(result.status, 0);
        assert.equal(existsSync(join(projectRoot, ".env")), false);
    });

    it("allows the agent directory and a configured cache directory", () => {
        assert.equal(run(`echo x > ${join(agentDir, "state.txt")}`).status, 0);
        assert.equal(run(`echo x > ${join(cacheDir, "pkg")}`).status, 0);
    });

    it("keeps reads unrestricted and /dev/null usable", () => {
        assert.equal(run("head -c 10 /etc/hosts > /dev/null").status, 0);
        assert.equal(run("echo x > /dev/null").status, 0);
    });

    it("exposes no host block device, because /dev is a fresh minimal devtmpfs", () => {
        const result = run("ls /dev | grep -E '^(sd[a-z]|nvme|vd[a-z]|mmcblk|dm-|loop)' && exit 1 || exit 0");

        assert.equal(result.status, 0, `block devices are visible inside the sandbox:\n${result.stdout}`);
    });

    it("does not let a confined process rewrite the generated profile", () => {
        const result = run(`echo pwned > ${join(profileDir, "minibox.sb")}`);

        assert.notEqual(result.status, 0);
        assert.equal(existsSync(join(profileDir, "minibox.sb")), false);
    });
});
