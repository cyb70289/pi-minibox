import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalizePath } from "../src/paths.ts";
import { MiniboxController, MiniboxBlockedError, describeBackendSupport, executableFromPath } from "../src/state.ts";
import type { LoadedMiniboxConfig } from "../src/config.ts";

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "minibox-state-")));
const projectRoot = join(fixtureRoot, "proj");
const home = join(fixtureRoot, "home");
const agentDir = join(home, ".pi");
const configPath = join(agentDir, "minibox.json");
const profileDir = join(fixtureRoot, "profiles");

before(() => {
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
});

after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function loaded(overrides: Partial<LoadedMiniboxConfig["config"]> = {}): LoadedMiniboxConfig {
    return {
        config: { version: 1, enabled: true, allowWrite: [], denyWrite: [".env"], ...overrides },
        problems: [],
        notes: [],
        seeded: false,
        malformed: false,
    };
}

function controller(overrides: Partial<ConstructorParameters<typeof MiniboxController>[0]> = {}) {
    return new MiniboxController({
        platform: () => "darwin",
        isExecutable: () => true,
        home: () => home,
        tempDirs: [],
        createProfileDir: () => {
            mkdirSync(profileDir, { recursive: true });
            return profileDir;
        },
        ...overrides,
    });
}

function session(instance: MiniboxController, cwd = projectRoot, config = loaded()) {
    instance.applyConfig(configPath, config);
    return instance.beginSession({ cwd, agentDir, configPath });
}

describe("describeBackendSupport", () => {
    it("selects Seatbelt on macOS when sandbox-exec is executable", () => {
        assert.deepEqual(describeBackendSupport({ platform: () => "darwin", isExecutable: () => true }), {
            supported: true,
            platform: "darwin",
            backend: "macos-seatbelt",
            executable: "/usr/bin/sandbox-exec",
        });
    });

    it("reports macOS as unavailable when sandbox-exec is missing", () => {
        const support = describeBackendSupport({ platform: () => "darwin", isExecutable: () => false });

        assert.equal(support.supported, false);
        assert.match(support.supported === false ? support.reason : "", /sandbox-exec/);
    });

    it("selects bubblewrap on Linux when bwrap resolves from PATH and can build a sandbox", () => {
        assert.deepEqual(
            describeBackendSupport({
                platform: () => "linux",
                lookupExecutable: () => "/usr/bin/bwrap",
                probeBwrap: () => ({ ok: true }),
            }),
            {
                supported: true,
                platform: "linux",
                backend: "linux-bubblewrap",
                executable: "/usr/bin/bwrap",
            },
        );
    });

    it("reports Linux as unavailable without bubblewrap", () => {
        const support = describeBackendSupport({ platform: () => "linux", lookupExecutable: () => undefined });

        assert.equal(support.supported, false);
        assert.match(support.supported === false ? support.reason : "", /bubblewrap/);
        assert.match(support.supported === false ? support.reason : "", /apt install bubblewrap/);
    });

    it("reports Linux as unavailable when bwrap exists but the kernel refuses a user namespace", () => {
        const support = describeBackendSupport({
            platform: () => "linux",
            lookupExecutable: () => "/usr/bin/bwrap",
            probeBwrap: () => ({ ok: false, reason: "bwrap: setting up uid map: Permission denied" }),
        });

        assert.equal(support.supported, false);
        const reason = support.supported === false ? support.reason : "";
        assert.match(reason, /cannot create a sandbox/);
        assert.match(reason, /setting up uid map/);
        assert.match(reason, /apparmor_restrict_unprivileged_userns/);
    });

    it("reports a non-namespace bwrap failure without the AppArmor advice", () => {
        const support = describeBackendSupport({
            platform: () => "linux",
            lookupExecutable: () => "/usr/bin/bwrap",
            probeBwrap: () => ({ ok: false, reason: "bwrap: execvp /bin/sh: No such file or directory" }),
        });

        const reason = support.supported === false ? support.reason : "";
        assert.match(reason, /execvp/);
        assert.doesNotMatch(reason, /apparmor_restrict_unprivileged_userns/);
    });

    it("reports an unsupported platform", () => {
        const support = describeBackendSupport({ platform: () => "win32" });

        assert.equal(support.supported, false);
        assert.match(support.supported === false ? support.reason : "", /win32/);
    });
});

