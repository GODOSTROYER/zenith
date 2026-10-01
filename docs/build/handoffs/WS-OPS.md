# WS-OPS — housekeeping passes and worker health

Workstream: WS-OPS (new; orchestrator brief) — Branch ws/ops — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-ops
Base: platform/integration

## Situation (verify in code)
- Control-store maintenance functions exist but nothing schedules them: `repos.idempotency.prune`,
  `repos.nonces.prune` (only the runner pg-store wires a nonce prune), `operations.reconcileOperations` /
  `markUncertainExpired` / `expireOverdue` (lapsed running operations → uncertain; overdue proposals
  expire). WS-COMPOSE added a `reapExpiredJobs` pass (check src/lib/server/cron.ts and tick.yml).
- Plan files from plan-only or abandoned operations stay in the worker's plan dir forever (WS-ACT note).
- The Temporal worker (workers/execution/worker.ts, startup.ts) has no health/readiness endpoint.

## Owned paths
src/lib/server/cron.ts (add passes; keep existing ones) ; .github/workflows/tick.yml (add passes) ;
NEW src/lib/platform/housekeeping.ts ; NEW workers/execution/health.ts + minimal wiring in
workers/execution/worker.ts ; NEW src/lib/execution/plan-janitor.ts (only reads/deletes files in the
configured plan dir; never touches state) ; tests/server/cron*.test.ts, tests/platform/housekeeping*.test.ts,
tests/workers/** (new).
Do NOT edit src/lib/platform/app.ts (WS-OBS-WIRE) or src/lib/execution/{plan,steps,platform}.ts.

## Build
- Passes (idempotent, bounded per run, safe to overlap via a lease): prune idempotency keys and
  nonces past their windows; expire overdue proposals; mark lapsed running operations uncertain
  (never failed/succeeded); janitor plan files older than N hours whose operation is terminal.
- Worker health: `/healthz` (process up) and `/readyz` (Temporal connected, platform store reachable,
  policy bundle loaded, drivers registered) on a configurable local port, no secrets in output.
- Tests with PGlite and fake clocks; janitor never deletes a plan of a non-terminal operation.

## Verification
- npx tsc --noEmit ; npx eslint src/lib/server/cron.ts src/lib/platform/housekeeping.ts src/lib/execution/plan-janitor.ts workers tests/server tests/platform tests/workers
- npx vitest run --maxWorkers=2 tests/server tests/platform tests/workers tests/controlplane
