# WS-DESTROY-PROPOSE — Teardown from the product: action, trusted destroy proposal, workflow start

Workstream: WS-DESTROY-PROPOSE (orchestrator brief) — Branch ws/destroy-propose — worktree Z:/Projects/Spawned.ai/zenith-wt/ws-destroy-propose
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
1. Product action `env.teardown` (C2) in src/lib/actions/defs/env.ts (or a new defs file registered in
   defs/index.ts): plan = server-side destroy plan summary; execute = propose `infrastructure.destroy`
   with TRUSTED evidence: the broker loads the reviewed destroy-plan facts/digest from the recorded
   `tofu_plan` evidence server-side, validates workspace/environment and `destroy: true`, binds them into
   the immutable proposal (extend ProposeContext additively; keep Broker facade signatures).
2. After human approval (browser-only), the bridge claims execution and calls `startDestroy`
   (src/lib/workflows/client.ts). Destroy approval status returns a real human approval id.
3. src/lib/execution/destroy.ts: for providers without OpenTofu (kubernetes, zenith) call the C1
   teardown functions (being written by other jobs; import by the pinned names and test with fakes);
   OpenTofu providers keep the existing destroy path.
4. Wire WS-DB-LEDGER's `denyOperation` into the capability store port so a policy denial at execution
   records `denied` instead of the cancel fallback (src/lib/capabilities/ports.ts, execution.ts).
5. Agents (integration/navigator) can never propose or approve teardown (test).
Owned: src/lib/actions/defs/env.ts (+ new defs file), src/lib/actions/defs/index.ts, src/lib/capabilities/**,
src/lib/platform/broker.ts, src/lib/bridge/**, src/lib/execution/destroy.ts, tests for these.

## Verification
- npx tsc --noEmit; npx vitest run --maxWorkers=1 tests/capabilities tests/actions tests/bridge tests/execution tests/platform
- Run vitest only on your suites with `--maxWorkers=1`; whole-repo `npx tsc --noEmit` at most twice.
- tofu/opa/go/temporal may be blocked in your sandbox: say so; never claim a check you did not run.
