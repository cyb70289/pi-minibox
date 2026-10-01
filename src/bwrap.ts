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
 * A deny path that does not exist has no mount point, so it is bound with
 * `--ro-bind-try`, which skips it and creates nothing. minibox never writes to
 * the host on the operator's behalf; the only deny rules left are internal
 * paths that always exist, so this is a backstop rather than a normal case. An
 * absent *writable* path cannot be bound either: the policy has already dropped
 * it and told the operator to create it.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

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

/** A planned bubblewrap invocation. */
export type BwrapPlan = {
    readonly file: string;
    readonly fileArgs: readonly string[];
};

/** Build the bubblewrap argv for a compiled policy. */
export function buildBwrapArgs(
    bwrapPath: string,
    policy: CompiledPolicy,
    execPath: string,
    execArgs: readonly string[],
): BwrapPlan {
    const args: string[] = ["--ro-bind", "/", "/", "--dev", "/dev"];

    for (const path of writableDirs(policy)) {
        // A missing writable root cannot be bound. `--bind-try` skips it, which
        // refuses writes there rather than granting them; the policy has
        // already dropped missing allow entries and reported them.
        args.push(existsSync(path) ? "--bind" : "--bind-try", path, path);
    }

    for (const path of writableFiles(policy)) {
        if (existsSync(path)) args.push("--bind", path, path);
    }

    // Denies are mounted last, so they win. A deny with no mount point is left
    // for `--ro-bind-try` to skip; nothing is ever created to mount onto.
    for (const path of [...denyDirs(policy), ...denyFiles(policy)]) {
        args.push(existsSync(path) ? "--ro-bind" : "--ro-bind-try", path, path);
    }

    args.push("--", execPath, ...execArgs);
    return { file: bwrapPath, fileArgs: args };
}
