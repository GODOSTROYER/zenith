# WS-EPHEMERAL — Ephemeral values: passwords never in state; enable MySQL create (C5)

Workstream: WS-EPHEMERAL (orchestrator brief) — Branch ws/ephemeral — worktree Z:/Projects/Spawned.ai/zenith-wt/ws-ephemeral
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

## Do
1. C5: TofuFragment `ephemeral` blocks in the workspace assembler (src/lib/tofu/workspace.ts) with the same
   validation discipline (HCL scanner, provider allowlist); OpenTofu 1.12 ephemeral resources and write-only
   `*_wo` arguments (check the exact supported resources, e.g. `ephemeral "random_password"`).
2. Enable MySQL CREATE on Azure (src/lib/providers/azure/drivers/data/mysql*) and OCI
   (src/lib/providers/oci/drivers/data/mysql*) using an ephemeral generated admin password passed to a
   write-only argument, then stored in the vault via the existing secret paths — never in state, plan views
   or evidence. Gated real-tofu validate for both.
Owned: src/lib/tofu/workspace.ts (+ helpers), src/lib/drivers/types.ts (additive), the two MySQL drivers,
tests/tofu/ephemeral*, tests/providers/azure/*mysql*, tests/providers/oci/*mysql*.

## Verification
- npx vitest run --maxWorkers=1 tests/tofu tests/providers/azure tests/providers/oci
- ZENITH_TEST_TOFU_NETWORK=1 for ephemeral + mysql validate tests
- Run vitest only on your suites with `--maxWorkers=1`; whole-repo `npx tsc --noEmit` at most twice.
- tofu/opa/go/temporal may be blocked in your sandbox: say so; never claim a check you did not run.