describe("executableFromPath", () => {
    it("finds an executable on the supplied PATH", () => {
        assert.equal(executableFromPath("sh", "/bin"), "/bin/sh");
    });

    it("returns undefined when nothing matches", () => {
        assert.equal(executableFromPath("definitely-not-a-real-binary", "/usr/bin"), undefined);
        assert.equal(executableFromPath("sh", ""), undefined);
    });
});

describe("MiniboxController", () => {
    it("fails closed before any session has started", () => {
        const instance = controller();

        assert.equal(instance.status().state, "failed");
        assert.throws(() => instance.requireLaunchPlan(), MiniboxBlockedError);
    });

    it("is inactive when the persisted default is off, and enabled on demand", () => {
        const instance = controller();
        session(instance, projectRoot, loaded({ enabled: false }));

        assert.equal(instance.status().state, "inactive");
        assert.deepEqual(instance.requireLaunchPlan(), { confined: false });

        assert.equal(instance.enable().state, "enabled");
        assert.equal(instance.requireLaunchPlan().confined, true);
    });

    it("reports disabled after an explicit session opt-out, without persisting it", () => {
        const instance = controller();
        session(instance);

        instance.disable();
        const status = instance.status();
        assert.equal(status.state, "disabled");
        assert.equal(status.enabledByDefault, true);
        assert.deepEqual(instance.requireLaunchPlan(), { confined: false });
    });

    it("refuses the home directory as a project root", () => {
        const instance = controller();
        const status = session(instance, home);

        assert.equal(status.state, "failed");
        assert.match(status.reason, /protect nothing/);
        assert.throws(() => instance.requireLaunchPlan(), MiniboxBlockedError);
    });

    it("reports unavailable when the platform has no backend", () => {
        const instance = controller({ platform: () => "linux", lookupExecutable: () => undefined });
        const status = session(instance);

        assert.equal(status.state, "unavailable");
        assert.throws(() => instance.requireLaunchPlan(), MiniboxBlockedError);
    });

    it("probes an installed bwrap once and caches the answer across status calls", () => {
        let calls = 0;
        const instance = controller({
            platform: () => "linux",
            lookupExecutable: () => "/usr/bin/bwrap",
            probeBwrap: () => {
                calls += 1;
                return { ok: true };
            },
        });

        assert.equal(session(instance).state, "enabled");
        instance.status();
        instance.requireLaunchPlan();

        assert.equal(calls, 1);
    });

    it("blocks instead of reporting enabled when the bwrap probe fails", () => {
        const instance = controller({
            platform: () => "linux",
            lookupExecutable: () => "/usr/bin/bwrap",
            probeBwrap: () => ({ ok: false, reason: "bwrap: setting up uid map: Permission denied" }),
        });
        const status = session(instance);

        assert.equal(status.state, "unavailable");
        assert.match(status.reason, /apparmor_restrict_unprivileged_userns/);
        assert.throws(() => instance.requireLaunchPlan(), MiniboxBlockedError);
    });

    it("compiles the project root, agent dir, and config rules into the policy", () => {
        const instance = controller();
        const status = session(instance, projectRoot, loaded({ allowWrite: ["~/cache/"], denyWrite: [".env"] }));

        assert.equal(status.state, "enabled");
        const paths = status.policy?.writable.map((entry) => entry.path) ?? [];
        assert.ok(paths.includes(projectRoot));
        assert.ok(paths.includes(agentDir));
        assert.ok(paths.includes(join(home, "cache")));
        assert.ok((status.policy?.denied ?? []).some((entry) => entry.path === join(projectRoot, ".env")));
    });

    it("includes session grants in the compiled policy and in the profile identity", () => {
        const instance = controller();
        session(instance);
        // /etc is a symlink to /private/etc on macOS, so the grant is stored, and
        // matched, under its canonical path.
        const granted = canonicalizePath("/etc/hosts");

        const before = instance.requireLaunchPlan();
        instance.addSessionGrant("/etc/hosts");
        const after = instance.requireLaunchPlan();

        assert.equal(before.confined && after.confined, true);
        if (before.confined && after.confined) {
            assert.notEqual(before.profilePath, after.profilePath);
            assert.ok(after.policy.writable.some((entry) => entry.path === granted), granted);
        }
        assert.deepEqual(instance.sessionGrants(), ["/etc/hosts"]);
    });

    it("deduplicates session grants", () => {
        const instance = controller();
        session(instance);

        instance.addSessionGrant("/etc/hosts");
        instance.addSessionGrant("/etc/hosts");
        assert.deepEqual(instance.sessionGrants(), ["/etc/hosts"]);
    });

    it("surfaces config problems and policy problems together", () => {
        const instance = controller();
        instance.applyConfig(configPath, { ...loaded(), problems: ["minibox.json could not be parsed; using no write rules from it."] });
        instance.beginSession({ cwd: projectRoot, agentDir, configPath });

        const status = session(instance, projectRoot, {
            ...loaded({ allowWrite: ["*.log"] }),
            problems: ["minibox.json could not be parsed; using no write rules from it."],
        });

        assert.equal(status.problems.length, 2);
        assert.match(status.problems[0] ?? "", /could not be parsed/);
        assert.match(status.problems[1] ?? "", /concrete paths only/);
    });

    it("clears grants and the session override on a new session", () => {
        const instance = controller();
        session(instance);
        instance.addSessionGrant("/etc/hosts");
        instance.disable();

        session(instance);

        assert.deepEqual(instance.sessionGrants(), []);
        assert.equal(instance.status().state, "enabled");
    });

    it("removes a profile directory it created itself on dispose", () => {
        const instance = new MiniboxController({
            platform: () => "darwin",
            isExecutable: () => true,
            home: () => home,
            tempDirs: [],
        });
        session(instance);
        const plan = instance.requireLaunchPlan();
        assert.equal(plan.confined, true);
        if (!plan.confined) return;

        const created = dirname(plan.profilePath);
        assert.ok(existsSync(created));
        instance.dispose();
        assert.equal(existsSync(created), false);
    });

    it("leaves an injected profile directory alone on dispose", () => {
        const instance = controller();
        session(instance);
        instance.requireLaunchPlan();

        instance.dispose();
        assert.ok(existsSync(profileDir), "the injector owns the directory it supplied");
    });

    it("reports a reload only when something actually changed", () => {
        const instance = controller();
        session(instance);
        const seen: number[] = [];
        instance.onReload(() => seen.push(1));

        assert.equal(instance.reload(configPath, () => loaded()), false);
        assert.equal(instance.reload(configPath, () => loaded({ enabled: false })), true);
        assert.equal(seen.length, 1);
    });

    it("applies a persisted default immediately", () => {
        const instance = controller();
        session(instance, projectRoot, loaded({ enabled: false }));
        instance.enable();

        const status = instance.applyDefault({ version: 1, enabled: false, allowWrite: [], denyWrite: [] });

        assert.equal(status.state, "inactive");
        assert.equal(status.enabledByDefault, false);
    });
});

