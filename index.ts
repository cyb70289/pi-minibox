/**
 * pi-minibox - a minimal write-only sandbox for Pi's foreground tools.
 *
 * Installing this package loads an extension; there is no launcher, so Pi keeps
 * being started normally. While enabled, the built-in `bash` tool and
 * operator-entered `!` commands run inside macOS Seatbelt or Linux bubblewrap
 * with writes allowed only under the project root, `~/.pi`, temp, `/dev`
 * character devices, and the paths in `minibox.json`. The built-in `write` and
 * `edit` tools mutate files inside Pi's own process, where no child can be
 * wrapped, so they are guarded in-process instead and ask before writing outside
 * the project. Reads and network are never touched.
 *
 * This is a tool-execution sandbox. Pi's own process, `pi.exec` calls from other
 * extensions, and unrelated extension code are not confined by it.
 */

import {
    createBashToolDefinition,
    getAgentDir,
    SettingsManager,
    type BashOperations,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    createMiniboxConfigCache,
    miniboxConfigPath,
    MiniboxConfigWriteError,
    setMiniboxEnabled,
} from "./src/config.ts";
import { APPROVAL_ENTRY_TYPE, createWriteGuard, readSessionApprovals } from "./src/guard.ts";
import { createMiniboxBashOperations } from "./src/shell.ts";
import { enforcementFailureNotice, formatStatusReport, sessionStartNotices } from "./src/status.ts";
import { MiniboxController } from "./src/state.ts";

const COMMAND_NAME = "minibox";
const COMMAND_DESCRIPTION = "Show or change the minibox write sandbox";

