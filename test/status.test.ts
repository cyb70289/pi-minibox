import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { LoadedMiniboxConfig } from "../src/config.ts";
import { inactiveEntryNote } from "../src/policy.ts";
import { policyLists, displayPath, enforcementFailureNotice, formatStatusReport, sessionStartNotices } from "../src/status.ts";
import { MiniboxController, type MiniboxStatus } from "../src/state.ts";

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "minibox-status-")));
const projectRoot = join(fixtureRoot, "proj");
const home = join(fixtureRoot, "home");
const agentDir = join(home, ".pi");
const configPath = join(agentDir, "minibox.json");

before(() => {
    mkdirSync(join(projectRoot, "sub"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
});

after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const config: LoadedMiniboxConfig = {
    config: { version: 1, enabled: true, allowWrite: [], allowDevices: [] },
    problems: [],
    notes: [],
    seeded: false,
    malformed: false,
};

function statusOf(overrides: Partial<MiniboxStatus> = {}): MiniboxStatus {
    return {
        state: "inactive",
        platform: "darwin",
        backend: "macos-seatbelt",
        executable: "/usr/bin/sandbox-exec",
        projectRoot,
        agentDir,
        configPath,
        enabledByDefault: true,
        sessionOverride: undefined,
        config: config.config,
        problems: [],
        notes: [],
        policy: undefined,
        reason: "test",
        ...overrides,
    };
}

function enabledController() {
    const controller = new MiniboxController({
        platform: () => "darwin",
        isExecutable: () => true,
        home: () => home,
        tempDirs: [],
        createProfileDir: () => {
            mkdirSync(join(fixtureRoot, "profiles"), { recursive: true });
            return join(fixtureRoot, "profiles");
        },
    });
    controller.applyConfig(configPath, config);
    controller.beginSession({ cwd: projectRoot, agentDir, configPath });
    return controller;
}

describe("displayPath", () => {
    it("shortens paths under home", () => {
        assert.equal(displayPath(join(home, ".pi"), home), "~/.pi");
        assert.equal(displayPath(home, home), "~");
    });

    it("leaves other paths alone", () => {
        assert.equal(displayPath("/etc/hosts", home), "/etc/hosts");
    });
});

describe("formatStatusReport", () => {
    it("reports the state, the backend, the project, and the rules", () => {
        const controller = enabledController();
        const report = formatStatusReport(controller.status());

        assert.match(report, /^minibox: enabled$/m);
        assert.match(report, /^backend: macos-seatbelt \(\/usr\/bin\/sandbox-exec\)$/m);
        assert.match(report, /^project: /m);
        assert.match(report, /^config: .*minibox\.json \(enabled: true\)$/m);
        assert.match(report, /^writable:$/m);
        assert.match(report, /\[project\]/);
        assert.match(report, /\[baseline\]/);
        assert.match(report, /^denied:$/m);
        assert.match(report, /\[builtin\]/);
        assert.match(report, /\[internal\]/);
    });

    it("explains why a non-enforcing state is what it is", () => {
        const report = formatStatusReport(
            statusOf({ state: "unavailable", backend: undefined, executable: undefined, reason: "no bwrap here" }),
        );

        assert.match(report, /^minibox: unavailable$/m);
        assert.match(report, /no bwrap here/);
        assert.equal(report.includes("writable:"), false);
    });

    it("lists problems and notes", () => {
        const report = formatStatusReport(
            statusOf({ problems: ["a dropped rule"], notes: ["an unknown key"] }),
        );

        assert.match(report, /problems:\n {2}a dropped rule/);
        assert.match(report, /notes:\n {2}an unknown key/);
    });
});

describe("sessionStartNotices", () => {
    it("shows on once when minibox is enforcing", () => {
        assert.deepEqual(sessionStartNotices(statusOf({ state: "enabled" })), [
            { message: "minibox on", level: "info" },
        ]);
    });

    it("says nothing while minibox is off, including config diagnostics", () => {
        for (const state of ["inactive", "disabled"] as const) {
            assert.deepEqual(sessionStartNotices(statusOf({ state, problems: ["bad json"], notes: ["note"] })), []);
        }
    });

    it("reports config problems after the enabled startup status", () => {
        const notices = sessionStartNotices(statusOf({ state: "enabled", problems: ["bad json"] }));

        assert.deepEqual(notices, [
            { message: "minibox on", level: "info" },
            { message: "minibox: bad json", level: "warning" },
        ]);
    });

    it("stays quiet about allow entries that do not exist yet, but keeps other notes", () => {
        const unknownKey = 'minibox.json has an unknown key "x"; it is ignored.';
        const notices = sessionStartNotices(
            statusOf({ state: "enabled", notes: [inactiveEntryNote("~/.bun/"), unknownKey] }),
        );

        assert.deepEqual(notices, [
            { message: "minibox on", level: "info" },
            { message: `minibox: ${unknownKey}`, level: "info" },
        ]);
    });

    it("warns concisely when launched from home or the filesystem root", () => {
        for (const [cwd, directory] of [[home, "home directory"], ["/", "filesystem root"]] as const) {
            const controller = enabledController();
            const status = controller.beginSession({ cwd, agentDir, configPath });
            const notice = {
                message: `minibox: ${directory} is not a project. Writes blocked. Relaunch from your working directory, or use /minibox off.`,
                level: "warning",
            };

            assert.equal(status.state, "failed");
            assert.deepEqual(sessionStartNotices(status), [notice]);
            assert.deepEqual(enforcementFailureNotice(controller.enable()), notice);
            assert.deepEqual(sessionStartNotices(controller.disable()), []);
        }
    });

    it("shows an error for a missing backend or session", () => {
        for (const state of ["unavailable", "failed"] as const) {
            const status = statusOf({ state, projectRoot: undefined, reason: "cannot enforce protection" });
            const notices = sessionStartNotices(status);

            assert.equal(notices.length, 1);
            assert.equal(notices[0]?.level, "error");
            assert.match(notices[0]?.message ?? "", /will block writes it cannot confine/);
            assert.equal(notices[0]?.message.includes("minibox on"), false);
            assert.deepEqual(enforcementFailureNotice(status), notices[0]);
        }
        assert.equal(enforcementFailureNotice(statusOf({ state: "enabled" })), undefined);
    });
});

describe("policyLists", () => {
    it("separates directory and file rules", () => {
        const controller = enabledController();
        const policy = controller.status().policy;
        assert.ok(policy);

        const lists = policyLists(policy);

        assert.ok(lists.writableDirs.includes(projectRoot));
        assert.deepEqual(lists.writableFiles, []);
        assert.deepEqual(lists.denyDirs, [join(fixtureRoot, "profiles")]);
        assert.deepEqual(lists.denyFiles, [configPath]);
    });
});
