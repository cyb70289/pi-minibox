/**
 * macOS Seatbelt backend.
 *
 * Pi's own bash tool runs a child process, so the only way to confine its writes
 * is to wrap that child in `sandbox-exec` with a generated SBPL profile. The
 * profile is built from the same compiled policy the in-process file guard uses,
 * which is what keeps a `write` tool call and a `cat >` in bash from disagreeing.
 *
 * Shape of the profile:
 *
 *   (allow default)                  reads, exec, network stay as they were
 *   (deny file-write*)               ...then writes are refused everywhere...
 *   ...allows...                     ...except the writable roots and devices...
 *   ...denies...                     ...and these carve holes back out, last,
 *                                    because Seatbelt applies the last match.
 *
 * Nothing here inspects command text. The kernel refuses the write itself, so a
 * crafted command cannot talk its way past the policy.
 */

import { writeFileSync } from "node:fs";

import { denyDirs, denyFiles, writableDirs, writableFiles, type CompiledPolicy } from "./policy.ts";

/** The macOS sandbox launcher, present on every supported macOS release. */
export const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** An executable plus its argv, ready to hand to a spawn call. */
export type SandboxCommand = {
    readonly file: string;
    readonly fileArgs: readonly string[];
};

/** Quote a path as an SBPL string literal. */
function sbpl(value: string): string {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Build the SBPL profile for a compiled policy. */
export function buildSeatbeltProfile(policy: CompiledPolicy): string {
    const allows = [
        ...writableDirs(policy).map((path) => `(allow file-write* (subpath ${sbpl(path)}))`),
        ...writableFiles(policy).map((path) => `(allow file-write* (literal ${sbpl(path)}))`),
        ...policy.devices.map((path) => `(allow file-write* (literal ${sbpl(path)}))`),
    ];

    const denies = [
        ...denyDirs(policy).map((path) => `(deny file-write* (subpath ${sbpl(path)}))`),
        // A denied file is denied as a subtree as well: the extra rule covers a
        // directory created at that name, which a plain literal would not.
        ...denyFiles(policy).map((path) => `(deny file-write* (subpath ${sbpl(path)}))`),
    ];

    return ["(version 1)", "(allow default)", "(deny file-write*)", ...allows, ...denies, ""].join("\n");
}

export type SeatbeltCommandArgs = {
    readonly policy: CompiledPolicy;
    /** Where the generated profile is written. */
    readonly profilePath: string;
    /** The program to run inside the sandbox. */
    readonly execPath: string;
    readonly execArgs: readonly string[];
    /** Defaults to `fs.writeFileSync`. */
    readonly writeProfile?: (path: string, contents: string) => void;
};

/**
 * Write the profile and return the wrapper command.
 *
 * `exec`/`execArgs` are passed through verbatim after `sandbox-exec`'s own flags,
 * so the command text is never re-tokenized on the way in.
 */
export function buildSeatbeltCommand(args: SeatbeltCommandArgs): SandboxCommand {
    (args.writeProfile ?? writeFileSync)(args.profilePath, buildSeatbeltProfile(args.policy));
    return {
        file: MACOS_SANDBOX_EXEC,
        fileArgs: ["-f", args.profilePath, args.execPath, ...args.execArgs],
    };
}
