/**
 * Session-local minibox state.
 *
 * One controller owns everything that can change during a session: the canonical
 * project root captured at session start, the loaded config, the persisted
 * default plus the session override, the session's confirmed paths, and the
 * directory the generated sandbox profiles are written to.
 *
 * State is deliberately honest about enforceability. `enabled` is only ever
 * reported when a backend is resolved and a usable project root was captured;
 * the other states exist so a failure is visible instead of quietly running
 * writes unconfined.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import type { LoadedMiniboxConfig, MiniboxConfig } from "./config.ts";
import { canonicalizePath, type PathSeams } from "./paths.ts";
import { compilePolicy, describeUnsafeProjectRoot, type CompiledPolicy } from "./policy.ts";

/** Which kernel mechanism a launch will use. */
export type MiniboxBackendId = "macos-seatbelt" | "linux-bubblewrap";

/** What the current platform can enforce, and why it cannot when it cannot. */
export type BackendSupport =
    | {
          readonly supported: true;
          readonly platform: string;
          readonly backend: MiniboxBackendId;
          readonly executable: string;
      }
    | {
          readonly supported: false;
          readonly platform: string;
          readonly backend: undefined;
          readonly executable: undefined;
          readonly reason: string;
      };

/**
 * What minibox is actually doing right now.
 *
 * - `inactive`    the default is off; protected operations run unconfined.
 * - `enabled`     a backend is resolved; protected operations are confined.
 * - `disabled`    a human turned it off for this session.
 * - `unavailable` no backend exists on this platform; protected operations are blocked.
 * - `failed`      protection cannot be applied here; protected operations are blocked.
 */
export type MiniboxState = "inactive" | "enabled" | "disabled" | "unavailable" | "failed";

/** Everything the status view, the footer, and the guard need to know. */
export type MiniboxStatus = {
    readonly state: MiniboxState;
    readonly platform: string;
    readonly backend: MiniboxBackendId | undefined;
    readonly executable: string | undefined;
    readonly projectRoot: string | undefined;
    readonly agentDir: string;
    readonly configPath: string;
    /** The persisted default from minibox.json. */
    readonly enabledByDefault: boolean;
    /** The session override, when there is one. */
    readonly sessionOverride: boolean | undefined;
    readonly config: MiniboxConfig;
    /** Problems found in the file itself. Policy problems are added while enabled. */
    readonly problems: readonly string[];
    readonly notes: readonly string[];
    /** The compiled policy, present only while the state is `enabled`. */
    readonly policy: CompiledPolicy | undefined;
    /** Human-readable evidence for why the state is what it is. */
    readonly reason: string;
};

/** How one protected operation should be launched. */
export type LaunchPlan =
    | { readonly confined: false }
    | { readonly confined: true; readonly policy: CompiledPolicy; readonly profilePath: string };

/** Thrown when a protected operation must be blocked instead of run unconfined. */
export class MiniboxBlockedError extends Error {
    readonly status: MiniboxStatus;

    constructor(status: MiniboxStatus) {
        super(`minibox is ${status.state}; this operation was blocked rather than run unconfined. ${status.reason}`);
        this.name = "MiniboxBlockedError";
        this.status = status;
    }
}

/** Injectable platform and filesystem dependencies. */
export type MiniboxSeams = {
    readonly platform?: () => string;
    readonly home?: () => string;
    readonly lookupExecutable?: (name: string) => string | undefined;
    readonly createProfileDir?: () => string;
    readonly canonicalize?: (path: string) => string;
    /** Whether a fixed path is an executable. Defaults to an `access(X_OK)` check. */
    readonly isExecutable?: (path: string) => boolean;
    /** Overrides the platform temp directories; tests use this to stay isolated. */
    readonly tempDirs?: readonly string[];
};

/** The macOS sandbox launcher. */
export const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Resolve an executable from PATH without executing it. */
export function executableFromPath(name: string, path = process.env.PATH): string | undefined {
    if (!path) return undefined;
    for (const entry of path.split(delimiter)) {
        const candidate = resolve(entry || ".", name);
        try {
            if (!statSync(candidate).isFile()) continue;
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            // A PATH entry can disappear between listing it and using it.
        }
    }
    return undefined;
}

function unavailableMessage(platform: string): string {
    if (platform === "linux") {
        return "the Linux backend needs the bubblewrap executable (bwrap) on PATH; install bubblewrap to use minibox here.";
    }
    if (platform === "darwin") {
        return "the macOS backend needs /usr/bin/sandbox-exec, which is missing here.";
    }
    return `minibox has no write-sandbox backend for ${platform}.`;
}

