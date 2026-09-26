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

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

import { denyDirs, denyFiles, writableDirs, writableFiles, type CompiledPolicy } from "./policy.ts";

/** The bubblewrap executable name resolved from PATH. */
export const BWRAP_EXECUTABLE = "bwrap";

/** How to obtain the bubblewrap package on the common Linux distributions. */
export const BWRAP_INSTALL_HINT =
    "install bubblewrap: `sudo apt install bubblewrap` (Debian/Ubuntu), `sudo dnf install bubblewrap` (Fedora), `sudo pacman -S bubblewrap` (Arch), or `sudo zypper install bubblewrap` (openSUSE)";

/**
 * Why an installed `bwrap` can still refuse to start, and how to fix it.
 *
 * Ubuntu 24.04 and newer ship `kernel.apparmor_restrict_unprivileged_userns=1`,
 * which lets AppArmor deny user-namespace creation to binaries that no profile
 * grants `userns`. A `bwrap` in that state exits with "setting up uid map:
 * Permission denied" and would otherwise look installed and healthy.
 */
export const BWRAP_USERNS_HINT =
    "This is usually Ubuntu 24.04+ restricting unprivileged user namespaces with AppArmor: run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` for a temporary fix, or install an AppArmor profile for /usr/bin/bwrap that grants `userns` to keep the restriction scoped to bwrap.";

/** The result of asking the kernel to actually build one minimal sandbox. */
export type BwrapProbe = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The smallest sandbox that proves bubblewrap can create a mount and user
 * namespace here: the same read-only root and fresh device tree the real launch
 * uses, running a no-op shell.
 */
export const BWRAP_PROBE_ARGS: readonly string[] = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--",
    "/bin/sh",
    "-c",
    "exit 0",
];

/**
 * Run one minimal confined command and report whether the kernel allowed it.
 *
 * A `bwrap` that is on PATH but cannot create a namespace would otherwise be
 * reported as a usable backend and then fail every command, so this is the
 * difference between a resolved backend and a working one. The probe is tiny;
 * callers cache the answer instead of re-running it per status repaint.
 */
export function probeBwrap(executable: string, timeoutMs = 10_000): BwrapProbe {
    const result = spawnSync(executable, [...BWRAP_PROBE_ARGS], { encoding: "utf-8", timeout: timeoutMs });
    if (result.error !== undefined) return { ok: false, reason: result.error.message };
    if (result.status === 0) return { ok: true };
    const stderr = (result.stderr ?? "").trim();
    return { ok: false, reason: stderr === "" ? `bwrap exited with status ${result.status}` : stderr };
}

/** True when a probe failure looks like the kernel refusing a user namespace. */
export function isUserNamespaceFailure(reason: string): boolean {
    return /uid map|new namespace|user namespace|unshare/i.test(reason);
}

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
