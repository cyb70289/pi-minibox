/**
 * The system prompt section that tells the model a sandbox is running.
 *
 * The section is attached through `before_agent_start`'s mutable `sections`
 * map, so Pi diffs it against what the model already has and sends a patch only
 * when it changes. Keeping the text constant means an unchanged session costs
 * nothing; switching protection on or off costs exactly one patch.
 *
 * It is present only while minibox is actually enforcing (`enabled`). When it is
 * `unavailable` or `failed`, all protected writes are blocked rather than only
 * outside ones, and the blocked-operation error already says so.
 */

import type { MiniboxStatus } from "./state.ts";

/** Section name; Pi wraps the content as `<minibox>...</minibox>`. */
export const MINIBOX_PROMPT_SECTION = "minibox";

const SECTION_TEXT = [
    "A minimal write sandbox is active. Shell commands and file writes outside the current project directory may be blocked or require user confirmation.",
    "If an operation fails because of the sandbox and you cannot finish the task within these limits, stop and explain what was blocked. Do not bypass the sandbox. The user can allow the path in minibox.json or disable the sandbox (/minibox off) if necessary.",
].join("\n");

/** The section content for a status, or undefined when nothing should be sent. */
export function miniboxPromptSection(status: MiniboxStatus): string | undefined {
    return status.state === "enabled" ? SECTION_TEXT : undefined;
}
