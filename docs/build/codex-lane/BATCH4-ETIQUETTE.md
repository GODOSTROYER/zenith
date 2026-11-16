## Shared machine — resource etiquette (20 Codex jobs run in parallel on 22 CPUs / 31 GB — memory is tight)
- Run vitest only on the suites you own or touch, always with `--maxWorkers=1`. Never run the
  whole `npx vitest run` suite.
- Run whole-repo `npx tsc --noEmit` at most three times (it costs ~3 GB RAM); prefer it at the end.
- Other Codex jobs are editing other paths of this repository in their own worktrees at the same
  time. Stay strictly inside your owned paths; if you need a change elsewhere, do not make it —
  write the exact change (file, lines, reason) in your final report for the orchestrator.
- Binaries such as `tofu`, `opa` and `go` may be blocked by your sandbox. If one cannot run, say so
  plainly in the report (the orchestrator re-runs those checks outside the sandbox); never claim it ran.
