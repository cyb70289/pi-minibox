/**
 * The effective minibox policy: which paths are writable, which stay denied,
 * and how a config entry turns into a concrete rule.
 *
 * The rule set is deliberately small and absolute:
 *
 *   writable = project root + `~/.pi` + temp + `/dev` + `allowWrite` + session grants
 *   denied   = the config file itself and the generated profile directory,
 *              so nothing confined can widen or rewrite its own policy
 *
 * An allow entry that does not exist is not granted: minibox never creates
 * files on the operator's behalf, so the entry stays inactive and why is
 * reported instead.
 *
 * Entry syntax is concrete paths only. `~` means home, a relative entry means
 * "relative to whichever project this session is in", and a directory entry
 * covers its subtree. Mid-path wildcards are rejected rather than accepted on
 * macOS and silently widened on Linux, where bubblewrap can only mount a real
 * directory and would have to bind the pattern's static prefix.
 */

import { sep } from "node:path";

import {
    canonicalizePath,
    contains,
    pathKind,
    resolveEntryPath,
    type PathKind,
    type PathSeams,
} from "./paths.ts";

/**
 * Character devices a shell genuinely needs on macOS, where the sandbox cannot
 * substitute a fresh devfs for the host one. Host block devices are simply not
 * in this list, so `/dev/disk0` and friends stay non-writable without any
 * pattern matching or name enumeration.
 */
export const MACOS_DEVICE_ALLOWLIST: readonly string[] = Object.freeze([
    "/dev/null",
    "/dev/zero",
    "/dev/random",
    "/dev/urandom",
    "/dev/tty",
    "/dev/pts",
    "/dev/fd",
    "/dev/stdin",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/shm",
]);

/** Where a rule came from, so the status view can explain itself. */
export type WriteSource = "project" | "baseline" | "config" | "session" | "device" | "builtin";

/** One resolved rule. `form` decides whether the subtree or just the path is covered. */
export type WriteEntry = {
    readonly path: string;
    readonly form: "dir" | "file";
    readonly source: WriteSource;
    /** The config text this came from, when it came from the config or a session grant. */
    readonly template?: string;
};

/** A policy with every path canonicalized, sorted, deduplicated, and absorbed. */
export type CompiledPolicy = {
    readonly platform: string;
    readonly projectRoot: string;
    readonly home: string;
    readonly agentDir: string;
    readonly configPath: string;
    readonly writable: readonly WriteEntry[];
    readonly denied: readonly WriteEntry[];
    readonly devices: readonly string[];
    /** Directory holding generated profiles; denied so nothing can rewrite its own confinement. */
    readonly profileDir?: string;
};

/** Why a write target is or is not permitted. */
export type AccessDecision =
    | { readonly allowed: true; readonly path: string }
    | {
          readonly allowed: false;
          readonly path: string;
          readonly reason: "denied" | "outside-writable";
          /** The rule that refused the write, for `denied`. */
          readonly deniedBy?: string;
      };

export type CompilePolicyInput = {
    readonly platform: string;
    readonly projectRoot: string;
    readonly home: string;
    readonly agentDir: string;
    readonly configPath: string;
    readonly allowWrite: readonly string[];
    readonly sessionPaths?: readonly string[];
    /**
     * Overrides the platform temp directories. Tests use this to keep their own
     * fixtures out of the real temp tree, which is usually a writable baseline.
     */
    readonly tempDirs?: readonly string[];
    /** Added by the controller when it has a place to write profiles. */
    readonly profileDir?: string;
    readonly seams?: PathSeams;
};

export type CompiledPolicyResult = {
    readonly policy: CompiledPolicy;
    /** Entries that were dropped, and why. Shown to the operator. */
    readonly problems: readonly string[];
    /** Entries that were kept but deserve a comment. */
    readonly notes: readonly string[];
};

const PATTERN_CHARACTERS = /[*?[\]{}]/;

