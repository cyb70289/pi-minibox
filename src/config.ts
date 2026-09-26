/**
 * minibox.json: the one user-editable file that decides what minibox allows.
 *
 * This module owns the file's shape and its lifecycle only. What an entry
 * *means* — `~`, project-relative, directory-vs-file, glob rejection, unsafe
 * roots — belongs to `policy.ts`, so there is exactly one place where a rule is
 * interpreted.
 *
 * The file is created on first use with the packaged defaults, because a
 * default that only exists in source is a default the operator cannot see or
 * change. A file that exists but cannot be parsed is never rewritten: minibox
 * falls back to the safest interpretation and says so.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Format version of the config file. */
export const MINIBOX_CONFIG_VERSION = 1;

/** Basename of the config file inside Pi's agent directory. */
export const MINIBOX_CONFIG_BASENAME = "minibox.json";

/**
 * Development caches every package manager writes outside a project. They are
 * seeded so a first `npm install` is not a wall of denied writes, and they are
 * ordinary entries: deleting one is a supported thing to do.
 */
export const DEFAULT_ALLOW_WRITE: readonly string[] = Object.freeze([
    "~/.npm",
    "~/.cache",
    "~/.local",
    "~/.bun",
    "~/.cargo",
    "~/.gradle",
    "~/.m2",
    "~/.rustup",
    "~/.deno",
]);

/**
 * Paths that stay non-writable even inside the project. The packaged defaults
 * mirror the ones a shell-level write guard usually needs: secrets and the
 * directory git will execute hooks from.
 */
export const DEFAULT_DENY_WRITE: readonly string[] = Object.freeze([".env", ".env.local", ".git/hooks"]);

/** The parsed contents of `minibox.json`. */
export type MiniboxConfig = {
    readonly version: number;
    readonly enabled: boolean;
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
};

/** The config minibox uses when no file exists yet. */
export function defaultMiniboxConfig(): MiniboxConfig {
    return {
        version: MINIBOX_CONFIG_VERSION,
        enabled: true,
        allowWrite: DEFAULT_ALLOW_WRITE,
        denyWrite: DEFAULT_DENY_WRITE,
    };
}

/** The config file path for a given Pi agent directory. */
export function miniboxConfigPath(agentDir: string): string {
    return join(agentDir, MINIBOX_CONFIG_BASENAME);
}

/** Filesystem seams so config handling is testable without a real home. */
export type ConfigSeams = {
    readFile?: (path: string) => string;
    writeFile?: (path: string, contents: string) => void;
    exists?: (path: string) => boolean;
    /** Creates the directory that will hold the file. Defaults to `mkdir -p`. */
    ensureDir?: (path: string) => void;
};

/** A loaded config plus everything questionable found while loading it. */
export type LoadedMiniboxConfig = {
    readonly config: MiniboxConfig;
    /**
     * Statements about the file's shape that made minibox drop or replace
     * something. The operator is shown these; none of them are fatal.
     */
    readonly problems: readonly string[];
    /** Observations that did not change a value, such as an unknown key. */
    readonly notes: readonly string[];
    /** True when this load created the file. */
    readonly seeded: boolean;
    /** True when the file existed but could not be parsed. */
    readonly malformed: boolean;
};

/** Raised when a write to the config file would destroy unparseable content. */
export class MiniboxConfigWriteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MiniboxConfigWriteError";
    }
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readText(path: string, seams: ConfigSeams): string {
    return seams.readFile ? seams.readFile(path) : readFileSync(path, "utf-8");
}

function writeText(path: string, contents: string, seams: ConfigSeams): void {
    const write = seams.writeFile ?? writeFileSync;
    const ensureDir = seams.ensureDir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
    ensureDir(dirname(path));
    write(path, contents);
}

/** Serialize a config the way this module writes it: stable, readable, newline-terminated. */
export function serializeMiniboxConfig(config: MiniboxConfig): string {
    return `${JSON.stringify(config, null, 2)}\n`;
}

