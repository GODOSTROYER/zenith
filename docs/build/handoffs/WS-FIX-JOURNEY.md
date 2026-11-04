# WS-FIX-JOURNEY — Staging fix: the real-OpenTofu deploy journey test vs immutable plan binding

Workstream: WS-FIX-JOURNEY (orchestrator brief) — Branch ws/fix-journey — worktree Z:/Projects/Spawned.ai/zenith-wt/ws-fix-journey
Base: ws/integrate-w6 @ ec3176f = platform/integration + every wave-6 workstream (destroy engine/workflow,
approval rounds, secret sync, Manifest V2 store, GCP/Azure release ports, AWS SNS/EBS/EKS, OCI compute/OKE,
Azure/GCP machine transports, workload identity trust). 19 other Codex jobs run in parallel on disjoint
paths; stay inside your owned paths and report any needed outside change precisely (file, line, change).

## Pinned cross-job contracts (do not change their shape; other jobs code against them)
- C1 teardown (non-OpenTofu providers): `teardownKubernetesEnvironment(input)` in
  src/lib/providers/kubernetes/teardown.ts and `teardownZenithEnvironment(input)` in
  src/lib/providers/zenith/teardown.ts, both
  `(input: { workspaceId: string; environmentId: string; session: unknown; retainStateful: boolean;
  dryRun?: boolean; signal?: AbortSignal }) => Promise<{ deleted: string[]; retained: string[];
  skipped: string[]; uncertain: string[] }>` (object refs as `kind/namespace/name`).
- C2 product action id `env.teardown`, input `{ environmentId: string }`, human-only, browser session;
  its plan returns the destroy-plan summary (counts, stateful deletes, retained) and requiresApproval.
- C3 src/lib/platform/source-bundle.ts exports `createSourceBundles(deps)` returning
  `{ read(source: { repo: string; ref: string; dockerfile?: string }, signal?: AbortSignal):
  Promise<{ archive: Uint8Array; sha256: string; bytes: number }>; port: SourceBundlePort }`;
  `port.prepare` uploads to S3 (aws session) or GCS (gcp session) and returns
  `{ s3Key, digest, bucket }` plus additive `{ objectKey, uri }`.
- C4 src/lib/runners/read-jobs.ts exports `enqueueReadJob(input: { workspaceId: string;
  environmentId: string; runnerId: string; capability: string; kind: RunnerJobKind; payload: unknown;
  grant: string; timeoutSec?: number; maxOutputBytes?: number })` (no operation; capability must be
  non-mutating) and reuses the existing await API for results.
- C5 TofuFragment gains optional `ephemeral?: Record<string, Record<string, unknown>>` rendered as
  OpenTofu `ephemeral` blocks; drivers pass secrets to write-only `*_wo` arguments only.

## Problem
tests/execution/journey.test.ts (~219) re-plans with `activities.planInfrastructure` in the SAME operation
after apply to prove the apply converged; WS-APPROVAL-FLOW made an operation's recorded plan digest
immutable (correct: an approval is bound to one plan), so it now fails `plan_changed`, and the two later
tests fail with `Another operation holds env:env-journey` (lease left held by the aborted first test).
## Do
Keep the immutability rule. Prove convergence the realistic way: a NEW operation for the same revision
(`newOperation(...)` helper) plans and gets `empty: true`. Make lease cleanup robust in `finally` so one
failing test cannot poison the next. Owned: tests/execution/journey.test.ts only.

## Verification
- ZENITH_TEST_TOFU_NETWORK=1 npx vitest run --maxWorkers=1 tests/execution/journey.test.ts (real tofu; say if it cannot run)
- Run vitest only on your suites with `--maxWorkers=1`; whole-repo `npx tsc --noEmit` at most twice.
- tofu/opa/go/temporal may be blocked in your sandbox: say so; never claim a check you did not run.