/** Directory-form marker: a trailing `/**` is the same rule as the directory itself. */
function stripSubtreeMarker(template: string): { template: string; explicitDir: boolean } {
    for (const marker of [`${sep}**`, "/**", "/", sep]) {
        if (!template.endsWith(marker)) continue;
        const stripped = template.slice(0, -marker.length);
        // A bare "/" must stay "/" so it is recognized as the root, not as an
        // empty entry that would quietly resolve to the project root.
        if (stripped !== "") return { template: stripped, explicitDir: true };
    }
    return { template, explicitDir: false };
}

type ResolvedEntry = { readonly entry: WriteEntry; readonly note?: string };

/**
 * Turn one config template into a concrete rule.
 *
 * An entry that resolves to the filesystem root is refused, because it would
 * present minibox as active while protecting nothing.
 */
function resolveTemplate(
    template: string,
    options: {
        readonly projectRoot: string;
        readonly home: string;
        readonly source: WriteSource;
        readonly seams: PathSeams;
    },
): ResolvedEntry | { readonly problem: string } {
    const trimmed = template.trim();
    if (trimmed === "") return { problem: "An empty path entry was ignored." };

    const stripped = stripSubtreeMarker(trimmed);
    if (PATTERN_CHARACTERS.test(stripped.template)) {
        return {
            problem: `"${template}" is a pattern; minibox rules are concrete paths only, so it was ignored.`,
        };
    }

    const resolvedPath = resolveEntryPath(stripped.template, options.projectRoot, options.home);
    const canonical = canonicalizePath(resolvedPath, options.seams);
    if (canonical === sep) {
        return {
            problem: `"${template}" resolves to the filesystem root and would make minibox meaningless; it was ignored.`,
        };
    }

    const kind: PathKind = pathKind(canonical);
    const form: WriteEntry["form"] = stripped.explicitDir || kind === "directory" ? "dir" : "file";
    const entry: WriteEntry = { path: canonical, form, source: options.source, template };

    const notes: string[] = [];
    if (canonical === options.home || contains(canonical, options.home)) {
        notes.push(`"${template}" covers the home directory (${canonical}); every write under home is now allowed.`);
    }
    return notes.length === 1 ? { entry, note: notes[0] as string } : { entry };
}

/** Baseline writable directories that are not the project or the config's business. */
export function baselineDirectories(platform: string): string[] {
    if (platform === "darwin") return ["/private/var/folders", "/private/tmp"];
    if (platform === "linux") return ["/tmp", "/var/tmp"];
    return [];
}

export function macosDeviceAllowlist(): readonly string[] {
    return MACOS_DEVICE_ALLOWLIST;
}

/**
 * Collapse rules that say the same thing twice.
 *
 * Duplicates keep the broader form, and anything already covered by a directory
 * rule is dropped, so the generated profile names each rule once.
 */
export function normalizeEntries(entries: readonly WriteEntry[]): WriteEntry[] {
    const byPath = new Map<string, WriteEntry>();
    for (const entry of entries) {
        const previous = byPath.get(entry.path);
        if (previous === undefined || (previous.form === "file" && entry.form === "dir")) {
            byPath.set(entry.path, entry);
        }
    }

    const sorted = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    const directories = sorted.filter((entry) => entry.form === "dir");
    return sorted.filter(
        (entry) => !directories.some((directory) => directory !== entry && contains(directory.path, entry.path)),
    );
}

/** Directory-form rules, for backends that mount subtrees. Sorted for stable output. */
export function writableDirs(policy: CompiledPolicy): string[] {
    return policy.writable
        .filter((entry) => entry.form === "dir")
        .map((entry) => entry.path)
        .sort();
}

/** File-form writable rules, sorted. */
export function writableFiles(policy: CompiledPolicy): string[] {
    return policy.writable
        .filter((entry) => entry.form === "file")
        .map((entry) => entry.path)
        .sort();
}

/** Directory-form denied rules, sorted. */
export function denyDirs(policy: CompiledPolicy): string[] {
    return policy.denied
        .filter((entry) => entry.form === "dir")
        .map((entry) => entry.path)
        .sort();
}

/** File-form denied rules, sorted. */
export function denyFiles(policy: CompiledPolicy): string[] {
    return policy.denied
        .filter((entry) => entry.form === "file")
        .map((entry) => entry.path)
        .sort();
}

