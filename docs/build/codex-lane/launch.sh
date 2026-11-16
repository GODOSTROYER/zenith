#!/usr/bin/env bash
# Launch one Codex job for a workstream: launch.sh <WS-ID> <worktree-dir-name>
# Builds the prompt from PREAMBLE.md + the workstream's handoff note, runs
# gpt-6.1-sol at xhigh in a workspace-write sandbox rooted at the worktree,
# and writes the JSONL event log and the final message next to this script.
set -euo pipefail
WS="$1"
WT="$2"
SCRATCH="C:/Users/user/AppData/Local/Temp/claude/Z--Projects-Spawned-ai/5e97a1aa-a341-43fb-821c-9424d9f61a81/scratchpad"
DIR="$SCRATCH/codex"
NOTE="$SCRATCH/handoffs/$WS.md"
ROOT="Z:/Projects/Spawned.ai/zenith-wt/$WT"
[ -f "$NOTE" ] || { echo "missing handoff note $NOTE" >&2; exit 2; }
[ -d "$ROOT" ] || { echo "missing worktree $ROOT" >&2; exit 2; }
PROMPT="$DIR/$WS.prompt.md"
{
  cat "$DIR/PREAMBLE.md"
  echo
  echo "Worktree: $ROOT"
  echo
  cat "$NOTE"
  if [ -f "$DIR/$WS.extra.md" ]; then echo; echo "# Orchestrator notes added after the handoff"; cat "$DIR/$WS.extra.md"; fi
} > "$PROMPT"
cd "$ROOT"
exec codex exec \
  -m gpt-6.1-sol \
  -c model_reasoning_effort=xhigh \
  -s workspace-write \
  --add-dir "Z:/Projects/Spawned.ai/zenith-wt/platform/node_modules" \
  --add-dir "C:/Users/user/AppData/Local/Temp" \
  -C "$ROOT" \
  --json \
  -o "$DIR/$WS.final.md" \
  - < "$PROMPT" > "$DIR/$WS.events.jsonl" 2> "$DIR/$WS.stderr.log"
