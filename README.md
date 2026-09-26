# pi-minibox

A minimal **write-only** sandbox for Pi's foreground tools: macOS Seatbelt
(`sandbox-exec`) and Linux bubblewrap (`bwrap`). Reads and network are never
restricted. Writes are allowed under the project you launched from, `~/.pi`,
temp, `/dev` character devices, and whatever you list in `minibox.json` —
everything else is refused by the kernel, or asks you first.

There is no launcher. Pi keeps being started normally.

```sh
# try it without installing
pi -e /path/to/pi-minibox

# or install it
pi install /path/to/pi-minibox
```

## What is confined

| Surface | Mechanism | Outside the writable set |
| --- | --- | --- |
| built-in `bash` tool | kernel sandbox around the child process | write syscall refused (`Operation not permitted`) |
| your `!` / `!!` commands | same | same |
| built-in `write` tool | in-process guard at the tool call | confirmation box, 60s |
| built-in `edit` tool | same | same |

`write` and `edit` change files inside Pi's own process, where there is no child
to wrap — but there *is* someone to ask, so those two ask. `bash` cannot ask:
the kernel decides at `write()` time. A refused bash write fails with an error
that tells the model to use the `write` tool if it wants permission.

**Not confined:** Pi's own process, `pi.exec` calls made by other extensions,
other extensions' in-process writes, MCP servers, and background/subagent
processes that follow their own sandbox policy. This is a tool-execution
sandbox, not a boundary around Pi.

## Writable set

Always writable, whether or not you configure anything:

| Path | Why |
| --- | --- |
| the project root you launched Pi from | your work lives here |
| `~/.pi` | Pi's own agent directory |
| `/private/var/folders`, `/private/tmp` (macOS) · `/tmp`, `/var/tmp` (Linux) | `mktemp`, compilers, package managers |
| `~/.pi/agent/minibox.json` — **the one exception** | hard-denied, so nothing sandboxed can grant itself more |

macOS additionally allows the character devices a shell needs
(`/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/tty`, `/dev/pts`,
`/dev/fd`, `/dev/std*`, `/dev/shm`) and nothing else under `/dev`, so block
devices like `/dev/disk*` are not writable. On Linux `--dev /dev` mounts a fresh
minimal devtmpfs, so host block devices do not exist inside the sandbox at all.

`denyWrite` rules beat every one of these, including the project root.

## `minibox.json`

Created on first run at `~/.pi/agent/minibox.json` (i.e. `$PI_CODING_AGENT_DIR`):

```json
{
  "version": 1,
  "enabled": true,
  "allowWrite": ["~/.npm/", "~/.cache/", "~/.local/", "~/.bun/", "~/.cargo/",
                 "~/.gradle/", "~/.m2/", "~/.rustup/", "~/.deno/"],
  "denyWrite": [".env", ".env.local", ".git/hooks"]
}
```

Entry rules:

- `~` means your home directory, an absolute path is taken as written, and
  anything else is **relative to whichever project the session is in**. One
  global file therefore behaves per-project.
- Rules are **concrete paths**. `*.log` and `src/**/x` are rejected with a clear
  error rather than silently matching nothing on macOS and silently matching too
  much on Linux (bubblewrap can only mount a real directory, so a pattern there
  would have to grant its whole static prefix).
- A **directory** rule covers its whole subtree. A trailing `/` says "this is a
  directory" before it exists; `out/**` is the same rule.
- A bare entry that does not exist yet is a **single file**, not a directory.
- Directory-shaped entries that do not exist are created (`mkdir -p`) so that
  both backends grant the same thing. That is a visible side effect: if you add
  `~/scratch/`, minibox creates `~/scratch` on the next session.
- Paths are canonicalized, so a symlink cannot widen a rule or slip past a deny.
- The file is re-read when it changes, so an edit applies to the next write.

If the file cannot be parsed, its rules are dropped, the built-in rules stay in
force, and the problem is reported — a typo never widens access.

