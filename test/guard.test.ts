import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { LoadedMiniboxConfig } from "../src/config.ts";
import {
    APPROVAL_ENTRY_TYPE,
    CONFIRM_TIMEOUT_MS,
    confirmationMessage,
    createWriteGuard,
    guardedTarget,
    readSessionApprovals,
} from "../src/guard.ts";
import { MiniboxBlockedError, MiniboxController } from "../src/state.ts";

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "minibox-guard-")));
const projectRoot = join(fixtureRoot, "proj");
const home = join(fixtureRoot, "home");
const agentDir = join(home, ".pi");
const configPath = join(agentDir, "minibox.json");
const profileDir = join(fixtureRoot, "profiles");
const outsideDir = join(fixtureRoot, "outside");

before(() => {
    mkdirSync(join(projectRoot, "sub"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
});

after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const config: LoadedMiniboxConfig = {
    config: { version: 1, enabled: true, allowWrite: [], allowDevices: [] },
    problems: [],
    notes: [],
    seeded: false,
    malformed: false,
};

function makeController(seams: Partial<ConstructorParameters<typeof MiniboxController>[0]> = {}) {
    const instance = new MiniboxController({
        platform: () => "darwin",
        isExecutable: () => true,
        home: () => home,
        tempDirs: [],
        createProfileDir: () => {
            mkdirSync(profileDir, { recursive: true });
            return profileDir;
        },
        ...seams,
    });
    instance.applyConfig(configPath, config);
    instance.beginSession({ cwd: projectRoot, agentDir, configPath });
    return instance;
}

function writeEvent(path: string): ToolCallEvent {
    return {
        type: "tool_call",
        toolCallId: `call-${Math.random()}`,
        toolName: "write",
        input: { path, content: "x" },
    } as unknown as ToolCallEvent;
}

type ConfirmCall = { title: string; message: string; timeout: number | undefined; signal: AbortSignal | undefined };

function makeContext(options: { hasUI?: boolean; answer?: boolean; delayMs?: number } = {}) {
    const calls: ConfirmCall[] = [];
    const ctx = {
        hasUI: options.hasUI ?? true,
        signal: undefined,
        cwd: projectRoot,
        ui: {
            async confirm(title: string, message: string, opts?: { timeout?: number; signal?: AbortSignal }) {
                calls.push({ title, message, timeout: opts?.timeout, signal: opts?.signal });
                if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
                return options.answer ?? true;
            },
            notify() {},
        },
    } as unknown as ExtensionContext;
    return { ctx, calls };
}

function approvals() {
    const recorded: string[] = [];
    return { recorded, recordApproval: (path: string) => recorded.push(path) };
}

describe("readSessionApprovals", () => {
    it("reads confirmed paths from the active branch only", () => {
        const branch = [
            { type: "message" },
            { type: "custom", customType: "something-else", data: { path: "/nope" } },
            { type: "custom", customType: APPROVAL_ENTRY_TYPE, data: { path: "/a" } },
            { type: "custom", customType: APPROVAL_ENTRY_TYPE, data: { path: "/a" } },
            { type: "custom", customType: APPROVAL_ENTRY_TYPE, data: { path: "/b" } },
            { type: "custom", customType: APPROVAL_ENTRY_TYPE },
            { type: "custom", customType: APPROVAL_ENTRY_TYPE, data: { path: 42 } },
            { type: "custom", customType: APPROVAL_ENTRY_TYPE, data: { path: "" } },
        ];

        assert.deepEqual(readSessionApprovals(branch), ["/a", "/b"]);
    });

    it("returns nothing for an empty branch", () => {
        assert.deepEqual(readSessionApprovals([]), []);
    });
});

describe("guardedTarget", () => {
    it("recognizes the built-in file tools", () => {
        assert.equal(guardedTarget(writeEvent("/tmp/x")), "/tmp/x");
        assert.equal(
            guardedTarget({ toolName: "edit", input: { path: "/tmp/y" } } as unknown as ToolCallEvent),
            "/tmp/y",
        );
    });

    it("ignores everything else", () => {
        assert.equal(guardedTarget({ toolName: "bash", input: { command: "ls" } } as unknown as ToolCallEvent), undefined);
        assert.equal(guardedTarget({ toolName: "write", input: {} } as unknown as ToolCallEvent), undefined);
        assert.equal(guardedTarget({ toolName: "write", input: { path: "" } } as unknown as ToolCallEvent), undefined);
    });
});

describe("createWriteGuard while minibox is off", () => {
    it("leaves the call untouched when the default is off", async () => {
        const controller = makeController();
        controller.applyConfig(configPath, { ...config, config: { ...config.config, enabled: false } });
        controller.disable();
        const { recorded, recordApproval } = approvals();
        const { ctx, calls } = makeContext();
        const guard = createWriteGuard({ controller, recordApproval });
        const event = writeEvent(join(outsideDir, "file.txt"));

        assert.equal(await guard(event, ctx), undefined);
        assert.equal(calls.length, 0);
        assert.deepEqual(recorded, []);
        assert.equal((event.input as { path: string }).path, join(outsideDir, "file.txt"));
    });
});

describe("createWriteGuard while minibox is on", () => {
    it("allows a path inside the project without asking, and canonicalizes it", async () => {
        const controller = makeController();
        const { recorded, recordApproval } = approvals();
        const { ctx, calls } = makeContext();
        const guard = createWriteGuard({ controller, recordApproval });

        const link = join(projectRoot, "sub", "link.txt");
        symlinkSync(join(projectRoot, "sub"), join(projectRoot, "redirect"));
        const event = writeEvent(join(projectRoot, "redirect", "link.txt"));

        assert.equal(await guard(event, ctx), undefined);
        assert.equal(calls.length, 0);
        assert.equal((event.input as { path: string }).path, link);
        assert.deepEqual(recorded, []);
    });

    it("blocks a write to a minibox-internal file without offering a dialog", async () => {
        const controller = makeController();
        const { recorded, recordApproval } = approvals();
        const { ctx, calls } = makeContext();
        const guard = createWriteGuard({ controller, recordApproval });
        const event = writeEvent(configPath);

        const result = await guard(event, ctx);

        assert.equal(result?.block, true);
        assert.match(result?.reason ?? "", /write-blocked/);
        assert.equal(calls.length, 0);
        assert.deepEqual(recorded, []);
    });

    it("asks before writing outside the project and allows it when confirmed", async () => {
        const controller = makeController();
        const { recorded, recordApproval } = approvals();
        const { ctx, calls } = makeContext({ answer: true });
        const guard = createWriteGuard({ controller, recordApproval });
        const target = join(outsideDir, "granted.txt");
        const event = writeEvent(target);

        assert.equal(await guard(event, ctx), undefined);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.timeout, CONFIRM_TIMEOUT_MS);
        assert.match(calls[0]?.message ?? "", /Yes allows this path for the rest of the session/);
        assert.deepEqual(recorded, [target]);
        assert.deepEqual(controller.sessionGrants(), [target]);
        assert.equal((event.input as { path: string }).path, target);
    });

    it("blocks outside writes that are declined", async () => {
        const controller = makeController();
        const { recorded, recordApproval } = approvals();
        const { ctx } = makeContext({ answer: false });
        const guard = createWriteGuard({ controller, recordApproval });

        const result = await guard(writeEvent(join(outsideDir, "declined.txt")), ctx);

        assert.equal(result?.block, true);
        assert.match(result?.reason ?? "", /was denied \(declined, dismissed, or no response within 60s\)/);
        assert.match(result?.reason ?? "", /Nothing was written/);
        assert.deepEqual(recorded, []);
        assert.deepEqual(controller.sessionGrants(), []);
    });

    it("blocks outside writes when there is no interactive UI", async () => {
        const controller = makeController();
        const { recordApproval } = approvals();
        const { ctx, calls } = makeContext({ hasUI: false });
        const guard = createWriteGuard({ controller, recordApproval });

        const result = await guard(writeEvent(join(outsideDir, "headless.txt")), ctx);

        assert.equal(result?.block, true);
        assert.match(result?.reason ?? "", /not available in this mode/);
        assert.equal(calls.length, 0);
    });

    it("does not ask again for a path already granted this session", async () => {
        const controller = makeController();
        const { recorded, recordApproval } = approvals();
        const { ctx, calls } = makeContext();
        const guard = createWriteGuard({ controller, recordApproval });
        const target = join(outsideDir, "already.txt");
        writeFileSync(target, "x");
        controller.addSessionGrant(target);

        assert.equal(await guard(writeEvent(target), ctx), undefined);
        assert.equal(calls.length, 0);
        assert.deepEqual(recorded, []);
    });

    it("serializes simultaneous calls so one dialog covers both", async () => {
        const controller = makeController();
        const { recordApproval } = approvals();
        const { ctx, calls } = makeContext({ answer: true, delayMs: 20 });
        const guard = createWriteGuard({ controller, recordApproval });
        const target = join(outsideDir, "parallel.txt");

        const results = await Promise.all([guard(writeEvent(target), ctx), guard(writeEvent(target), ctx)]);

        assert.deepEqual(results, [undefined, undefined]);
        assert.equal(calls.length, 1);
    });

    it("still blocks file tools launched from home or the filesystem root", async () => {
        for (const cwd of [home, "/"]) {
            const controller = makeController();
            controller.beginSession({ cwd, agentDir, configPath });
            const { recorded, recordApproval } = approvals();
            const { ctx, calls } = makeContext();
            const guard = createWriteGuard({ controller, recordApproval });

            for (const toolName of ["write", "edit"] as const) {
                const event = { ...writeEvent(join(home, "inside.txt")), toolName } as ToolCallEvent;
                const result = await guard(event, ctx);
                assert.equal(result?.block, true);
            }
            assert.equal(calls.length, 0);
            assert.deepEqual(recorded, []);
            assert.throws(() => controller.requireLaunchPlan(), MiniboxBlockedError);
        }
    });

    it("reports a refusal to confine instead of allowing the write", async () => {
        const controller = new MiniboxController({
            platform: () => "linux",
            lookupExecutable: () => undefined,
            home: () => home,
            tempDirs: [],
        });
        controller.applyConfig(configPath, config);
        controller.beginSession({ cwd: projectRoot, agentDir, configPath });
        const { recordApproval } = approvals();
        const { ctx, calls } = makeContext();
        const guard = createWriteGuard({ controller, recordApproval });

        const result = await guard(writeEvent(join(projectRoot, "inside.txt")), ctx);

        assert.equal(result?.block, true);
        assert.match(result?.reason ?? "", /cannot confine this write/);
        assert.equal(calls.length, 0);
    });
});

describe("confirmationMessage", () => {
    it("mentions created parent directories for a new nested file", () => {
        const controller = makeController();
        const policy = controller.status().policy;
        assert.ok(policy);

        const message = confirmationMessage(join(outsideDir, "deep", "new.txt"), policy);

        assert.match(message, /parent directories will be created/);
        assert.match(message, /minibox\.json is never changed/);
    });

    it("does not claim parent creation for an existing file", () => {
        const controller = makeController();
        const policy = controller.status().policy;
        assert.ok(policy);

        const message = confirmationMessage(join(projectRoot, "sub", "existing.txt"), policy);

        assert.equal(message.includes("parent directories"), false);
    });
});
