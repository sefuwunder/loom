#!/bin/sh
# thinker-fake.sh — deterministic thinker for tests and dry runs.
# Reads the loom context on stdin, prints one JSON action on stdout.
# Behavior is driven by $FAKE_MODE:
#   finish-after-N  — emit N notes, then finish
#   spin            — emit the same exec forever (tests the circuit breaker)
#   learn           — emit exec twice with different commands, then finish
# State is kept in $FAKE_STATE_FILE (defaults to /tmp/loom-fake-state).

STATE="${FAKE_STATE_FILE:-/tmp/loom-fake-state}"
MODE="${FAKE_MODE:-finish-after-2}"
CTX=$(cat)

count=$(cat "$STATE" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$STATE"

case "$MODE" in
  spin)
    printf '{"action":"exec","cmd":"echo same-output","label":"spin"}\n'
    ;;
  learn)
    if [ "$count" -le 2 ]; then
      printf '{"action":"exec","cmd":"echo attempt-%s","label":"learn"}\n' "$count"
    else
      printf '{"action":"finish","summary":"learned and finished"}\n'
    fi
    ;;
  finish-after-*)
    N=$(echo "$MODE" | sed 's/finish-after-//')
    if [ "$count" -le "$N" ]; then
      printf '{"action":"note","text":"fake thought %s"}\n' "$count"
    else
      printf '{"action":"finish","summary":"fake job complete after %s notes"}\n' "$N"
    fi
    ;;
  bigexec-*)
    N=$(echo "$MODE" | sed 's/bigexec-//')
    if [ "$count" -le "$N" ]; then
      printf '{"action":"exec","cmd":"yes | head -c 2000000; echo step-%s","label":"big"}\n' "$count"
    else
      printf '{"action":"finish","summary":"bigexec done"}\n'
    fi
    ;;
  *)
    printf '{"action":"blocked","reason":"unknown FAKE_MODE %s"}\n' "$MODE"
    ;;
esac
