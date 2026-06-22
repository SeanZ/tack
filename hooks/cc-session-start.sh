#!/bin/bash
# tack SessionStart hook for Claude Code
# - Reads JSON from stdin (has session_id, transcript_path, source, etc.)
# - Reverse-looks up the task that owns this session uuid; if found (i.e. a
#   resumed, already-linked session), injects its brief into the context.
# - New, not-yet-linked sessions inject nothing (you link by working on a task,
#   e.g. `tack note <id> ...`).
# - stdout is injected into the CC session as context.
# - stderr / non-zero exit is non-blocking for SessionStart.

set -e

INPUT=$(cat)

# require jq for safe JSON parsing
if ! command -v jq >/dev/null 2>&1; then
  echo "[tack] jq not found, hook skipped" >&2
  exit 0
fi

TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
if [ -z "$TRANSCRIPT" ]; then
  exit 0
fi

UUID=$(basename "$TRANSCRIPT" .jsonl)

# resolve tack binary: prefer PATH, fall back to wrapper location
TACK_BIN=$(command -v tack || true)
if [ -z "$TACK_BIN" ]; then
  TACK_BIN="$HOME/.local/bin/tack"
fi
if [ ! -x "$TACK_BIN" ]; then
  echo "[tack] CLI not found, hook skipped" >&2
  exit 0
fi

# which task owns this session? (first column of `tack which`)
TASK=$("$TACK_BIN" which "$UUID" 2>/dev/null | head -1 | cut -f1)
if [ -n "$TASK" ]; then
  # stdout here is injected into the model's context → give it the full task brief
  echo "[tack] this session belongs to task $TASK. Brief:"
  "$TACK_BIN" brief "$TASK" 2>/dev/null || true
fi

exit 0
