#!/usr/bin/env bash
# Latest Codex rate-limit snapshot from the newest session rollouts.
for f in $(ls -t ~/.codex/sessions/*/*/*/*.jsonl 2>/dev/null | head -12); do
  r=$(grep -o '"primary":{"used_percent":[0-9.]*,"window_minutes":[0-9]*,"resets_at":[0-9]*' "$f" | tail -1)
  if [ -n "$r" ]; then
    used=$(echo "$r" | grep -o 'used_percent":[0-9.]*' | cut -d: -f2)
    reset=$(echo "$r" | grep -o 'resets_at":[0-9]*' | cut -d: -f2)
    echo "codex weekly window used: ${used}%  resets: $(date -u -d @"$reset" '+%Y-%m-%d %H:%M UTC')  (from $(basename "$f"))"
    exit 0
  fi
done
echo "no rate-limit snapshot found"
