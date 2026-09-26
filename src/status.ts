/**
 * Operator-facing status: the footer, the `/minibox` report, and the handful of
 * notices a session start should surface.
 *
 * The footer is deliberately one word: it appears on every screen and only has
 * to answer "am I confined?". Everything else belongs in the report, where there
 * is room to show what is writable and why.
 */

import { homedir } from "node:os";

import { pathKind, type PathKind } from "./paths.ts";
import { denyDirs, denyFiles, writableDirs, writableFiles, type CompiledPolicy, type WriteEntry } from "./policy.ts";
import type { MiniboxStatus } from "./state.ts";

/** Footer slot key, so another extension can never collide with it. */
export const FOOTER_KEY = "minibox";

/** The footer label while minibox is enforcing, and nothing otherwise. */
export function footerText(status: MiniboxStatus): string | undefined {
    return status.state === "enabled" ? "minibox on" : undefined;
}

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

/** The notices worth interrupting a session start with. */
export function sessionStartNotices(status: MiniboxStatus): MiniboxNotice[] {
    const notices: MiniboxNotice[] = [];

    for (const problem of status.problems) notices.push({ message: `minibox: ${problem}`, level: "warning" });
    for (const note of status.notes) notices.push({ message: `minibox: ${note}`, level: "info" });

    if (status.state === "unavailable" || status.state === "failed") {
        notices.push({ message: `minibox is ${status.state} and will block writes it cannot confine. ${status.reason}`, level: "error" });
    }

    return notices;
}

function labelFor(entry: WriteEntry, kind: PathKind): string {
    const form = entry.form === "dir" ? "/" : "";
    const missing = kind === "missing" ? " (does not exist yet)" : "";
    return `${displayPath(entry.path)}${form}  [${entry.source}]${missing}`;
}

function missingDirectoryHint(entry: WriteEntry, kind: PathKind): string | undefined {
    if (entry.form !== "file" || kind !== "missing") return undefined;
    return `minibox: "${entry.template ?? entry.path}" does not exist; it is granted as a single file. Add a trailing slash if you meant a directory.`;
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

    const denied = policy.denied.map((entry) => `${displayPath(entry.path)}  [${entry.source}]`);
    if (policy.profileDir !== undefined) denied.push(`${displayPath(policy.profileDir)}  [internal]`);
    lines.push(section("denied", denied));

    const hints = policy.writable
        .map((entry) => missingDirectoryHint(entry, pathKind(entry.path)))
        .filter((hint): hint is string => hint !== undefined);
    if (hints.length > 0) {
        lines.push("");
        lines.push(section("hints", hints));
    }

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
