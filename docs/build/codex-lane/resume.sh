#!/usr/bin/env bash
# Resume a Codex job in its original session: resume.sh <WS-ID> <worktree-dir-name> [prompt-file]
# Without a prompt file it sends the network-drop nudge; with one, that file is the follow-up prompt.
# Stops the stalled process for that worktree, then `codex exec resume <thread>` with a nudge,
# same model/effort/sandbox. The worktree path appears in the command line (writable_roots),
# so monitor.ps1 still recognises the job. Events/stderr are appended to the same files.
set -euo pipefail
WS="$1"
WT="$2"
DIR="C:/Users/user/AppData/Local/Temp/claude/Z--Projects-Spawned-ai/5e97a1aa-a341-43fb-821c-9424d9f61a81/scratchpad/codex"
ROOT="Z:/Projects/Spawned.ai/zenith-wt/$WT"
THREAD=$(head -c 400 "$DIR/$WS.events.jsonl" | grep -o '"thread_id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$THREAD" ] || { echo "no thread id for $WS" >&2; exit 2; }
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | Where-Object { \$_.CommandLine -match 'zenith-wt/$WT(\s|\$)' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
NUDGE="The network connection dropped and your previous turn was interrupted mid-work. Nothing on disk was lost. Continue the same job from where you stopped: re-check \`git status\` and the files you were editing, finish every remaining item of the handoff checklist, run the verification commands, and end with the required final report (files changed, every command with exact pass/fail counts, what remains, deviations)."
if [ -n "${3:-}" ]; then NUDGE="$(cat "$3")"; rm -f "$DIR/$WS.final.md" "$DIR/$WS.reported"; fi
cd "$ROOT"
exec codex exec resume "$THREAD" \
  -m gpt-6.1-sol \
  -c model_reasoning_effort=xhigh \
  -c sandbox_mode='"workspace-write"' \
  -c "sandbox_workspace_write.writable_roots=[\"$ROOT\",\"Z:/Projects/Spawned.ai/zenith-wt/platform/node_modules\",\"C:/Users/user/AppData/Local/Temp\"]" \
  --json \
  -o "$DIR/$WS.final.md" \
  "$NUDGE" >> "$DIR/$WS.events.jsonl" 2>> "$DIR/$WS.stderr.log"