describe("config files that do not exist yet", () => {
    it("keeps working when the config path is inside a missing directory", () => {
        const instance = controller();
        const missingDir = join(fixtureRoot, "absent");
        const path = join(missingDir, "minibox.json");

        instance.applyConfig(path, loaded());
        const status = instance.beginSession({ cwd: projectRoot, agentDir, configPath: path });

        assert.equal(status.configPath, path);
        assert.equal(status.state, "enabled");
        writeFileSync(join(fixtureRoot, "scratch"), "x");
    });
});

describe("directory-shaped writable entries", () => {
    it("creates a missing directory entry so both backends can grant it", () => {
        const instance = controller();
        const created = join(home, "build-output");
        assert.equal(existsSync(created), false);

        const status = session(instance, projectRoot, loaded({ allowWrite: ["~/build-output/"] }));

        assert.equal(existsSync(created), true);
        assert.ok(status.policy?.writable.some((entry) => entry.path === created && entry.form === "dir"));
    });

    it("does not create a missing entry that is shaped like a single file", () => {
        const instance = controller();
        const created = join(home, "single-file.conf");
        assert.equal(existsSync(created), false);

        const status = session(instance, projectRoot, loaded({ allowWrite: ["~/single-file.conf"] }));

        assert.equal(existsSync(created), false);
        assert.ok(status.policy?.writable.some((entry) => entry.path === created && entry.form === "file"));
    });

    it("reports a directory entry it cannot create instead of pretending it is granted", () => {
        const blocker = join(fixtureRoot, "blocker-file");
        writeFileSync(blocker, "not a directory");

        const instance = controller();
        const status = session(instance, projectRoot, loaded({ allowWrite: [`${blocker}/child/`] }));

        assert.match(status.problems.join(" "), /could not create the directory/);
    });
});
