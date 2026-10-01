import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalizePath } from "../src/paths.ts";
import {
    baselineDirectories,
    compilePolicy,
    describeUnsafeProjectRoot,
    evaluateWriteAccess,
    MACOS_DEVICE_ALLOWLIST,
    normalizeEntries,
    type CompiledPolicy,
    type CompilePolicyInput,
} from "../src/policy.ts";

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "minibox-policy-")));
const projectRoot = join(fixtureRoot, "proj");
const home = join(fixtureRoot, "home");
const agentDir = join(home, ".pi");
const configPath = join(agentDir, "minibox.json");

before(() => {
    mkdirSync(join(projectRoot, "existing"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
});

after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const baseInput = { platform: "darwin", projectRoot, home, agentDir, configPath, allowWrite: [] };

/**
 * Most tests isolate themselves from the real temp tree: the fixture lives under
 * `$TMPDIR`, which is a writable baseline, and a fixture rule that is absorbed by
 * that baseline would test nothing.
 */
function compile(overrides: Partial<CompilePolicyInput> = {}) {
    return compilePolicy({ ...baseInput, tempDirs: [], ...overrides });
}

/** The same policy with the real platform temp directories in place. */
function compileWithTempDirs(overrides: Partial<CompilePolicyInput> = {}) {
    return compilePolicy({ ...baseInput, ...overrides });
}

function policyPaths(policy: CompiledPolicy): string[] {
    return policy.writable.map((entry) => `${entry.path}:${entry.form}`).sort();
}

describe("compilePolicy baselines", () => {
    it("always writes the project root and the agent directory", () => {
        const { policy } = compile();

        assert.deepEqual(policyPaths(policy), [`${agentDir}:dir`, `${projectRoot}:dir`]);
    });

    it("adds the platform temp directories by default", () => {
        const { policy } = compileWithTempDirs();
        const baselines = policy.writable.filter((entry) => entry.source === "baseline").map((entry) => entry.path);

        for (const path of baselineDirectories("darwin")) {
            assert.ok(baselines.includes(canonicalizePath(path)), `missing ${path}`);
        }
        assert.ok(baselines.includes(projectRoot) === false, "the project root is not a baseline entry");
    });

    it("adds the Linux temp directories when asked for the Linux baseline", () => {
        const { policy } = compileWithTempDirs({ platform: "linux" });
        const baselines = policy.writable.filter((entry) => entry.source === "baseline").map((entry) => entry.path);

        for (const path of baselineDirectories("linux")) {
            assert.ok(baselines.includes(canonicalizePath(path)), `missing ${path}`);
        }
    });

    it("hardcodes writable procfs and sysfs on Linux even when temp baselines are overridden", () => {
        const { policy } = compile({ platform: "linux" });
        for (const path of ["/proc", "/sys"]) {
            assert.ok(policy.writable.some((entry) => entry.path === path && entry.form === "dir" && entry.source === "baseline"));
            assert.equal(evaluateWriteAccess(`${path}/some-file`, policy).allowed, true);
        }
    });

    it("allows the macOS character devices and no devices elsewhere", () => {
        assert.deepEqual(compile().policy.devices, [...MACOS_DEVICE_ALLOWLIST]);
        assert.deepEqual(compile({ platform: "linux" }).policy.devices, []);
    });

    it("denies the config file itself as a built-in rule", () => {
        const { policy } = compile();

        assert.deepEqual(
            policy.denied.map((entry) => [entry.path, entry.source]),
            [[configPath, "builtin"]],
        );
    });
});

describe("allowDevices", () => {
    it("binds only explicit, existing character devices on Linux", () => {
        const { policy, problems } = compile({
            platform: "linux",
            allowDevices: ["/dev/zero", "/dev/null", "/dev/null"],
        });
        assert.deepEqual(problems, []);
        assert.deepEqual(policy.devices, ["/dev/null", "/dev/zero"]);
        assert.equal(evaluateWriteAccess("/dev/null", policy).allowed, true);
        assert.equal(evaluateWriteAccess("/dev/random", policy).allowed, false);
    });

    it("expands a trailing wildcard to matching character devices only", () => {
        const { policy, problems } = compile({
            platform: "linux",
            allowDevices: ["/dev/nul*", "/dev/ze*", "/dev/std*", "/dev/dri/*"],
        });
        assert.deepEqual(problems, []);
        assert.ok(policy.devices.includes("/dev/null"));
        assert.ok(policy.devices.includes("/dev/zero"));
        assert.equal(policy.devices.some((path) => path.startsWith("/dev/std")), false, "symlinks must not be bound");
        assert.equal(policy.devices.some((path) => path === "/dev/dri"), false, "directories must not be bound");
    });

    it("rejects unsupported patterns, non-dev paths, directories and symlinks; missing nodes are inactive", () => {
        const { policy, problems, notes } = compile({
            platform: "linux",
            allowDevices: ["dev/null", "/etc/hosts", "/dev/", "/dev/*", "/dev/fd", "/dev/minibox-no-such-device", "/dev/nvi*dia"],
        });
        assert.deepEqual(policy.devices, []);
        assert.equal(problems.length, 6, problems.join("; "));
        assert.ok(problems.some((problem) => /symlink/.test(problem)));
        assert.ok(notes.some((note) => /minibox-no-such-device.*not available/.test(note)));
    });

    it("rejects regular files and device aliases even when their target is a character device", {
        skip: !existsSync("/dev/shm") || process.platform !== "linux",
    }, () => {
        const devFixture = mkdtempSync("/dev/shm/minibox-policy-device-");
        try {
            const regular = join(devFixture, "regular");
            const alias = join(devFixture, "alias");
            writeFileSync(regular, "not a device");
            symlinkSync("/dev/null", alias);
            const { policy, problems } = compile({ platform: "linux", allowDevices: [regular, alias, `${devFixture}/*`] });
            assert.deepEqual(policy.devices, []);
            assert.ok(problems.some((problem) => /not a character device/.test(problem)));
            assert.ok(problems.some((problem) => /symlink/.test(problem)));
        } finally {
            rmSync(devFixture, { recursive: true, force: true });
        }
    });

    it("refuses Linux allowWrite rules under /dev so only allowDevices can bind host devices", () => {
        const { policy, problems } = compile({
            platform: "linux",
            allowWrite: ["/dev", "/dev/null", "/dev/dri/"],
        });
        assert.equal(problems.length, 3);
        assert.ok(problems.every((problem) => /use allowDevices/.test(problem)));
        assert.equal(policy.writable.some((entry) => entry.path === "/dev" || entry.path.startsWith("/dev/")), false);
    });

    it("ignores Linux device defaults on macOS without a startup notice", () => {
        const { policy, notes } = compile({ allowDevices: ["/dev/nvidia*", "/dev/dri/*"] });
        assert.deepEqual(policy.devices, [...MACOS_DEVICE_ALLOWLIST]);
        assert.deepEqual(notes, []);
    });
});

describe("compilePolicy entries", () => {
    it("resolves tilde, relative, and absolute entries", () => {
        const tilde = join(home, "out");
        const relative = join(fixtureRoot, "sibling", "out");
        const absolute = join(fixtureRoot, "absolute-out");
        for (const dir of [tilde, relative, absolute]) mkdirSync(dir, { recursive: true });

        const { policy } = compile({ allowWrite: ["~/out/", "../sibling/out/", absolute] });
        const paths = policy.writable.map((entry) => `${entry.path}:${entry.form}`);

        assert.ok(paths.includes(`${tilde}:dir`));
        assert.ok(paths.includes(`${relative}:dir`));
        assert.ok(paths.includes(`${canonicalizePath(absolute)}:dir`));
    });

    it("treats an existing directory as a subtree even without a marker", () => {
        mkdirSync(join(fixtureRoot, "shared-existing"), { recursive: true });
        const { policy } = compile({ allowWrite: ["../shared-existing"] });

        assert.ok(
            policy.writable.some(
                (entry) => entry.path === join(fixtureRoot, "shared-existing") && entry.form === "dir",
            ),
        );
    });

    it("treats an existing file without a marker as a single file", () => {
        const file = join(home, "new-file.txt");
        writeFileSync(file, "x");

        const { policy } = compile({ allowWrite: ["~/new-file.txt"] });

        assert.ok(policy.writable.some((entry) => entry.path === file && entry.form === "file"));
    });

    it("leaves a missing entry inactive and says so instead of creating it", () => {
        const missing = join(home, "never-made");

        const { policy, notes } = compile({ allowWrite: ["~/never-made/"] });

        assert.equal(existsSync(missing), false, "minibox must not create the entry");
        assert.equal(policy.writable.some((entry) => entry.path === missing), false);
        assert.ok(notes.some((note) => /does not exist yet/.test(note)), notes.join("; "));
    });

    it("normalizes a trailing subtree marker to the directory form", () => {
        const build = join(home, "build");
        mkdirSync(build, { recursive: true });

        const { policy } = compile({ allowWrite: ["~/build/**"] });

        assert.ok(policy.writable.some((entry) => entry.path === build && entry.form === "dir"));
    });

    it("drops an entry that is already inside the project root", () => {
        mkdirSync(join(projectRoot, "build"), { recursive: true });
        const { policy } = compile({ allowWrite: ["build/**"] });

        assert.equal(policy.writable.some((entry) => entry.source === "config"), false);
    });

    it("rejects patterns instead of accepting them on one platform only", () => {
        const { policy, problems } = compile({ allowWrite: ["*.log", "a/**/b", "q?x", "s[a]"] });

        assert.equal(problems.length, 4);
        for (const problem of problems) assert.match(problem, /concrete paths only/);
        assert.equal(policy.writable.length, 2, "only the project and agent baselines remain");
    });

    it("refuses an allow entry that resolves to the filesystem root", () => {
        const { problems, policy } = compile({ allowWrite: ["/"] });

        assert.match(problems[0] ?? "", /filesystem root/);
        assert.equal(policy.writable.some((entry) => entry.path === projectRoot && entry.source === "config"), false);
    });

    it("notes an entry that swallows the home directory", () => {
        const { notes } = compile({ allowWrite: ["~/"] });

        assert.match(notes[0] ?? "", /covers the home directory/);
    });

    it("records session grants separately", () => {
        const grantedPath = join(fixtureRoot, "granted.txt");
        writeFileSync(grantedPath, "x");

        const { policy } = compile({ sessionPaths: [grantedPath] });

        const granted = policy.writable.find((entry) => entry.path === canonicalizePath(grantedPath));
        assert.equal(granted?.source, "session");
        assert.equal(granted?.template, grantedPath);
    });

    it("denies the profile directory when the controller supplies one", () => {
        const profileDir = join(fixtureRoot, "profiles");
        const { policy } = compile({ profileDir });

        assert.equal(policy.profileDir, canonicalizePath(profileDir));
        assert.ok(
            policy.denied.some(
                (entry) => entry.path === canonicalizePath(profileDir) && entry.source === "builtin",
            ),
        );
    });
});

describe("normalizeEntries", () => {
    it("keeps the broader form of a duplicated path", () => {
        const normalized = normalizeEntries([
            { path: "/a", form: "file", source: "config" },
            { path: "/a", form: "dir", source: "config" },
        ]);

        assert.deepEqual(normalized, [{ path: "/a", form: "dir", source: "config" }]);
    });

    it("absorbs rules covered by a directory rule", () => {
        const normalized = normalizeEntries([
            { path: "/a", form: "dir", source: "config" },
            { path: "/a/b", form: "dir", source: "config" },
            { path: "/a/b/c.txt", form: "file", source: "config" },
        ]);

        assert.deepEqual(normalized, [{ path: "/a", form: "dir", source: "config" }]);
    });

    it("keeps two rules that do not contain each other", () => {
        const normalized = normalizeEntries([
            { path: "/a", form: "dir", source: "config" },
            { path: "/a-sibling", form: "dir", source: "config" },
        ]);

        assert.deepEqual(normalized.map((entry) => entry.path), ["/a", "/a-sibling"]);
    });
});

describe("evaluateWriteAccess", () => {
    it("allows paths inside the project and refuses paths outside it", () => {
        const { policy } = compile();

        assert.equal(evaluateWriteAccess(join(projectRoot, "a", "b.txt"), policy).allowed, true);
        const outside = evaluateWriteAccess("/etc/minibox-probe.txt", policy);
        assert.equal(outside.allowed, false);
        assert.equal(outside.allowed === false ? outside.reason : "", "outside-writable");
    });

    it("refuses the config file and the generated profile directory", () => {
        const profileDir = join(fixtureRoot, "profiles");
        const { policy } = compile({ profileDir });

        assert.equal(evaluateWriteAccess(configPath, policy).allowed, false);
        assert.equal(evaluateWriteAccess(join(profileDir, "x.sb"), policy).allowed, false);
    });

    it("allows the macOS character devices without allowing other devices", () => {
        const { policy } = compile();

        assert.equal(evaluateWriteAccess("/dev/null", policy).allowed, true);
        assert.equal(evaluateWriteAccess("/dev/disk0", policy).allowed, false);
    });

    it("decides on the canonical path, so a symlinked spelling cannot widen anything", () => {
        // macOS spells its temp tree `/tmp` while the kernel sees `/private/tmp`,
        // so the spelling and the canonical path differ there. Use each
        // platform's own temp baseline; the assertion that matters is that the
        // decision was made on the canonical path.
        const platform = process.platform === "linux" ? "linux" : "darwin";
        const spelling = "/tmp/minibox-probe.txt";
        const { policy } = compileWithTempDirs({ platform });
        const decision = evaluateWriteAccess(spelling, policy);

        assert.equal(decision.path, canonicalizePath(spelling));
        assert.equal(decision.allowed, true);
    });
});

describe("describeUnsafeProjectRoot", () => {
    it("refuses the filesystem root and the home directory", () => {
        assert.match(describeUnsafeProjectRoot("/", home) ?? "", /protect nothing/);
        assert.match(describeUnsafeProjectRoot(home, home) ?? "", /protect nothing/);
    });

    it("accepts an ordinary project directory", () => {
        assert.equal(describeUnsafeProjectRoot(projectRoot, home), undefined);
    });

    it("names the root it refuses", () => {
        assert.ok((describeUnsafeProjectRoot(home, home) ?? "").includes(home));
    });
});
