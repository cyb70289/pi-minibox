/**
 * Operator-facing status: the `/minibox` report and the notices shown once when
 * a session starts.
 */

import { homedir } from "node:os";

import { pathKind, type PathKind } from "./paths.ts";
import {
    denyDirs,
    denyFiles,
    isInactiveEntryNote,
    writableDirs,
    writableFiles,
    type CompiledPolicy,
    type WriteEntry,
} from "./policy.ts";
import type { MiniboxStatus } from "./state.ts";

/** A notice a session start should show, if any. */
export type MiniboxNotice = {
    readonly message: string;
    readonly level: "info" | "warning" | "error";
};

/** Shorten a path under the home directory, for readability only. */
export function displayPath(path: string, home = homedir()): string {
    if (path === home) return "~";
    if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
    return path;
}

/** Explain why an enabled minibox cannot actually confine writes. */
export function enforcementFailureNotice(status: MiniboxStatus): MiniboxNotice | undefined {
    if (status.state !== "unavailable" && status.state !== "failed") return undefined;
    // With a captured project root, `failed` means launch from home or `/`.
    // Keep blocking tools, but show a short warning rather than a backend error.
    if (status.state === "failed" && status.projectRoot !== undefined) {
        const directory = status.projectRoot === "/" ? "filesystem root" : "home directory";
        return {
            message: `minibox: ${directory} is not a project. Writes blocked. Relaunch from your working directory, or use /minibox off.`,
            level: "warning",
        };
    }
    return { message: `minibox is ${status.state} and will block writes it cannot confine. ${status.reason}`, level: "error" };
}

/** The status and diagnostics worth showing once when a session starts. */
export function sessionStartNotices(status: MiniboxStatus): MiniboxNotice[] {
    if (status.state === "inactive" || status.state === "disabled") return [];

    const notices: MiniboxNotice[] = [
        enforcementFailureNotice(status) ?? { message: "minibox on", level: "info" },
    ];

    for (const problem of status.problems) notices.push({ message: `minibox: ${problem}`, level: "warning" });
    // An `allowWrite` entry that is not on disk yet is a quiet no-op, not launch
    // news: a seeded config lists caches most machines have not created. It stays
    // in `/minibox`, where the operator asked for the full picture.
    for (const note of status.notes) {
        if (isInactiveEntryNote(note)) continue;
        notices.push({ message: `minibox: ${note}`, level: "info" });
    }

    return notices;
}

function labelFor(entry: WriteEntry, kind: PathKind): string {
    const form = entry.form === "dir" ? "/" : "";
    const missing = kind === "missing" ? " (does not exist yet)" : "";
    return `${displayPath(entry.path)}${form}  [${entry.source}]${missing}`;
}

function section(title: string, lines: readonly string[]): string {
    return lines.length === 0 ? `${title}: none` : `${title}:\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

/** Render the full `/minibox` report. */
export function formatStatusReport(status: MiniboxStatus): string {
    const lines: string[] = [];

    lines.push(`minibox: ${status.state}`);
    if (status.backend !== undefined) lines.push(`backend: ${status.backend} (${status.executable ?? "unknown"})`);
    lines.push(`project: ${status.projectRoot ?? "(no session)"}`);
    lines.push(`agent dir: ${displayPath(status.agentDir)}`);
    lines.push(`config: ${displayPath(status.configPath)} (enabled: ${status.enabledByDefault})`);
    if (status.sessionOverride !== undefined) {
        lines.push(`session override: ${status.sessionOverride ? "on" : "off"}`);
    }
    lines.push(status.reason);

    if (status.policy !== undefined) {
        lines.push("");
        lines.push(renderPolicy(status.policy));
    }

    if (status.problems.length > 0 || status.notes.length > 0) {
        lines.push("");
        lines.push(section("problems", status.problems));
        lines.push(section("notes", status.notes));
    }

    return lines.join("\n");
}

function renderPolicy(policy: CompiledPolicy): string {
    const lines: string[] = [];

    const writable = policy.writable.map((entry) => {
        const kind = pathKind(entry.path);
        return labelFor(entry, kind);
    });
    const devices = policy.devices.map((path) => `${path}  [device]`);
    lines.push(section("writable", [...writable, ...devices]));

    const denied = policy.denied.map((entry) => {
        const source = entry.path === policy.profileDir ? "internal" : entry.source;
        return `${displayPath(entry.path)}  [${source}]`;
    });
    lines.push(section("denied", denied));

    return lines.join("\n");
}

/** The resolved paths, for tests and for callers that want the raw lists. */
export function policyLists(policy: CompiledPolicy): {
    writableDirs: string[];
    writableFiles: string[];
    denyDirs: string[];
    denyFiles: string[];
} {
    return {
        writableDirs: writableDirs(policy),
        writableFiles: writableFiles(policy),
        denyDirs: denyDirs(policy),
        denyFiles: denyFiles(policy),
    };
}
