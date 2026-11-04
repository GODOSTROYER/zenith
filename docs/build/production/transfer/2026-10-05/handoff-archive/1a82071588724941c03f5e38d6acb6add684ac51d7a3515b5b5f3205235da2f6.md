# WS-SECRET-SYNC — deliver secret VALUES to workloads, safely

Workstream: WS-SECRET-SYNC (new; orchestrator brief) — Branch ws/secret-sync — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-secret-sync
Base: platform/integration (platform composed end to end; tsc clean)

## Situation (verify each in code)
- Manifests reference secrets as `vault:…` refs (src/lib/resources/expand.ts makes `secret/<key>-<digest>`
  nodes; src/lib/secrets/** is Zenith's secret store: backend.ts, file-backend.ts, pg-backend.ts, refs.ts).
- Cloud drivers create secret CONTAINERS only (AWS Secrets Manager secret with no value; Azure Key
  Vault secret seeded empty with `syncSecretValue` helper in src/lib/providers/azure/secrets.ts; GCP
  Secret Manager secret; OCI vault secret with a placeholder and `secret.write` op disabled until sealed
  runner bodies exist; Kubernetes renders Secrets with no data and takes an injected `resolveSecret`).
- The execution activities deliberately do NOT sync values (the deploy role has no
  GetSecretValue/PutSecretValue). So today a deployed workload starts WITHOUT its secret values.
- Generated credentials (`vault:generated/<env>/<address>/password|connection-uri`, used by the
  Kubernetes data renderers and the Zenith-managed Neon adapter via a `ConnectionSecretSink`) have
  no resolver/sink implementation in the store.
- Capability `secret.write` exists in the catalog (high risk, environment scope).

## Objective
After infrastructure apply and before workloads roll, every secret node with a `vault:` ref gets its
current value written into the environment's cloud secret container, under a narrowly scoped,
brokered `secret.write` grant, with the value never leaving process memory (never in workflow
payloads, events, evidence, logs or errors); generated credentials are created once and stable.

## Owned paths
src/lib/secrets/** (resolver + `vault:generated` create-once/stable + a ConnectionSecretSink) ;
NEW src/lib/execution/secrets.ts (the sync step) called from the existing deploy activity path in
src/lib/execution/release.ts (`deployWorkloads` runs the sync first — do NOT change workflow
definitions) ; provider writers as NEW files: src/lib/providers/aws/secret-writer.ts (PutSecretValue on
exactly the node's secret ARN), src/lib/providers/gcp/secret-writer.ts (AddSecretVersion),
reuse azure/secrets.ts `syncSecretValue`, kubernetes `resolveSecret` wiring; OCI stays refused with a
clear reason ; src/lib/credentials/** ONLY to add a `secret.write` session purpose/policy if the broker
lacks one (additive) ; deploy/aws bootstrap template: a separate secret-writer role scoped to
`zenith/<env>/*` secrets (if the bootstrap lives in deploy/aws/**) ; tests/secrets/**,
tests/execution/secrets*.test.ts (new), tests/providers/*/secret-writer*.test.ts (new).
Do NOT edit src/lib/providers/aws/drivers/** (WS-DRIVER-FIX), src/lib/execution/{plan,steps,platform}.ts
(WS-APPROVAL-FLOW), or src/lib/workflows/definitions/**.

## Rules
- Values: read from the store inside the activity, written inside a brokered session callback,
  dropped immediately; idempotent by content hash (no write when unchanged, compared without
  logging); version ids may be recorded, values never.
- The write grant names exactly the secret resources of this environment; cross-environment or
  foreign-workspace refs are refused.
- Failures are classified (denied/throttled/unreachable) and the deploy step fails BEFORE workloads
  roll; a partial sync is reported as partial, never as done.
- Canary tests: a canary secret value never appears in any persisted row, event, evidence, log
  line, workflow input/output or error.

## Verification
- npx tsc --noEmit ; npx eslint src/lib/secrets src/lib/execution/secrets.ts src/lib/execution/release.ts src/lib/providers tests/secrets tests/execution
- npx vitest run --maxWorkers=2 tests/secrets tests/execution tests/platform tests/security
