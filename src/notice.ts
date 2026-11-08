/**
 * The startup status card shown in the TUI transcript.
 *
 * A notify line is transient and can be scrolled away before it is read when
 * `pi -c` settles at the newest message. A custom session entry with a renderer
 * is the supported way to keep that information in the transcript below the
 * latest message. The data is parsed defensively because it can come from an
 * older session file.
 */

import type { MiniboxNotice } from "./status.ts";

/** Session entry type used for the startup status card. */
export const STARTUP_ENTRY_TYPE = "minibox-startup";

/** The slice of Pi's Theme the card needs. */
export type NoticeTheme = {
    fg(color: "dim" | "warning" | "error", text: string): string;
};

type NoticeData = { readonly notices: readonly MiniboxNotice[] };

/** The payload persisted for one startup status card. */
export type StartupEntryData = NoticeData;

/** Read the notices from an entry's data, ignoring malformed entries and items. */
export function readStartupNotices(data: unknown): MiniboxNotice[] | undefined {
    if (typeof data !== "object" || data === null) return undefined;
    const notices = (data as { notices?: unknown }).notices;
    if (!Array.isArray(notices)) return undefined;

    const valid: MiniboxNotice[] = [];
    for (const item of notices) {
        if (typeof item !== "object" || item === null) continue;
        const { message, level } = item as { message?: unknown; level?: unknown };
        if (typeof message !== "string" || message === "") continue;
        if (level !== "info" && level !== "warning" && level !== "error") continue;
        valid.push({ message, level });
    }
    return valid.length > 0 ? valid : undefined;
}

/** Greedy word wrapping, with hard splits for words wider than the line. */
export function wrapText(text: string, width: number): string[] {
    const limit = Math.max(1, width);
    const lines: string[] = [];
    let line = "";

    for (const word of text.split(/\s+/).filter((part) => part !== "")) {
        if (line === "") {
            line = word;
        } else if (line.length + 1 + word.length <= limit) {
            line = `${line} ${word}`;
        } else {
            lines.push(line);
            line = word;
        }
        while (line.length > limit) {
            lines.push(line.slice(0, limit));
            line = line.slice(limit);
        }
    }
    if (line !== "") lines.push(line);
    return lines.length > 0 ? lines : [""];
}

function colorFor(level: MiniboxNotice["level"]): "dim" | "warning" | "error" {
    return level === "warning" ? "warning" : level === "error" ? "error" : "dim";
}

/**
 * Render the card for a viewport width, or undefined when there is nothing to
 * show. Width is measured before coloring, so ANSI escapes do not affect wrap.
 */
export function startupNoticeLines(data: unknown, theme: NoticeTheme, width: number): string[] | undefined {
    const notices = readStartupNotices(data);
    if (notices === undefined) return undefined;

    const available = Math.max(1, width - 1);
    const lines: string[] = [];
    for (const notice of notices) {
        for (const line of wrapText(notice.message, available)) {
            lines.push(` ${theme.fg(colorFor(notice.level), line)}`);
        }
    }
    return lines;
}

/** Build the entry payload used by `pi.appendEntry()`. */
export function startupEntryData(notices: readonly MiniboxNotice[]): StartupEntryData {
    return { notices };
}
