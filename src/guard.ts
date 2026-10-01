/**
 * The in-process write guard for the built-in `write` and `edit` tools.
 *
 * Those tools never spawn a child, so no kernel backend can reach them. They are
 * guarded here instead, at the `tool_call` event: the target is canonicalized,
 * a denied rule refuses it outright, a path inside the writable set is allowed
 * silently, and anything else asks the operator.
 *
 * The canonical path is written back into the tool input, so the path that was
 * checked is the path that is written. That closes the window where a symlink
 * swapped in after the check could redirect the write.
 *
 * An approval is remembered for the rest of the session — including a `pi -c`
 * continuation — by appending a session entry, never by editing minibox.json.
 * A denial is not remembered: a retry asks again rather than silencing a loop.
 */

import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

import { pathKind } from "./paths.ts";
import { displayPath } from "./status.ts";
import { evaluateWriteAccess, type CompiledPolicy } from "./policy.ts";
import type { MiniboxController, MiniboxStatus } from "./state.ts";

/** Session entry type used to remember confirmed paths across `pi -c`. */
export const APPROVAL_ENTRY_TYPE = "minibox-approval";

/** How long the confirmation box waits before it is treated as a refusal. */
export const CONFIRM_TIMEOUT_MS = 60_000;

/** The shape of the session entries this module reads back. */
export type BranchEntryLike = {
    readonly type?: string;
    readonly customType?: string;
    readonly data?: unknown;
};

/**
 * Rebuild the session's confirmed paths from the active branch.
 *
 * Only the active branch is read, so an abandoned branch's approvals do not come
 * back to life, and a fork starts with its own history.
 */
export function readSessionApprovals(branch: Iterable<BranchEntryLike>): string[] {
    const paths: string[] = [];
    for (const entry of branch) {
        if (entry.type !== "custom" || entry.customType !== APPROVAL_ENTRY_TYPE) continue;
        const data = entry.data as { path?: unknown } | undefined;
        if (typeof data?.path !== "string" || data.path === "") continue;
        if (!paths.includes(data.path)) paths.push(data.path);
    }
    return paths;
}

/** The path a guarded tool is about to touch, when it is one minibox guards. */
export function guardedTarget(event: ToolCallEvent): string | undefined {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    const input = event.input as { path?: unknown };
    return typeof input.path === "string" && input.path !== "" ? input.path : undefined;
}

function writableSummary(policy: CompiledPolicy): string {
    return `${policy.projectRoot} (project) and the paths in ${policy.configPath}`;
}

function deniedMessage(path: string, deniedBy: string): string {
    return [
        `minibox: ${path} is write-blocked because ${deniedBy} is protected. Nothing was written.`,
        "These are minibox's own files; the rule is not configurable. Do not retry this path.",
    ].join(" ");
}

function declinedMessage(path: string, policy: CompiledPolicy): string {
    return [
        `minibox: write to ${path} was denied (declined, dismissed, or no response within ${CONFIRM_TIMEOUT_MS / 1000}s). Nothing was written.`,
        `Writable now: ${writableSummary(policy)}.`,
        "Do not retry without asking the user; use a path inside the project, or ask the user to add the path to minibox.json.",
    ].join(" ");
}

function noUiMessage(path: string, policy: CompiledPolicy): string {
    return [
        `minibox: writing to ${path} needs interactive confirmation, which is not available in this mode. Nothing was written.`,
        `Writable now: ${writableSummary(policy)}.`,
        "Use a path inside the project, or ask the user to add this path to minibox.json.",
    ].join(" ");
}

function unenforceableMessage(status: MiniboxStatus): string {
    return [
        `minibox is ${status.state} and cannot confine this write, so it was blocked instead of run unconfined.`,
        `${status.reason} Use /minibox off to work unconfined on purpose.`,
    ].join(" ");
}

/** Build the confirmation question, including anything the write will create. */
export function confirmationMessage(path: string, policy: CompiledPolicy): string {
    const details: string[] = [`path:    ${path}`];
    const kind = pathKind(path);
    if (kind === "missing") {
        const parentKind = pathKind(path.slice(0, Math.max(path.lastIndexOf("/"), 1)) || "/");
        details.push(
            parentKind === "missing"
                ? "this is a new file, and its parent directories will be created"
                : "this is a new file",
        );
    }
    details.push(`project: ${displayPath(policy.projectRoot, policy.home)}`);
    details.push(`config:  ${displayPath(policy.configPath, policy.home)}`);
    details.push("");
    details.push("Yes allows this path for the rest of the session. minibox.json is never changed.");
    return details.join("\n");
}

export type WriteGuardDeps = {
    readonly controller: MiniboxController;
    /** Persist an approval so it survives `pi -c`. */
    readonly recordApproval: (path: string) => void;
};

/**
 * Create the `tool_call` handler that guards the built-in file tools.
 *
 * Dialogues are serialized: parallel tool calls cannot fight over the terminal,
 * and a call for a path approved a moment ago resolves without asking twice.
 */
export function createWriteGuard(
    deps: WriteGuardDeps,
): (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined> {
    let dialogQueue: Promise<unknown> = Promise.resolve();

    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
        const result = dialogQueue.then(task, task);
        dialogQueue = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    };

    const confirm = (ctx: ExtensionContext, path: string, policy: CompiledPolicy): Promise<boolean> =>
        serialize(async () => {
            // A parallel call for a path approved while this one waited must not
            // open a second box.
            const granted = deps.controller.sessionGrants().some((grant) => grant === path);
            if (granted) return true;

            const options = ctx.signal === undefined ? { timeout: CONFIRM_TIMEOUT_MS } : { timeout: CONFIRM_TIMEOUT_MS, signal: ctx.signal };
            return ctx.ui.confirm("minibox: write outside the project?", confirmationMessage(path, policy), options);
        });

    return async (event, ctx) => {
        const target = guardedTarget(event);
        if (target === undefined) return undefined;

        const status = deps.controller.status();
        if (status.state === "inactive" || status.state === "disabled") return undefined;
        if (status.state !== "enabled" || status.policy === undefined) {
            return { block: true, reason: unenforceableMessage(status) };
        }
        const policy = status.policy;

        const decision = evaluateWriteAccess(target, policy);
        if (decision.allowed) {
            (event.input as { path?: string }).path = decision.path;
            return undefined;
        }

        if (decision.reason === "denied") {
            return { block: true, reason: deniedMessage(decision.path, decision.deniedBy ?? "unknown") };
        }

        if (!ctx.hasUI) return { block: true, reason: noUiMessage(decision.path, policy) };

        const approved = await confirm(ctx, decision.path, policy);
        if (!approved) return { block: true, reason: declinedMessage(decision.path, policy) };

        deps.controller.addSessionGrant(decision.path);
        deps.recordApproval(decision.path);
        (event.input as { path?: string }).path = decision.path;
        return undefined;
    };
}