/**
 * Compile the config plus the built-in rules plus this session's grants into the
 * one policy every surface enforces.
 */
export function compilePolicy(input: CompilePolicyInput): CompiledPolicyResult {
    const seams = input.seams ?? {};
    const problems: string[] = [];
    const notes: string[] = [];

    const writable: WriteEntry[] = [
        { path: canonicalizePath(input.projectRoot, seams), form: "dir", source: "project" },
        { path: canonicalizePath(input.agentDir, seams), form: "dir", source: "baseline" },
        ...(input.tempDirs ?? baselineDirectories(input.platform)).map((path) => ({
            path: canonicalizePath(path, seams),
            form: "dir" as const,
            source: "baseline" as const,
        })),
    ];

    const addWritable = (template: string, source: WriteSource): void => {
        const result = resolveTemplate(template, {
            projectRoot: input.projectRoot,
            home: input.home,
            source,
            seams,
        });
        if ("problem" in result) {
            problems.push(result.problem);
            return;
        }
        if (result.note !== undefined) notes.push(result.note);
        // A rule for a path that does not exist cannot be applied without
        // creating that path, and minibox never writes on the operator's
        // behalf. The entry stays inactive until it is created, and says so.
        if (pathKind(result.entry.path) === "missing") {
            notes.push(`"${template}" does not exist yet; it is not writable until it is created.`);
            return;
        }
        writable.push(result.entry);
    };

    for (const template of input.allowWrite) addWritable(template, "config");
    for (const template of input.sessionPaths ?? []) addWritable(template, "session");

    const denied: WriteEntry[] = [
        { path: canonicalizePath(input.configPath, seams), form: "file", source: "builtin" },
    ];
    const profileDir = input.profileDir === undefined ? undefined : canonicalizePath(input.profileDir, seams);
    if (profileDir !== undefined) {
        denied.push({ path: profileDir, form: "dir", source: "builtin" });
    }

    return {
        problems,
        notes,
        policy: {
            platform: input.platform,
            projectRoot: canonicalizePath(input.projectRoot, seams),
            home: input.home,
            agentDir: canonicalizePath(input.agentDir, seams),
            configPath: canonicalizePath(input.configPath, seams),
            writable: normalizeEntries(writable),
            denied: normalizeEntries(denied),
            devices: input.platform === "darwin" ? MACOS_DEVICE_ALLOWLIST : [],
            ...(profileDir === undefined ? {} : { profileDir }),
        },
    };
}

/**
 * Decide whether one write target is permitted.
 *
 * Denies are consulted first so a rule always beats the writable root it sits
 * inside. The canonical path is returned so callers act on the path that was
 * actually checked.
 */
export function evaluateWriteAccess(
    target: string,
    policy: CompiledPolicy,
    seams: PathSeams = {},
): AccessDecision {
    const path = canonicalizePath(target, seams);

    for (const rule of policy.denied) {
        if (contains(rule.path, path)) return { allowed: false, path, reason: "denied", deniedBy: rule.path };
    }
    for (const rule of policy.writable) {
        if (contains(rule.path, path)) return { allowed: true, path };
    }
    for (const device of policy.devices) {
        if (contains(device, path)) return { allowed: true, path };
    }
    return { allowed: false, path, reason: "outside-writable" };
}

/**
 * Explain why a launch directory is too broad to confine, or return undefined.
 *
 * Confining writes to `/` or to the whole home directory would present minibox
 * as active while protecting nothing that matters, so those launches fail
 * closed instead of silently granting everything.
 */
export function describeUnsafeProjectRoot(
    projectRoot: string,
    home: string,
    seams: PathSeams = {},
): string | undefined {
    const canonicalRoot = canonicalizePath(projectRoot, seams);
    const canonicalHome = canonicalizePath(home, seams);
    if (canonicalRoot !== sep && canonicalRoot !== canonicalHome) return undefined;
    return [
        `minibox will not treat ${canonicalRoot} as a writable project root:`,
        "it is broad enough that confining writes to it would protect nothing.",
        "Relaunch pi from the directory you are actually working in, or turn minibox off on purpose with /minibox off.",
    ].join(" ");
}
