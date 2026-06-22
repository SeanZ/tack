#!/bin/bash
# tack SessionEnd hook for Claude Code
# - Reads JSON from stdin (has session_id, transcript_path, reason, etc.)
# - Reverse-looks up the task that owns this session uuid; if found, writes a
#   best-effort digest. (Primary digest paths are `show` lazy-gen and archive;
#   this just catches sessions that do end cleanly.)
# - stdout for SessionEnd only goes to debug log; stderr shown to user.

set -e

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi

UUID=$(basename "$TRANSCRIPT" .jsonl)

TACK_BIN=$(command -v tack || true)
if [ -z "$TACK_BIN" ]; then
  TACK_BIN="$HOME/.local/bin/tack"
fi
if [ ! -x "$TACK_BIN" ]; then
  exit 0
fi

TASK=$("$TACK_BIN" which "$UUID" 2>/dev/null | head -1 | cut -f1)
if [ -n "$TASK" ]; then
  "$TACK_BIN" digest \
    --task "$TASK" \
    --session "$UUID" \
    --transcript "$TRANSCRIPT" >/dev/null 2>&1 || true
fi

exit 0