/** Report which backend this platform would select, and why it would not. */
export function describeBackendSupport(seams: MiniboxSeams = {}): BackendSupport {
    const platform = (seams.platform ?? (() => process.platform))();
    const isExecutable =
        seams.isExecutable ??
        ((path: string) => {
            try {
                accessSync(path, constants.X_OK);
                return true;
            } catch {
                return false;
            }
        });

    if (platform === "darwin") {
        if (isExecutable(MACOS_SANDBOX_EXEC)) {
            return { supported: true, platform, backend: "macos-seatbelt", executable: MACOS_SANDBOX_EXEC };
        }
        return {
            supported: false,
            platform,
            backend: undefined,
            executable: undefined,
            reason: unavailableMessage(platform),
        };
    }

    if (platform === "linux") {
        const lookup = seams.lookupExecutable ?? ((name: string) => executableFromPath(name));
        const executable = lookup("bwrap");
        if (executable === undefined) {
            return {
                supported: false,
                platform,
                backend: undefined,
                executable: undefined,
                reason: unavailableMessage(platform),
            };
        }
        return { supported: true, platform, backend: "linux-bubblewrap", executable };
    }

    return {
        supported: false,
        platform,
        backend: undefined,
        executable: undefined,
        reason: unavailableMessage(platform),
    };
}

const NO_SESSION_REASON = "No session has started yet, so no canonical project root has been captured.";

const EMPTY_CONFIG: MiniboxConfig = { version: 1, enabled: true, allowWrite: [], denyWrite: [] };

export type BeginSessionInput = {
    readonly cwd: string;
    readonly agentDir: string;
    readonly configPath: string;
};

export class MiniboxController {
    readonly #seams: MiniboxSeams;
    #projectRoot: string | undefined;
    #unsafeRootReason: string | undefined;
    #agentDir = "";
    #configPath = "";
    #config: MiniboxConfig | undefined;
    #problems: readonly string[] = [];
    #notes: readonly string[] = [];
    #sessionOverride: boolean | undefined;
    #grants: string[] = [];
    #profileDir: string | undefined;
    #onReload: ((loaded: LoadedMiniboxConfig) => void) | undefined;

    constructor(seams: MiniboxSeams = {}) {
        this.#seams = seams;
    }

    /** Capture the canonical launch directory for this session. */
    beginSession(input: BeginSessionInput): MiniboxStatus {
        const canonical = this.#canonicalize(input.cwd);
        this.#projectRoot = canonical;
        this.#agentDir = input.agentDir;
        this.#configPath = input.configPath;
        this.#unsafeRootReason = describeUnsafeProjectRoot(canonical, this.#home(), this.#pathSeams());
        this.#sessionOverride = undefined;
        this.#grants = [];
        return this.status();
    }

