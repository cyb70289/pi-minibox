/**
 * Linux integration: real bubblewrap children run the production argv builder
 * and prove the kernel-enforced write boundary by filesystem effects.
 *
 * This file self-skips unless `bwrap` is on PATH, so `npm test` on macOS stays
 * green while a Linux machine gets a real kernel check for free. A `bwrap` that
 * is present but cannot create a namespace is NOT skipped: the suite fails
 * loudly with the reason and the fix, because a green skip would hide exactly
 * the environment problem this file exists to catch.
 *
 * Verified on Ubuntu 24.04 with bubblewrap 0.9.0 (kernel 6.17). The findings:
 *   * `bwrap --dev /dev` DOES provide `/dev/pts` (with `/dev/pts/ptmx` and a
 *     mounted devpts), so no extra `--dev-bind /dev/pts /dev/pts` is needed.
 *   * Nothing is created on the host for a denied or missing path: an absent
 *     deny is skipped with `--ro-bind-try`, and the policy drops missing allow
 *     entries instead of creating them.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { BWRAP_INSTALL_HINT, BWRAP_USERNS_HINT, buildBwrapArgs, probeBwrap } from "../src/bwrap.ts";
import { DEFAULT_ALLOW_DEVICES } from "../src/config.ts";
import { compilePolicy, type CompiledPolicy } from "../src/policy.ts";
import { executableFromPath } from "../src/state.ts";

const bwrap = executableFromPath("bwrap");
const cudaProbe = 'import ctypes,sys; cuda=ctypes.CDLL("libcuda.so.1"); count=ctypes.c_int(); status=cuda.cuInit(0); status=status or cuda.cuDeviceGetCount(ctypes.byref(count)); print("CUDA devices:", count.value, "status:", status); sys.exit(status != 0 or count.value < 1)';
const skip =
    bwrap === undefined
        ? `bubblewrap (bwrap) is not installed; ${BWRAP_INSTALL_HINT} to run this kernel check`
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

    // The policy is compiled from the real fixture, and an allow entry whose
    // path does not exist is intentionally inactive, so the fixture has to exist
    // before the policy is built -- not just before the tests run.
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(configPath, "{}");

    before(() => {
        // An installed bwrap is not necessarily a usable one. Fail here, once,
        // with the actionable reason, rather than as seven confusing assertion
        // failures that all say "setting up uid map: Permission denied".
        if (bwrap !== undefined) {
            const probe = probeBwrap(bwrap);
            const detail = probe.ok ? "" : probe.reason;
            assert.ok(probe.ok, `bwrap is installed at ${bwrap} but cannot create a sandbox: ${detail}\n${BWRAP_USERNS_HINT}`);
        }
    });

    after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

    const { policy } = compilePolicy({
        platform: "linux",
        projectRoot,
        home,
        agentDir,
        configPath,
        allowWrite: [`${cacheDir}/`],
        allowDevices: DEFAULT_ALLOW_DEVICES,
        tempDirs: [],
        profileDir,
    });

    function run(script: string, compiled: CompiledPolicy = policy) {
        assert.ok(bwrap, "this suite only runs with bwrap present");
        const planned = buildBwrapArgs(bwrap, compiled, "/bin/sh", ["-c", script]);
        return spawnSync(planned.file, [...planned.fileArgs], { encoding: "utf-8" });
    }

    it("can build a sandbox at all (the same probe the backend resolution uses)", () => {
        assert.ok(bwrap);
        assert.deepEqual(probeBwrap(bwrap), { ok: true });
    });

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

    it("creates no host artifacts for a protected command", () => {
        // The regression this suite exists for: minibox used to create empty
        // placeholders such as .env and .env.local in the project root.
        const dotenv = join(projectRoot, ".env");
        const dotenvLocal = join(projectRoot, ".env.local");
        const dotGit = join(projectRoot, ".git");
        for (const path of [dotenv, dotenvLocal, dotGit]) assert.equal(existsSync(path), false);

        assert.equal(run("true").status, 0);
        assert.equal(run(`echo x > ${join(projectRoot, "inside.txt")}`).status, 0);

        for (const path of [dotenv, dotenvLocal, dotGit]) {
            assert.equal(existsSync(path), false, `${path} must not be created by a sandbox launch`);
        }
    });

    it("refuses to write the minibox config file, which is an internal deny", () => {
        const result = run(`echo pwned > ${configPath}`);

        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(configPath, "utf-8"), "{}");
    });

    it("allows the agent directory and a configured cache directory", () => {
        assert.equal(run(`echo x > ${join(agentDir, "state.txt")}`).status, 0);
        assert.equal(run(`echo x > ${join(cacheDir, "pkg")}`).status, 0);
    });

    it("keeps reads unrestricted and /dev/null usable", () => {
        assert.equal(run("head -c 10 /etc/hosts > /dev/null").status, 0);
        assert.equal(run("echo x > /dev/null").status, 0);
    });

    it("provides a usable /dev/pts, so interactive shells and ptys keep working", () => {
        // `--dev /dev` builds a fresh devtmpfs; the open question was whether it
        // also mounts devpts. It does: /dev/pts/ptmx exists and devpts is
        // mounted there, so no additional `--dev-bind /dev/pts /dev/pts` is
        // needed for a working tty.
        const result = run("test -c /dev/pts/ptmx && grep -Eq '^devpts /dev/pts devpts' /proc/mounts");

        assert.equal(result.status, 0, `/dev/pts is not usable inside the sandbox:\n${result.stdout}${result.stderr}`);
    });

    it("mounts procfs and sysfs read-write for GPU runtimes", () => {
        const result = run("grep -Eq '^proc /proc proc rw,' /proc/mounts && grep -Eq '^sysfs /sys sysfs rw,' /proc/mounts && test -w /proc/self/comm");
        assert.equal(result.status, 0, result.stderr);
    });

    it("does not expose NVIDIA devices when allowDevices is empty", () => {
        const result = run("test ! -e /dev/nvidiactl && test ! -e /dev/nvidia0", { ...policy, devices: [] });
        assert.equal(result.status, 0, result.stderr);
    });

    it("lets NVIDIA tools use the GPU when the host has a working NVIDIA driver", {
        skip: (() => {
            const smi = executableFromPath("nvidia-smi");
            return smi === undefined || spawnSync(smi, ["-L"], { encoding: "utf-8" }).status !== 0
                ? "no working NVIDIA GPU on the host"
                : false;
        })(),
    }, () => {
        const result = run("nvidia-smi -L");
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /GPU [0-9]+:/);
    });

    it("initializes CUDA and sees a GPU when the host has a working CUDA driver", {
        skip: (() => {
            const python = executableFromPath("python3");
            return python === undefined || spawnSync(python, ["-c", cudaProbe], { encoding: "utf-8" }).status !== 0
                ? "no working CUDA driver and Python on the host"
                : false;
        })(),
    }, () => {
        const result = run(`python3 -c '${cudaProbe}'`);
        assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /CUDA devices: [1-9][0-9]* status: 0/);
    });

    it("exposes no host block device, because /dev is a fresh minimal device tree", () => {
        const result = run("ls /dev | grep -E '^(sd[a-z]|nvme|vd[a-z]|mmcblk|dm-|loop)' && exit 1 || exit 0");

        assert.equal(result.status, 0, `block devices are visible inside the sandbox:\n${result.stdout}`);
    });

    it("does not let a confined process rewrite the generated profile", () => {
        const result = run(`echo pwned > ${join(profileDir, "minibox.sb")}`);

        assert.notEqual(result.status, 0);
        assert.equal(existsSync(join(profileDir, "minibox.sb")), false);
    });
});
