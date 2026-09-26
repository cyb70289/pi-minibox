import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

const baseInput = { platform: "darwin", projectRoot, home, agentDir, configPath, allowWrite: [], denyWrite: [] };

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

describe("compilePolicy entries", () => {
    it("resolves tilde, relative, and absolute entries", () => {
        const { policy } = compile({ allowWrite: ["~/out/", "../sibling/out/", "/var/out/"] });
        const paths = policy.writable.map((entry) => `${entry.path}:${entry.form}`);

        assert.ok(paths.includes(`${join(home, "out")}:dir`));
        assert.ok(paths.includes(`${join(fixtureRoot, "sibling", "out")}:dir`));
        assert.ok(paths.includes(`${canonicalizePath("/var/out")}:dir`));
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

    it("treats a missing entry without a marker as a single file", () => {
        const { policy } = compile({ allowWrite: ["~/new-file.txt"] });

        assert.ok(policy.writable.some((entry) => entry.path === join(home, "new-file.txt") && entry.form === "file"));
    });

    it("normalizes a trailing subtree marker to the directory form", () => {
        const { policy } = compile({ allowWrite: ["~/build/**"] });

        assert.ok(policy.writable.some((entry) => entry.path === join(home, "build") && entry.form === "dir"));
    });

    it("drops an entry that is already inside the project root", () => {
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
        const { policy } = compile({ sessionPaths: ["/var/granted.txt"] });

        const granted = policy.writable.find((entry) => entry.path === canonicalizePath("/var/granted.txt"));
        assert.equal(granted?.source, "session");
        assert.equal(granted?.template, "/var/granted.txt");
    });

    it("denies the profile directory when the controller supplies one", () => {
        const profileDir = join(fixtureRoot, "profiles");
        const { policy } = compile({ profileDir });

        assert.equal(policy.profileDir, canonicalizePath(profileDir));
    });
});

describe("compilePolicy deny rules", () => {
    it("rejects a deny rule that contains the project root", () => {
        for (const template of [".", "..", projectRoot]) {
            const { problems } = compile({ denyWrite: [template] });
            assert.match(problems[0] ?? "", /would deny every write in it/, `template ${template}`);
        }
    });

    it("keeps a narrower deny rule beside a broader allow rule", () => {
        const { policy } = compile({ allowWrite: [fixtureRoot], denyWrite: ["existing/secret.txt"] });

        assert.equal(evaluateWriteAccess(join(projectRoot, "existing", "ok.txt"), policy).allowed, true);
        assert.equal(evaluateWriteAccess(join(projectRoot, "existing", "secret.txt"), policy).allowed, false);
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

    it("lets a deny rule beat the project root", () => {
        const { policy } = compile({ denyWrite: [".env"] });

        const decision = evaluateWriteAccess(join(projectRoot, ".env"), policy);
        assert.equal(decision.allowed, false);
        assert.equal(decision.allowed === false ? decision.reason : "", "denied");
        assert.equal(decision.allowed === false ? decision.deniedBy : "", join(projectRoot, ".env"));
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
        const { policy } = compileWithTempDirs();
        const decision = evaluateWriteAccess("/tmp/minibox-probe.txt", policy);

        assert.equal(decision.path, canonicalizePath("/tmp/minibox-probe.txt"));
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
