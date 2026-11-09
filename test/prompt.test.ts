import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { miniboxPromptSection } from "../src/prompt.ts";
import type { MiniboxState, MiniboxStatus } from "../src/state.ts";

function statusOf(state: MiniboxState): MiniboxStatus {
    return {
        state,
        platform: "darwin",
        backend: state === "enabled" ? "macos-seatbelt" : undefined,
        executable: state === "enabled" ? "/usr/bin/sandbox-exec" : undefined,
        projectRoot: "/work/project",
        agentDir: "/home/user/.pi",
        configPath: "/home/user/.pi/minibox.json",
        enabledByDefault: true,
        sessionOverride: undefined,
        config: { version: 1, enabled: true, allowWrite: [], allowDevices: [] },
        problems: [],
        notes: [],
        policy: undefined,
        reason: "",
    };
}

describe("miniboxPromptSection", () => {
    it("describes the sandbox only while it is enforced", () => {
        const section = miniboxPromptSection(statusOf("enabled"));
        assert.ok(section !== undefined);
        assert.match(section, /minimal write sandbox is active/);
        assert.match(section, /File writes outside the current project directory/);
        assert.match(section, /blocked or require user confirmation/);
        assert.match(section, /sudo is blocked and will fail/);
        assert.match(section, /Temporary directories are writable/);
        assert.match(section, /Additional allowed paths are configured in ~\/\.pi\/agent\/minibox\.json/);
        assert.match(section, /If you cannot complete the task within these limits/);
        assert.match(section, /stop and explain what was blocked/);
        assert.match(section, /Do not bypass the sandbox/);
        assert.match(section, /The user can disable the sandbox if necessary/);
    });

    it("stays silent in every state that is not enforcing", () => {
        for (const state of ["inactive", "disabled", "unavailable", "failed"] as const) {
            assert.equal(miniboxPromptSection(statusOf(state)), undefined, state);
        }
    });

    it("returns identical text for identical status, so the section diff is empty", () => {
        // Pi compares section text, so a stable string costs no system patch.
        assert.equal(miniboxPromptSection(statusOf("enabled")), miniboxPromptSection(statusOf("enabled")));
    });
});