    /** Apply a freshly loaded config, reporting whether anything changed. */
    applyConfig(configPath: string, loaded: LoadedMiniboxConfig): boolean {
        const changed =
            this.#configPath !== configPath ||
            JSON.stringify(this.#config) !== JSON.stringify(loaded.config) ||
            JSON.stringify(this.#problems) !== JSON.stringify(loaded.problems) ||
            JSON.stringify(this.#notes) !== JSON.stringify(loaded.notes);

        this.#configPath = configPath;
        this.#config = loaded.config;
        this.#problems = loaded.problems;
        this.#notes = loaded.notes;
        return changed;
    }

    /** Notified whenever a reload changed the effective configuration. */
    onReload(handler: (loaded: LoadedMiniboxConfig) => void): void {
        this.#onReload = handler;
    }

    /** Re-read the config file through the supplied loader. */
    reload(configPath: string, load: (path: string) => LoadedMiniboxConfig): boolean {
        const loaded = load(configPath);
        const changed = this.applyConfig(configPath, loaded);
        if (changed) this.#onReload?.(loaded);
        return changed;
    }

    enable(): MiniboxStatus {
        this.#sessionOverride = true;
        return this.status();
    }

    disable(): MiniboxStatus {
        this.#sessionOverride = false;
        return this.status();
    }

    /** Apply a newly persisted default and drop the session override. */
    applyDefault(config: MiniboxConfig): MiniboxStatus {
        this.#config = config;
        this.#sessionOverride = undefined;
        return this.status();
    }

    /** Whether protection is switched on, by default or by hand. */
    isEnabled(): boolean {
        return this.#sessionOverride ?? this.#config?.enabled ?? true;
    }

    /** Remember a path the operator confirmed for this session. */
    addSessionGrant(path: string): void {
        if (!this.#grants.includes(path)) this.#grants.push(path);
    }

    sessionGrants(): readonly string[] {
        return this.#grants;
    }

    configPath(): string {
        return this.#configPath;
    }

    /**
     * The compiled policy while minibox is enforcing, or undefined when it is not.
     *
     * Creating the profile directory is part of building the policy because that
     * directory is denied to everything the sandbox launches: a confined command
     * must not be able to rewrite the profile the next one runs under.
     */
    compiledPolicy(): CompiledPolicy | undefined {
        if (this.#effectiveState() !== "enabled") return undefined;
        return this.#compile().policy;
    }

    /** The current status, recomputed from live evidence. */
    status(): MiniboxStatus {
        const support = describeBackendSupport(this.#seams);
        const state = this.#effectiveState(support);
        const compiled = state === "enabled" ? this.#compile() : undefined;

        return {
            state,
            platform: support.platform,
            backend: support.supported ? support.backend : undefined,
            executable: support.supported ? support.executable : undefined,
            projectRoot: this.#projectRoot,
            agentDir: this.#agentDir,
            configPath: this.#configPath,
            enabledByDefault: this.#config?.enabled ?? true,
            sessionOverride: this.#sessionOverride,
            config: this.#config ?? EMPTY_CONFIG,
            problems: [...this.#problems, ...(compiled?.problems ?? [])],
            notes: [...this.#notes, ...(compiled?.notes ?? [])],
            policy: compiled?.policy,
            reason: this.#reasonFor(state, support),
        };
    }

    /**
     * Decide how to launch one protected operation.
     *
     * Returns an unconfined plan only while minibox is switched off. Once it is
     * on, a missing backend or an unusable project root throws, so the caller
     * never retries the operation outside the sandbox.
     */
    requireLaunchPlan(): LaunchPlan {
        const state = this.#effectiveState();
        if (state === "inactive" || state === "disabled") return { confined: false };
        if (state !== "enabled") throw new MiniboxBlockedError(this.status());

        const policy = this.#compile().policy;
        const digest = createHash("sha256")
            .update(
                JSON.stringify([
                    policy.projectRoot,
                    policy.writable,
                    policy.denied,
                    policy.devices,
                    policy.profileDir,
                ]),
            )
            .digest("hex")
            .slice(0, 16);
        return { confined: true, policy, profilePath: join(this.#ensureProfileDir(), `minibox-${digest}.sb`) };
    }

    /** Drop generated profiles. Idempotent. */
    dispose(): void {
        if (this.#profileDir === undefined) return;
        if (this.#seams.createProfileDir === undefined) {
            rmSync(this.#profileDir, { recursive: true, force: true });
        }
        this.#profileDir = undefined;
    }

    #effectiveState(support = describeBackendSupport(this.#seams)): MiniboxState {
        if (this.#projectRoot === undefined) return "failed";
        if (!this.isEnabled()) return this.#sessionOverride === false ? "disabled" : "inactive";
        if (this.#unsafeRootReason !== undefined) return "failed";
        if (!support.supported) return "unavailable";
        return "enabled";
    }

    #reasonFor(state: MiniboxState, support: BackendSupport): string {
        switch (state) {
            case "inactive":
                return support.supported
                    ? "minibox is available but switched off by default; use /minibox on for this session, or /minibox default on to persist it."
                    : `minibox is switched off by default, and no backend is available: ${support.reason}`;
            case "disabled":
                return "a human switched minibox off for this session with /minibox off.";
            case "unavailable":
                return `${support.supported ? "" : support.reason} Run /minibox off to work unconfined on purpose.`;
            case "failed":
                return this.#unsafeRootReason ?? NO_SESSION_REASON;
            case "enabled":
                return `writes are confined to ${this.#projectRoot ?? ""}, ${this.#agentDir}, temp, and the configured paths.`;
        }
    }

    #compile(): ReturnType<typeof compilePolicy> {
        const config = this.#config;
        return compilePolicy({
            platform: (this.#seams.platform ?? (() => process.platform))(),
            projectRoot: this.#projectRoot ?? "",
            home: this.#home(),
            agentDir: this.#agentDir,
            configPath: this.#configPath,
            allowWrite: config?.allowWrite ?? [],
            denyWrite: config?.denyWrite ?? [],
            sessionPaths: this.#grants,
            profileDir: this.#ensureProfileDir(),
            seams: this.#pathSeams(),
            ...(this.#seams.tempDirs === undefined ? {} : { tempDirs: this.#seams.tempDirs }),
        });
    }

    #pathSeams(): PathSeams {
        const canonicalize = this.#seams.canonicalize;
        return canonicalize === undefined ? {} : { canonicalize };
    }

    #canonicalize(path: string): string {
        return canonicalizePath(path, this.#pathSeams());
    }

    #home(): string {
        return (this.#seams.home ?? homedir)();
    }

    #ensureProfileDir(): string {
        if (this.#profileDir === undefined) {
            const create = this.#seams.createProfileDir ?? (() => mkdtempSync(join(tmpdir(), "pi-minibox-")));
            this.#profileDir = create();
            mkdirSync(this.#profileDir, { recursive: true });
        }
        return this.#profileDir;
    }
}
