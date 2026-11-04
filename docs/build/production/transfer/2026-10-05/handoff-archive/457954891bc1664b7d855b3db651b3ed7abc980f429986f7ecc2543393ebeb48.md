# WS-OCI-SESSIONS — OCI platform sessions and real OCI log/metric reads

Workstream: WS-OCI-SESSIONS (orchestrator brief) — Branch ws/oci-sessions — worktree Z:/Projects/Spawned.ai/zenith-wt/ws-oci-sessions
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
1. Credential broker (src/lib/platform/credentials.ts ~151 refuses OCI today): build an `OciSession`
   (src/lib/providers/oci/transport.ts) whose transport is `createRunnerOciTransport` dispatching read
   requests via C4 `enqueueReadJob` (written in parallel; import by name) and write requests via the
   operation-scoped runner jobs; one session per capability.
2. src/lib/observability/sources/oci-logging.ts and oci-monitoring.ts: real reads through that session
   (Logging Search, Monitoring summarizeMetricsData), bounded, untrusted text, honest unavailable without a runner.
Owned: src/lib/platform/credentials.ts (OCI branch only; WS-FIX-CREDS edits the purpose line ~161 — keep
changes local), src/lib/credentials/types.ts (additive), src/lib/observability/sources/oci-*.ts, tests for these.

## Verification
- npx vitest run --maxWorkers=1 tests/observability tests/platform
- Run vitest only on your suites with `--maxWorkers=1`; whole-repo `npx tsc --noEmit` at most twice.
- tofu/opa/go/temporal may be blocked in your sandbox: say so; never claim a check you did not run.