export default function piMinibox(pi: ExtensionAPI): void {
    const controller = new MiniboxController();
    const configPath = miniboxConfigPath(getAgentDir());
    const configCache = createMiniboxConfigCache(configPath);

    // Pi's shell setting is only readable once a session directory is known, so
    // it is resolved lazily and re-read on every session start.
    let shellPath: string | undefined;

    /** Re-read the config file when it changed. */
    const refreshConfig = (): void => {
        controller.reload(configPath, () => configCache.load());
    };

    const innerBash = createMiniboxBashOperations(controller, { shellPath: () => shellPath });

    // Refresh before every protected operation, so an edit to minibox.json takes
    // effect on the next write rather than on the next session.
    const operations: BashOperations = {
        exec(command, cwd, execOptions) {
            refreshConfig();
            return innerBash.exec(command, cwd, execOptions);
        },
    };

    // Overriding the built-in bash tool by name. Only `operations` changes:
    // Pi's own definition still owns the schema, streaming, timeout,
    // cancellation, truncation, session environment, result details, and both
    // renderers.
    let bashToolCwd: string | undefined;
    const registerBashTool = (cwd: string): void => {
        if (bashToolCwd === cwd) return;
        bashToolCwd = cwd;
        pi.registerTool(createBashToolDefinition(cwd, { operations }));
    };
    registerBashTool(process.cwd());

    // The same backend for operator-entered ! and !! commands.
    pi.on("user_bash", () => ({ operations }));

    // The built-in write and edit tools are guarded at the call boundary, which
    // is the only place a dialog can be shown and the only place the path can be
    // canonicalized before Pi resolves it.
    const guard = createWriteGuard({
        controller,
        recordApproval: (path) => pi.appendEntry(APPROVAL_ENTRY_TYPE, { path }),
    });
    pi.on("tool_call", async (event, ctx) => {
        refreshConfig();
        return guard(event, ctx);
    });

    pi.on("session_start", (_event, ctx: ExtensionContext) => {
        shellPath = resolveShellPath(ctx.cwd);
        registerBashTool(ctx.cwd);

        const loaded = configCache.load();
        controller.applyConfig(configPath, loaded);
        controller.beginSession({ cwd: ctx.cwd, agentDir: getAgentDir(), configPath });

        // Approvals written earlier in this session file — including one made
        // before a `pi -c` continuation — come back on the active branch only.
        for (const path of readSessionApprovals(ctx.sessionManager.getBranch())) {
            controller.addSessionGrant(path);
        }

        for (const notice of sessionStartNotices(controller.status())) {
            // Pi renders info notices dim; override that only for the TUI's
            // positive startup status. RPC clients receive plain text.
            const message = ctx.mode === "tui" && notice.message === "minibox on"
                ? ctx.ui.theme.bold(ctx.ui.theme.fg("success", notice.message))
                : notice.message;
            ctx.ui.notify(message, notice.level);
        }
    });

    pi.on("session_shutdown", () => {
        controller.dispose();
    });

    pi.registerCommand(COMMAND_NAME, {
        description: COMMAND_DESCRIPTION,
        handler: async (args, ctx) => {
            refreshConfig();
            await handleCommand(args.trim(), ctx);
        },
    });

    async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
        const words = args.split(/\s+/).filter((word) => word !== "");

        if (words.length === 0) {
            ctx.ui.notify(formatStatusReport(controller.status()), "info");
            return;
        }

        const persisted = words[0] === "default";
        const value = persisted ? words[1] : words[0];

        if ((value !== "on" && value !== "off") || (persisted && words.length !== 2) || (!persisted && words.length !== 1)) {
            ctx.ui.notify("Usage: /minibox [on|off|default on|default off]", "warning");
            return;
        }

        const enabled = value === "on";
        if (!persisted) {
            const status = enabled ? controller.enable() : controller.disable();
            const failure = enforcementFailureNotice(status);
            if (failure) {
                ctx.ui.notify(failure.message, failure.level);
                return;
            }
            ctx.ui.notify(
                enabled
                    ? "minibox is on for this session. Protected writes are confined."
                    : "minibox is OFF for this session. Protected writes run unconfined.",
                enabled ? "info" : "warning",
            );
            return;
        }

        try {
            const config = setMiniboxEnabled(configPath, enabled);
            configCache.invalidate();
            const status = controller.applyDefault(config);
            const failure = enforcementFailureNotice(status);
            if (failure) {
                ctx.ui.notify(`minibox default is now on (${configPath}), but ${failure.message}`, failure.level);
                return;
            }
            ctx.ui.notify(
                `minibox default is now ${enabled ? "on" : "off"} (${configPath}).`,
                enabled ? "info" : "warning",
            );
        } catch (error) {
            const message =
                error instanceof MiniboxConfigWriteError
                    ? error.message
                    : `Could not update ${configPath}: ${error instanceof Error ? error.message : String(error)}`;
            ctx.ui.notify(message, "error");
        }
    }
}

function resolveShellPath(cwd: string): string | undefined {
    try {
        return SettingsManager.create(cwd).getShellPath();
    } catch {
        // A malformed settings file must not decide whether the sandbox runs;
        // fall back to Pi's own shell resolution.
        return undefined;
    }
}

export { createWriteGuard, readSessionApprovals } from "./src/guard.ts";
export { compilePolicy, evaluateWriteAccess } from "./src/policy.ts";
export {
    BWRAP_INSTALL_HINT,
    BWRAP_PROBE_ARGS,
    BWRAP_USERNS_HINT,
    buildBwrapArgs,
    isUserNamespaceFailure,
    materializeDenyPath,
    probeBwrap,
    type BwrapProbe,
} from "./src/bwrap.ts";
export { buildSeatbeltCommand, buildSeatbeltProfile } from "./src/seatbelt.ts";
export { createMiniboxBashOperations, quoteForPosixShell } from "./src/shell.ts";
export { formatStatusReport } from "./src/status.ts";
export {
    describeBackendSupport,
    executableFromPath,
    MiniboxBlockedError,
    MiniboxController,
    type BackendSupport,
    type MiniboxState,
    type MiniboxStatus,
} from "./src/state.ts";
export {
    createMiniboxConfigCache,
    DEFAULT_ALLOW_WRITE,
    DEFAULT_DENY_WRITE,
    loadMiniboxConfig,
    miniboxConfigPath,
    MiniboxConfigWriteError,
    setMiniboxEnabled,
} from "./src/config.ts";
