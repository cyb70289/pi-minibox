import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { BWRAP_PROBE_ARGS, buildBwrapArgs, isUserNamespaceFailure, probeBwrap } from "../src/bwrap.ts";
import type { CompiledPolicy } from "../src/policy.ts";

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "minibox-bwrap-")));
const projectRoot = join(fixtureRoot, "proj");
const home = join(fixtureRoot, "home");
const agentDir = join(home, ".pi");
const configPath = join(agentDir, "minibox.json");
const cacheDir = join(home, ".npm");
const serviceConf = join(projectRoot, "service.conf");
const missingConf = join(projectRoot, "missing.conf");
const emptyRoot = join(fixtureRoot, "empty-root");
const profileDir = join(fixtureRoot, "profiles");

before(() => {
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(serviceConf, "x");
    writeFileSync(configPath, "{}");
});

after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const policy: CompiledPolicy = {
    platform: "linux",
    projectRoot,
    home,
    agentDir,
    configPath,
    writable: [
        { path: "/proc", form: "dir", source: "baseline" },
        { path: "/sys", form: "dir", source: "baseline" },
        { path: cacheDir, form: "dir", source: "config" },
        { path: projectRoot, form: "dir", source: "project" },
        { path: emptyRoot, form: "dir", source: "baseline" },
        { path: serviceConf, form: "file", source: "session" },
        { path: missingConf, form: "file", source: "session" },
    ],
    denied: [
        { path: configPath, form: "file", source: "builtin" },
        { path: profileDir, form: "dir", source: "builtin" },
    ],
    devices: [],
    profileDir,
};

function plan(overrides: Partial<CompiledPolicy> = {}) {
    return buildBwrapArgs("/usr/bin/bwrap", { ...policy, ...overrides }, "/bin/bash", ["-c", "echo hi"]);
}

describe("buildBwrapArgs", () => {
    it("starts from a read-only root and a fresh device tree", () => {
        const { file, fileArgs } = plan();

        assert.equal(file, "/usr/bin/bwrap");
        assert.deepEqual(fileArgs.slice(0, 5), ["--ro-bind", "/", "/", "--dev", "/dev"]);
    });

    it("binds procfs and sysfs read-write without making the root writable", () => {
        const { fileArgs } = plan();
        assert.deepEqual(fileArgs.slice(0, 5), ["--ro-bind", "/", "/", "--dev", "/dev"]);
        assert.ok(fileArgs.join(" ").includes("--bind /proc /proc"));
        assert.ok(fileArgs.join(" ").includes("--bind /sys /sys"));
    });

    it("mounts only configured devices into the private /dev", () => {
        const unconfigured = plan();
        assert.equal(unconfigured.fileArgs.includes("--dev-bind-try"), false);

        const { fileArgs } = plan({ devices: ["/dev/null", "/dev/zero"] });
        const binds = fileArgs.flatMap((arg, index) => arg === "--dev-bind-try" ? [fileArgs.slice(index, index + 3)] : []);
        assert.deepEqual(binds, [
            ["--dev-bind-try", "/dev/null", "/dev/null"],
            ["--dev-bind-try", "/dev/zero", "/dev/zero"],
        ]);
        assert.equal(fileArgs.join(" ").includes("--bind /dev /dev"), false);
    });

    it("never isolates the network, because minibox only controls writes", () => {
        const { fileArgs } = plan();

        assert.equal(fileArgs.includes("--unshare-net"), false);
        assert.equal(fileArgs.includes("--unshare-all"), false);
    });

    it("binds each writable root read-write", () => {
        const { fileArgs } = plan();

        assert.ok(fileArgs.join(" ").includes(`--bind ${projectRoot} ${projectRoot}`));
        assert.ok(fileArgs.join(" ").includes(`--bind ${cacheDir} ${cacheDir}`));
        assert.ok(fileArgs.join(" ").includes(`--bind ${serviceConf} ${serviceConf}`));
    });

    it("falls back to --bind-try for a missing writable directory and skips a missing writable file", () => {
        const { fileArgs } = plan();

        assert.ok(fileArgs.join(" ").includes(`--bind-try ${emptyRoot} ${emptyRoot}`));
        assert.equal(fileArgs.includes(missingConf), false);
    });

    it("mounts denies after every writable bind so they win", () => {
        const { fileArgs } = plan();
        const lastBind = fileArgs.findLastIndex((arg) => arg === "--bind" || arg === "--bind-try");
        const firstDeny = fileArgs.findIndex(
            (arg, index) => index >= 4 && (arg === "--ro-bind" || arg === "--ro-bind-try"),
        );

        assert.ok(lastBind < firstDeny, `last bind at ${lastBind} must precede first deny at ${firstDeny}`);
    });

    it("binds an existing deny read-only and leaves an absent one to --ro-bind-try", () => {
        const absentDeny = join(projectRoot, ".env");
        const { fileArgs } = plan({
            denied: [
                ...policy.denied,
                { path: absentDeny, form: "file", source: "builtin" },
            ],
        });

        assert.ok(fileArgs.join(" ").includes(`--ro-bind ${configPath} ${configPath}`));
        assert.ok(fileArgs.join(" ").includes(`--ro-bind-try ${profileDir} ${profileDir}`));
        assert.ok(fileArgs.join(" ").includes(`--ro-bind-try ${absentDeny} ${absentDeny}`));
    });

    it("creates nothing on the host, not even for an absent deny path", () => {
        const absentDeny = join(projectRoot, ".env");

        plan({
            denied: [
                ...policy.denied,
                { path: absentDeny, form: "file", source: "builtin" },
            ],
        });

        assert.equal(existsSync(absentDeny), false, "a deny mount point must never be materialized");
        assert.equal(existsSync(missingConf), false, "a missing writable file is not created");
        assert.equal(existsSync(emptyRoot), false, "a missing writable directory is not created");
        assert.equal(existsSync(profileDir), false, "a missing deny directory is not created");
    });

    it("denies the generated profile directory", () => {
        const { fileArgs } = plan();

        assert.ok(fileArgs.join(" ").includes(`--ro-bind-try ${profileDir} ${profileDir}`));
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
        assert.deepEqual(probeBwrap("/usr/bin/true"), { ok: true });
    });

    it("reports the exit status when the probe fails without stderr", () => {
        const probe = probeBwrap("/usr/bin/false");

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

describe("no host mutation", () => {
    it("reads the config file without writing to it", () => {
        writeFileSync(configPath, '{"version":1}');
        plan();

        assert.equal(readFileSync(configPath, "utf-8"), '{"version":1}');
    });
});
