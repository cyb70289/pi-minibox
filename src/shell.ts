/**
 * Foreground shell confinement.
 *
 * Pi's own bash backend keeps doing all the process work — streaming, timeout,
 * cancellation, and process-tree termination — and this module changes exactly
 * one thing: the command handed to it now `exec`s the sandbox wrapper around the
 * same shell running the same command.
 *
 * The wrapper argv is built by the backends and transported through single-quote
 * escaping, so the operator's command text is never re-tokenized: it travels as
 * one argv element to the inner shell, exactly as Pi would have passed it.
 */

import { createLocalBashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

import { buildBwrapArgs } from "./bwrap.ts";
import { buildSeatbeltCommand } from "./seatbelt.ts";
import type { LaunchPlan, MiniboxController, MiniboxStatus } from "./state.ts";

/**
 * Quote one argv element for a POSIX shell.
 *
 * Single quotes suppress every expansion, so the only character needing care is
 * the single quote itself. This is a lossless transport of one argv element, not
 * an attempt to parse the command.
 */
export function quoteForPosixShell(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

export type ShellSeams = {
    /** Explicit shell path from Pi's settings, when the operator configured one. */
    readonly shellPath?: () => string | undefined;
};

/**
 * Build the command Pi's local shell backend should run so that `command`
 * executes inside the sandbox.
 *
 * `exec` replaces the outer shell with the wrapper, so the process Pi tracks and
 * kills is the sandboxed one.
 */
export function buildSandboxedShellCommand(
    command: string,
    plan: Extract<LaunchPlan, { confined: true }>,
    status: MiniboxStatus,
    seams: ShellSeams = {},
): string {
    const shellConfig = getShellConfig(seams.shellPath?.());
    if (shellConfig.commandTransport === "stdin") {
        throw new Error(
            `minibox cannot wrap ${shellConfig.shell}: it receives commands on stdin, which no supported backend can wrap. Run /minibox off to work unconfined on purpose.`,
        );
    }

    const execArgs = [...shellConfig.args, command];
    const backend = plan.policy.platform === "darwin" ? "macos-seatbelt" : status.backend;

    let wrapper: { file: string; fileArgs: readonly string[] };
    if (backend === "macos-seatbelt") {
        wrapper = buildSeatbeltCommand({
            policy: plan.policy,
            profilePath: plan.profilePath,
            execPath: shellConfig.shell,
            execArgs,
        });
    } else if (backend === "linux-bubblewrap" && status.executable !== undefined) {
        const planned = buildBwrapArgs(status.executable, plan.policy, shellConfig.shell, execArgs);
        wrapper = { file: planned.file, fileArgs: planned.fileArgs };
    } else {
        throw new Error(`${status.reason} Run /minibox off to work unconfined on purpose.`);
    }

    const argv = [wrapper.file, ...wrapper.fileArgs].map(quoteForPosixShell);
    return `exec ${argv.join(" ")}`;
}

export type SandboxedBashOperationsOptions = ShellSeams & {
    /**
     * Pi's local shell backend. Defaults to `createLocalBashOperations()`, which
     * preserves every process contract the built-in bash tool relies on.
     */
    readonly localOperations?: BashOperations;
};

/**
 * Pluggable bash operations that confine every command they run.
 *
 * The launch decision is taken per command, so `/minibox on` and `/minibox off`
 * affect commands started after the toggle while a running command keeps the
 * policy it launched with.
 */
export function createMiniboxBashOperations(
    controller: MiniboxController,
    options: SandboxedBashOperationsOptions = {},
): BashOperations {
    let cachedShellPath: string | undefined;
    let cachedLocal: BashOperations | undefined;

    const localOperations = (): BashOperations => {
        if (options.localOperations !== undefined) return options.localOperations;
        const shellPath = options.shellPath?.();
        if (cachedLocal === undefined || cachedShellPath !== shellPath) {
            cachedShellPath = shellPath;
            cachedLocal = createLocalBashOperations(shellPath === undefined ? {} : { shellPath });
        }
        return cachedLocal;
    };

    return {
        async exec(command, cwd, execOptions) {
            const local = localOperations();
            // Throws when minibox is on but cannot be applied: the command is
            // blocked rather than retried outside the sandbox.
            const plan = controller.requireLaunchPlan();
            if (!plan.confined) return local.exec(command, cwd, execOptions);
            const status = controller.status();
            return local.exec(buildSandboxedShellCommand(command, plan, status, options), cwd, execOptions);
        },
    };
}
