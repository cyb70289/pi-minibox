# pi-minibox

> Deliberately simple sandbox: built for smooth agent work,
> guarding against accidents, not adversaries.

A write sandbox for Pi. It uses macOS Seatbelt (`sandbox-exec`) or
Linux bubblewrap (`bwrap`). Reads and network access are unrestricted.

This extension adds no info to system prompt.

```sh
pi -e /path/to/pi-minibox      # try without installing
pi install /path/to/pi-minibox # install
```

Linux requires `bwrap` on `PATH` **and** permission to create a sandbox. If
Ubuntu's user-namespace restrictions prevent it from running, `/minibox`
reports the failure and a remedy.

## What it covers

- Built-in `bash` and operator `!` / `!!` commands run in a kernel sandbox.
  Writes outside allowed paths fail; they cannot prompt for permission.
- Built-in `write` and `edit` are guarded in Pi's process. Writes outside allowed
  paths ask for confirmation. Approval is remembered for the session (including
  `pi -c`) and makes the path writable to shell commands once it exists; it
  does not change the config. Refusal, timeout, or no interactive UI blocks the
  write.
- Pi itself, other extensions (including their `pi.exec` calls), MCP servers,
  and independently managed background/subagent processes are **not** confined.

By default, writable paths include the directory Pi was launched from (the
project root), Pi's agent directory, temp directories, and the paths seeded in
`minibox.json`. Linux also leaves `/proc` and `/sys` writable: commands can
change accessible kernel or process state there. The config file and generated
sandbox profiles are always write-denied to protected tools, even inside an
allowed directory.

## Configuration

On first run, minibox creates `minibox.json` in Pi's agent directory
(normally `~/.pi/agent/minibox.json`). Edit it outside the protected tools to
change `enabled`, `allowWrite`, or Linux-only `allowDevices`. The seeded arrays
include development caches and Linux GPU device patterns; replacing an array
replaces its defaults. Changes take effect on the next protected operation.
`/minibox` shows effective rules and any invalid or inactive entries.

- `allowWrite` paths may be absolute, `~/...`, or relative to the project root.
  A directory covers its subtree; use a trailing `/` for a directory that does
  not exist yet. Use concrete paths, not globs.
- Missing `allowWrite` entries add no permission until you create the path.
  Paths are canonicalized, so symlinks cannot widen a rule. A malformed config
  drops its configurable rules, not the built-in policy.
- On Linux, use `allowDevices` for host `/dev` character devices, not
  `allowWrite`. Entries can be exact paths or filename prefixes ending in `*`
  (for example, `/dev/dri/*`). No host block devices or device directories are
  mounted; an empty array mounts no host devices.

```text
/minibox              show status and rules
/minibox on|off       change protection for this session
/minibox default on   enable now and persist the default
/minibox default off  disable now and persist the default
```

Only the operator can change minibox state with these commands; the model cannot
switch it off. If protection is on but cannot be enforced (missing backend, unusable `bwrap`,
or launch from `/` or your home directory), protected writes are **blocked**,
not run unconfined. `/minibox off` explicitly opts out.

## Code and checks

`index.ts` registers the hooks and command. `src/config.ts`, `src/policy.ts`,
`src/paths.ts`, and `src/state.ts` handle config, rules, paths, and session state.
`src/guard.ts` handles file-tool confirmation; `src/shell.ts` and
`src/seatbelt.ts` / `src/bwrap.ts` wrap shell commands.

```sh
npm install
npm run verify # typecheck and tests, including platform kernel checks
```
