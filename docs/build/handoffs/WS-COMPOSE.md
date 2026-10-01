# WS-COMPOSE — composition roots: wire the real control plane into the worker and the app

Workstream: WS-COMPOSE (new; written by the orchestrator)
Branch: ws/compose — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-compose
Base: platform/integration @ e5c1518 (all modules below are merged; tsc clean)

## Objective
Every subsystem exists and is unit-tested, but nothing composes them: the Temporal worker
still boots STUB activities (`src/lib/workflows/activities/index.ts` throws `not_implemented`;
`workers/execution/worker.ts` says so) and several app-side runtimes say "wire me at boot".
Build the composition roots so the platform actually runs end to end, and prove it with an
end-to-end deploy workflow test that uses real activities against local stores and mocked clouds.

Read first: docs/platform/ARCHITECTURE.md, docs/adr/0005,0006,0007,0009, docs/platform/EXECUTION-WORKER.md,
and the module barrels + module-top comments of every piece you wire (listed below).

Owned paths (create/edit): src/lib/platform/** (NEW: composition roots), workers/execution/**,
src/lib/workflows/activities/index.ts (replace the stubs with a thin delegation to the composed
activities; keep the stub factory available only for tests), src/lib/server/boot.ts (ONLY to call
the app-side composition once, guarded and failure-tolerant), .github/workflows/tick.yml (ONLY to add
the reconcile pass once its route is wired), tests/platform/**. Do NOT edit other modules; if a
module needs a change, make the smallest additive change and list it in your report.

## What to build
1. `src/lib/platform/credentials.ts` — `platformCredentialBroker(db)`: AwsCredentialBroker
   (src/lib/credentials/aws) with a ConnectionResolver over `repos.connections`, an event sink that
   appends CredentialEventDraft as platform events via `repos.events`, and
   `runnerTransport: createRunnerAwsTransportFactory()` (src/lib/runners/aws-runner-transport.ts).
   Add a provider router so GCP (`createGcpSession`, src/lib/providers/gcp/credentials.ts) and Azure
   (`createAzureSession`, src/lib/providers/azure/credentials.ts) connections get sessions too, with
   the subject/assertion minted by `mintWorkloadToken` (src/lib/credentials/oidc). OCI and Kubernetes:
   the Kubernetes session builder in src/lib/providers/kubernetes (credentialRef resolved from the
   Zenith vault in memory only); OCI is runner-only — route to the runner transport or refuse clearly.
2. `src/lib/platform/drivers.ts` — `registerAllDrivers()` idempotent: AWS (until a provider-level
   `registerAwsDrivers()` exists — another job, WS-AWS-INTEGRATE, is creating
   `src/lib/providers/aws/drivers/index.ts` RIGHT NOW: do NOT create that file; register the three
   group arrays `networkDrivers`, `COMPUTE_DRIVERS`, `awsDataDrivers` directly from their group
   indexes), Kubernetes (`registerKubernetesDrivers`), the Zenith-managed provider
   (`registerZenithDrivers` from src/lib/providers/zenith — use THIS one for provider `zenith`, not
   the kubernetes package's `registerZenithManagedDrivers`, and make sure only one set is
   registered under `zenith`), GCP (`registerGcpDrivers`), Azure (`registerAzureDrivers`), OCI
   (`registerOciDrivers`). Test: exactly one driver per (provider, nativeType).
3. `src/lib/platform/execution.ts` — `composeExecutionActivities(opts)`: `createExecutionActivities`
   (src/lib/execution) with `createPlatformPorts(db)`, `createProductPort()`, the credential broker
   from (1), the broker adapter (reevaluate / approvalStatus / issueGrant) over
   `platformBroker()` (src/lib/capabilities/platform.ts — read src/lib/execution/ports.ts for the
   exact port shape), tofu (merged engine; `fingerprintKey` DERIVED from a server secret via HKDF of
   ZENITH_SECRET_KEY with info "zenith.tofu.plan.fingerprint.v1" — refuse to start without it, never
   the public-digest default), `defaultCostPort`, the observability factory
   (`sourcesForEnvironment` + `createObservabilityFabric`), `createSafeProber()`, the AWS CodeBuild /
   ECS deployImage / one-off migration task helpers from the compute drivers (read
   src/lib/providers/aws/drivers/compute/{codebuild-builds,ecs-operations,ecs-task}.ts), and the
   reconcile activity `createReconcileObserveActivity` (src/lib/reconcile/activity.ts) with
   `loadPlatformEnvironment` / `loadGraphFromStore` from src/lib/reconcile/platform.
   `src/lib/workflows/activities/index.ts` → `createActivities(deps)` delegates to it;
   `workers/execution/worker.ts` builds deps from env (platformDb(), Temporal config) and fails fast
   with a clear message when a required piece is unconfigured (signing key, secret key, DB schema behind).
4. `src/lib/platform/app.ts` — app-side composition invoked once from boot: `configureRunnerRuntime`
   with an event sink to `repos.events`; `wireReconcilePorts(() => createPlatformReconcilePorts({...}))`
   with `startRepair` → `startDayTwo` (src/lib/workflows/client.ts); a `reapExpiredJobs` pass added to
   the existing cron passes (src/lib/server/cron.ts exposes the pattern; add the smallest hook) that
   marks owning operations `uncertain`. Everything guarded: when the platform store is not configured
   the app keeps working exactly as before (sandbox/LocalStack paths untouched) and the platform
   routes answer their existing 503s. Then add `reconcile` to `.github/workflows/tick.yml` passes.
5. END-TO-END TEST (the point of this job): tests/platform/deploy-e2e.test.ts — using the Temporal
   test environment helper already in tests/workflows (it starts a local dev server from the
   installed `temporal` CLI on a random port; NEVER use localhost:7233, another project owns it),
   a PGlite platform store, the file product store (tests/_support/data-dir.ts pattern), REAL
   composed activities, a credential broker whose AwsSession clients are aws-sdk-client-mock'd
   (STS, ECS, ELBv2, RDS, CodeBuild, ECR, Route53, ACM, CloudWatch Logs) and a FAKE tofu port (there
   is no AWS account; the real tofu path is covered elsewhere): seed a workspace/project/environment
   (provider aws) + a V1 manifest (web service from image, postgres, route with TLS) + a verified
   ProviderConnection; propose `deployment.deploy` through the broker (policy requires approval in
   production) → approve as a browser-session user → beginExecution → startDeploy → assert the
   workflow runs every step in order, plan evidence + policy decision + approval + grant + events
   are in the platform store, the product Deployment projection shows the steps, verify steps read
   the mocked target health/steady state, and the operation ends `succeeded`. Second scenario:
   the same with a policy `deny` (public database) → no apply call happens. Third: lease lost
   during apply → `uncertain`, never retried.

## Decisions already made (keep them)
- Credentials only inside withSession callbacks; nothing secret in workflow payloads, events, evidence.
- Approval is browser-only and human-only; the model/integration can never approve.
- LocalStack is ON HOLD: do not route anything to it, do not modify src/lib/providers/localstack.
- Evidence levels stay `contract` — nothing here is live.

## Verification commands
- npx tsc --noEmit
- npx eslint src/lib/platform workers/execution src/lib/workflows/activities src/lib/server tests/platform
- npx vitest run tests/platform tests/workflows tests/execution tests/capabilities
- npx vitest run (full suite once at the end; report exact counts)