## Commands

```text
/minibox                  show state, backend, project, writable and denied rules
/minibox on               confine protected writes for this session
/minibox off              stop confining them for this session
/minibox default on       confine now and persist it in minibox.json
/minibox default off      stop now and persist it
```

The footer shows `minibox on` while minibox is enforcing, and nothing otherwise.
`/minibox` is always the full answer. No model-callable tool can switch minibox
off or add a rule: the model can only ask, through `write`/`edit`.

## The confirmation box

```
 minibox: write outside the project?
 path:    /Users/you/notes/idea.md
 this is a new file, and its parent directories will be created
 project: /Users/you/code/thing
 config:  ~/.pi/agent/minibox.json

 Yes allows this path for the rest of the session. minibox.json is never changed.  (60s)
```

- **Yes** allows that path for the rest of the session and remembers it in the
  session's own transcript, so it survives `pi -c` without ever touching
  `minibox.json`. A directory you approve covers its subtree; approving a file
  does not grant its siblings.
- **No**, Escape, and the 60s timeout all mean the same thing: the write is
  blocked, nothing is written, and the model is told exactly that.
- Denials are **not** remembered, so a retry asks again instead of silently
  hammering a path you already refused.
- Approving a path also makes it writable for `bash` in that session, since the
  approval is part of the policy the sandbox profiles are built from.
- Without an interactive UI (JSON/print modes) there is nobody to ask, so the
  write is blocked instead of allowed.
- The path shown, checked, and written are the same canonical path, so a symlink
  swapped in after the check cannot redirect the write.

## When minibox cannot enforce

It fails closed and says so, rather than reporting `on` while writes sail
through:

| State | Meaning | Protected writes |
| --- | --- | --- |
| `inactive` | the default is off | run unconfined |
| `enabled` | a backend resolved and the project root is usable | confined |
| `disabled` | you ran `/minibox off` | run unconfined |
| `unavailable` | no backend on this platform (e.g. Linux without `bwrap`) | **blocked** |
| `failed` | no session yet, or launched from `/` or your whole home directory | **blocked** |

Launching from `/` or `$HOME` fails on purpose: confining writes to those would
protect nothing, so minibox refuses to pretend.

## Verification status

**macOS: verified against the real kernel.** 138 unit tests plus real
`sandbox-exec` runs (allow/deny by filesystem effect, deny-beats-allow, single
file whitelist, profile-directory protection, `/dev/null`, no `/dev/disk*`,
a confined child process), and a live tmux session proving: no prompt inside the
project, prompt outside, "Yes" writes and remembers, second write to the same
path does not prompt, "No" and the 60s timeout block with the exact message the
model sees, `/minibox off` and `on` take effect immediately, `default on|off`
persists, and an approval survives `pi -c` while a new path still prompts.

**Linux: TODO — not kernel-verified yet.** The argv builder is unit-tested, and
`test/linux-bwrap.integration.test.ts` is a real kernel check that self-skips
without `bwrap`. To close this out, run it on a Linux machine:

```sh
sudo apt install bubblewrap   # or: sudo dnf install bubblewrap
npm test                      # the suite named "linux bubblewrap kernel enforcement" should run, not skip
```

Two Linux details that only that run can settle: whether `/dev/pts` is present
under `--dev` (if not, the fix is one `--dev-bind /dev/pts /dev/pts`), and
whether unprivileged user namespaces are enabled on the host.

## Development

```sh
npm install
npm run typecheck
npm test                       # unit tests + real macOS kernel tests
scripts/tui-check.sh           # manual: drives a real Pi session in tmux
```

Layout: `index.ts` wires the extension; `src/config.ts` owns `minibox.json`;
`src/policy.ts` turns rules into writable/denied sets; `src/seatbelt.ts` and
`src/bwrap.ts` generate the two backends; `src/state.ts` owns session state;
`src/guard.ts` is the `write`/`edit` guard and the dialog; `src/shell.ts` wraps
the bash child.
