/**
 * Low-level path rules shared by the config, policy, and backend modules.
 *
 * minibox talks about canonical paths everywhere. A canonical path is what the
 * kernel will actually act on, so resolving symlinks before any comparison is
 * what keeps an alias from widening a writable root or slipping past a deny.
 * A path that does not exist yet still has to canonicalize, so its longest
 * existing ancestor is resolved and the remaining components are re-appended.
 */

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Injectable filesystem dependencies so path logic is testable without a disk. */
export type PathSeams = {
    /** Defaults to `fs.realpathSync`. Must throw when the path does not exist. */
    canonicalize?: (path: string) => string;
};

/**
 * Resolve `path` to an absolute canonical path.
 *
 * Symlinks are resolved through the longest existing ancestor, so a target that
 * has not been created yet canonicalizes through its real parent chain instead
 * of failing.
 */
export function canonicalizePath(path: string, seams: PathSeams = {}): string {
    const canonicalize = seams.canonicalize ?? realpathSync;
    const absolute = resolve(path);
    try {
        return canonicalize(absolute);
    } catch {
        // Not created yet (or unreadable): canonicalize the parent instead.
    }
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(canonicalizePath(parent, seams), basename(absolute));
}

/** True when `target` is `root` itself or lies inside it. */
export function contains(root: string, target: string): boolean {
    if (target === root) return true;
    return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Expand a leading `~` against the home directory. Only `~` and `~/...` are
 * special; a `~user` form is left alone because it means something else.
 */
export function expandHome(entry: string, home: string): string {
    if (entry === "~") return home;
    if (entry.startsWith(`~${sep}`) || entry.startsWith("~/")) return resolve(home, entry.slice(2));
    return entry;
}

/** Resolve a config entry (`~`, absolute, or project-relative) without canonicalizing. */
export function resolveEntryPath(entry: string, projectRoot: string, home: string): string {
    const expanded = expandHome(entry, home);
    return isAbsolute(expanded) ? expanded : resolve(projectRoot, expanded);
}

/** What a resolved path currently is on disk. */
export type PathKind = "directory" | "file" | "missing";

/**
 * Classify a path without creating anything.
 *
 * This is deliberately not seam-injectable: existence is the one fact the
 * policy cannot be told about, because a fabricated answer would decide what
 * the kernel is allowed to mount.
 */
export function pathKind(path: string): PathKind {
    try {
        const stats = statSync(path);
        if (stats.isDirectory()) return "directory";
        return "file";
    } catch {
        return "missing";
    }
}
