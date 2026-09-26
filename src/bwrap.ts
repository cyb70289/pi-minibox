/**
 * Linux bubblewrap backend.
 *
 * `bwrap` builds a mount namespace, so confinement is expressed as mounts rather
 * than as a rule list:
 *
 *   --ro-bind / /            every path stays readable, nothing is writable
 *   --dev /dev               a fresh, minimal devtmpfs replaces the host device
 *                            tree, so host block devices do not exist inside at
 *                            all -- no `/dev/nvme*` enumeration required
 *   --bind <root> <root>     one read-write bind per writable root
 *   --ro-bind <deny> <deny>  denies are mounted last, so they win
 *   -- <shell> -c <command>
 *
 * Mounts are applied in order and the last one wins, which is why denies are
 * appended after every writable bind.
 *
 * A deny path that does not exist yet has no mount point. `--ro-bind-try` would
 * skip it and silently not deny anything, so an absent denied path inside a
 * writable region is materialized as an empty file first, exactly as the
 * reference implementation does. An absent *writable* path cannot be granted;
 * it is skipped, which fails closed, and reported.
 */

import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

import { denyDirs, denyFiles, writableDirs, writableFiles, type CompiledPolicy } from "./policy.ts";

/** The bubblewrap executable name resolved from PATH. */
export const BWRAP_EXECUTABLE = "bwrap";

/** Injectable filesystem dependencies so argv planning is testable off Linux. */
export type BwrapSeams = {
    readonly exists?: (path: string) => boolean;
    /** Creates a placeholder for a denied path. Returns whether it exists afterwards. */
    readonly materializeDenyPath?: (path: string) => boolean;
};

/** A planned bubblewrap invocation, plus the writable rules it could not apply. */
export type BwrapPlan = {
    readonly file: string;
    readonly fileArgs: readonly string[];
    /** Writable file rules that do not exist yet, so no mount could grant them. */
    readonly inactiveWritablePaths: readonly string[];
};

/**
 * Create an empty regular file so an absent denied path has something to deny.
 *
 * `O_EXCL` means anything that appears in the meantime is left alone. An empty
 * file is the least destructive placeholder: a later `cp .env.example .env` can
 * overwrite it, where an empty directory at the same path could not.
 */
export function materializeDenyPath(path: string): boolean {
    if (existsSync(path)) return true;
    try {
        mkdirSync(dirname(path), { recursive: true });
        closeSync(openSync(path, "wx"));
        return true;
    } catch {
        // Re-check rather than trust the errno: another writer winning the race
        // is the outcome we wanted anyway.
        return existsSync(path);
    }
}

/** True when a denied path lies somewhere bubblewrap binds read-write. */
function insideWritableRegion(path: string, policy: CompiledPolicy): boolean {
    return writableDirs(policy).some((root) => path === root || path.startsWith(`${root}/`)) ||
        writableFiles(policy).includes(path);
}

/** Build the bubblewrap argv for a compiled policy. */
export function buildBwrapArgs(
    bwrapPath: string,
    policy: CompiledPolicy,
    execPath: string,
    execArgs: readonly string[],
    seams: BwrapSeams = {},
): BwrapPlan {
    const exists = seams.exists ?? existsSync;
    const materialize = seams.materializeDenyPath ?? materializeDenyPath;
    const args: string[] = ["--ro-bind", "/", "/", "--dev", "/dev"];
    const inactiveWritablePaths: string[] = [];

    for (const path of writableDirs(policy)) {
        // A missing writable root cannot be bound. `--bind-try` skips it, which
        // refuses writes there rather than granting them.
        args.push(exists(path) ? "--bind" : "--bind-try", path, path);
    }

    for (const path of writableFiles(policy)) {
        if (!exists(path)) {
            inactiveWritablePaths.push(path);
            continue;
        }
        args.push("--bind", path, path);
    }

    const denyPaths = [...denyDirs(policy), ...denyFiles(policy)];
    for (const path of denyPaths) {
        const mountable = exists(path) || (insideWritableRegion(path, policy) && materialize(path));
        // `-try` remains for paths that are read-only regardless, and for the
        // ones that could not be created -- which are paths the confined process
        // cannot create either.
        args.push(mountable ? "--ro-bind" : "--ro-bind-try", path, path);
    }

    if (policy.profileDir !== undefined) {
        args.push("--ro-bind-try", policy.profileDir, policy.profileDir);
    }

    args.push("--", execPath, ...execArgs);
    return { file: bwrapPath, fileArgs: args, inactiveWritablePaths };
}
