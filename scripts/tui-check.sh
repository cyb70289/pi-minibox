#!/bin/bash
# Manual TUI verification for pi-minibox. Not part of `npm test`: it drives a
# real Pi session in tmux and needs a configured model.
#
#   scripts/tui-check.sh            start a session and print what to do next
#   scripts/tui-check.sh --auto     run the scripted checks and report
#
# Gotchas this script exists to encode:
#   * Pi must run directly in the pane. Piping or redirecting its stdout makes
#     it a non-TTY and it exits immediately with no output.
#   * The confirm dialog defaults to "Yes", so Enter approves and Escape denies.
#   * tmux keeps ~2000 lines of history by default, so counting dialog titles in
#     the scrollback is only reliable early in a session. Use the log instead.
set -uo pipefail

SOCKET=minibox-tui-check
SESSION=mb
CWD=${MINIBOX_TUI_CWD:-$(pwd)}
EXT=$(cd "$(dirname "$0")/.." && pwd)
PROBE=${MINIBOX_TUI_PROBE:-$HOME/minibox-tui-probe.txt}
PANE_LOG=/tmp/minibox-tui-check-pane.log

tmux() { command tmux -L "$SOCKET" "$@"; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
capture() { tmux capture-pane -p -S -4000 2>/dev/null; }

wait_for() {
    local pattern=$1 timeout=${2:-180} started
    started=$(date +%s)
    while true; do
        capture | grep -qF -- "$pattern" && return 0
        if [ $(( $(date +%s) - started )) -gt "$timeout" ]; then
            log "TIMEOUT waiting for: $pattern"
            capture | tail -30
            return 1
        fi
        sleep 2
    done
}

start() {
    tmux kill-session -t "$SESSION" 2>/dev/null
    : >"$PANE_LOG"
    tmux new-session -d -s "$SESSION" -x 220 -y 50 "cd '$CWD' && pi -ne -e '$EXT'"
    wait_for "minibox on" 90 || wait_for "$" 30
    log "session started in $CWD (startup notice should read: minibox on)"
}

stop() {
    tmux send-keys -t "$SESSION" -l -- "/quit" 2>/dev/null
    tmux send-keys -t "$SESSION" Enter 2>/dev/null
    sleep 3
    tmux kill-session -t "$SESSION" 2>/dev/null
}

ask() {
    tmux send-keys -t "$SESSION" -l -- "$1"
    sleep 1
    tmux send-keys -t "$SESSION" Enter
    log "asked: $1"
}

key() { tmux send-keys -t "$SESSION" "$1"; }

check() {
    local label=$1 expected=$2 actual=$3
    if [ "$expected" = "$actual" ]; then
        log "PASS  $label"
    else
        log "FAIL  $label (expected '$expected', got '$actual')"
    fi
}

auto() {
    rm -f "$PROBE"
    start

    ask "Use the write tool with path exactly $PROBE and content 'first'. Do nothing else."
    if wait_for "minibox: write outside the project?" 120; then
        log "PASS  dialog appears for a write outside the project"
        key Enter
        sleep 25
        check "approval writes the file" yes "$(test -f "$PROBE" && echo yes || echo no)"
        check "file content" first "$(cat "$PROBE" 2>/dev/null)"

        local before after
        before=$(grep -c "write outside the project?" "$PANE_LOG" 2>/dev/null || true)
        ask "Use the write tool with path exactly $PROBE and content 'second'. Do nothing else."
        sleep 25
        after=$(grep -c "write outside the project?" "$PANE_LOG" 2>/dev/null || true)
        check "no second dialog for an approved path" "$before" "$after"
        check "second write landed" second "$(cat "$PROBE" 2>/dev/null)"
    else
        log "FAIL  no dialog appeared"
    fi

    ask "Run this bash command: echo nope > $PROBE.outside ; then quote the exact error."
    sleep 25
    check "bash write outside the project is refused" no "$(test -f "$PROBE.outside" && echo yes || echo no)"

    ask "/minibox"
    sleep 5
    log "report captured above; check it lists the project, the rules, and the session grant"

    log "now: quit (done automatically), then rerun with --continue to check persistence"
    stop
    rm -f "$PROBE.outside"
}

case "${1:-}" in
    --auto) auto ;;
    --stop) stop; log "session stopped" ;;
    --quit) tmux send-keys -t "$SESSION" -l -- "/quit"; tmux send-keys -t "$SESSION" Enter; log "quit requested" ;;
    *)
        start
        cat <<EOF

Session is running in tmux socket "$SOCKET" (attach with: tmux -L $SOCKET attach -t $SESSION).

Try:
  1. "Use the write tool to create $PROBE with content 'x'."
     -> a minibox dialog appears; Enter approves, Escape denies.
  2. Repeat step 1. -> no dialog: the approval is remembered for the session.
  3. "Run: echo nope > $PROBE.outside" -> refused with "Operation not permitted".
  4. /minibox -> full rules report.
  5. Quit, then "pi -c" and repeat step 1 -> still no dialog.
  6. /minibox off, repeat step 3 -> the write now succeeds. /minibox on restores it.

Stop the session: scripts/tui-check.sh --stop   (or tmux -L $SOCKET kill-server)
EOF
        ;;
esac