function parseConfigObject(raw: unknown): { config: MiniboxConfig; problems: string[]; notes: string[] } {
    const problems: string[] = [];
    const notes: string[] = [];
    const defaults = defaultMiniboxConfig();

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return {
            config: { ...defaults, allowWrite: [], denyWrite: [] },
            problems: ["minibox.json must contain a JSON object; using no write rules from it."],
            notes,
        };
    }

    const source = raw as Record<string, unknown>;
    const known = new Set(["version", "enabled", "allowWrite", "denyWrite"]);
    for (const key of Object.keys(source)) {
        if (!known.has(key)) notes.push(`minibox.json has an unknown key "${key}"; it is ignored.`);
    }

    if (source.version !== undefined && source.version !== MINIBOX_CONFIG_VERSION) {
        notes.push(
            `minibox.json declares version ${String(source.version)}; this build reads version ${MINIBOX_CONFIG_VERSION}.`,
        );
    }

    let enabled = defaults.enabled;
    if (source.enabled !== undefined) {
        if (typeof source.enabled === "boolean") {
            enabled = source.enabled;
        } else {
            problems.push(`minibox.json "enabled" must be true or false; using ${String(defaults.enabled)}.`);
        }
    }

    const readList = (key: "allowWrite" | "denyWrite"): string[] => {
        const value = source[key];
        if (value === undefined) return [...defaults[key]];
        if (!isStringArray(value)) {
            problems.push(`minibox.json "${key}" must be an array of path strings; ignoring it.`);
            return [];
        }
        return value;
    };

    return { config: { version: MINIBOX_CONFIG_VERSION, enabled, allowWrite: readList("allowWrite"), denyWrite: readList("denyWrite") }, problems, notes };
}

/**
 * Load `minibox.json`, creating it with the packaged defaults when it is absent.
 *
 * A malformed or wrongly shaped file never widens access: the rules it could not
 * express are dropped, the built-in rules still apply, and the problems are
 * reported.
 */
export function loadMiniboxConfig(configPath: string, seams: ConfigSeams = {}): LoadedMiniboxConfig {
    const exists = seams.exists ?? existsSync;
    if (!exists(configPath)) {
        const config = defaultMiniboxConfig();
        writeText(configPath, serializeMiniboxConfig(config), seams);
        return { config, problems: [], notes: [], seeded: true, malformed: false };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(readText(configPath, seams));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            config: { ...defaultMiniboxConfig(), allowWrite: [], denyWrite: [] },
            problems: [`minibox.json could not be parsed (${message}); using no write rules from it.`],
            notes: [],
            seeded: false,
            malformed: true,
        };
    }

    const parsed = parseConfigObject(raw);
    return { config: parsed.config, problems: parsed.problems, notes: parsed.notes, seeded: false, malformed: false };
}

/**
 * Persist the enabled default, preserving every other field and unknown key.
 *
 * Refuses to touch a file it cannot parse, so a typo in a hand-edited file is
 * never quietly replaced by a rewritten one.
 */
export function setMiniboxEnabled(configPath: string, enabled: boolean, seams: ConfigSeams = {}): MiniboxConfig {
    const exists = seams.exists ?? existsSync;
    if (!exists(configPath)) {
        const config: MiniboxConfig = { ...defaultMiniboxConfig(), enabled };
        writeText(configPath, serializeMiniboxConfig(config), seams);
        return config;
    }

    let raw: unknown;
    try {
        raw = JSON.parse(readText(configPath, seams));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new MiniboxConfigWriteError(
            `Refusing to rewrite ${configPath}: it could not be parsed (${message}). Fix or delete it first.`,
        );
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new MiniboxConfigWriteError(`Refusing to rewrite ${configPath}: it does not contain a JSON object.`);
    }

    const updated = { ...(raw as Record<string, unknown>), version: MINIBOX_CONFIG_VERSION, enabled };
    writeText(configPath, serializeMiniboxConfig(updateDefaults(updated)), seams);
    return parseConfigObject(updated).config;
}

function updateDefaults(source: Record<string, unknown>): MiniboxConfig {
    const defaults = defaultMiniboxConfig();
    return {
        ...source,
        version: MINIBOX_CONFIG_VERSION,
        enabled: typeof source.enabled === "boolean" ? source.enabled : defaults.enabled,
        allowWrite: isStringArray(source.allowWrite) ? source.allowWrite : [...defaults.allowWrite],
        denyWrite: isStringArray(source.denyWrite) ? source.denyWrite : [...defaults.denyWrite],
    } as MiniboxConfig;
}
