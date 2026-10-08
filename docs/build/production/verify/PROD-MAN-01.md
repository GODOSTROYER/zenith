# PROD-MAN-01: Default managed substrate and sessions

Branch `prod/man-01-w5`, base `c02c097e`. Platform migration **48**.

Acceptance (ledger): "Default Zenith session opener/substrate/source build/release composition operates without
manually injected test ports."

Nothing in this document was RUN by the author: the worker rules for this wave forbid running tests, docker, kind or
Postgres. What was run: `npx tsc --noEmit -p .` (clean) and `npx eslint` over every changed file (clean), Node 22.
Every test named below is written, typechecks and has NOT been executed. Live hosted acceptance is deferred; evidence
here is contract-level plus a local kind harness that has not been run.

## 1. What was built

### The stable substrate port (committed first, `b2307bb8`)

`src/lib/providers/zenith/managed-port.ts`, exported from `@/lib/providers/zenith`. MAN-02..05 build on this; extend
the interface and the one implementation, never fork them.

| Member | Meaning |
| --- | --- |
| `status()` | `{ configured, description, build }`: presence and non-secret shape only; `build` is `available` (namespace, builder image) or `unavailable` with the variable to set |
| `substrate()` | the validated `ZenithSubstrate`; throws `ManagedSubstrateError` `not_configured` naming every missing/invalid variable |
| `toolkit` | the Kubernetes provider's render/apply/read/list (`KubernetesToolkit`), shared with the driver registry |
| `tenants` | `TenantResolver`: `{ workspaceId, environmentId }` to `ZenithTenant` (slugs and plan tier come from the control plane) |
| `registry()` | `ManagedRegistryPort` (naming/ownership policy of the Zenith-operated registry) or `undefined` |
| `buildConfig()` | the validated build configuration; throws `build_unavailable` |
| `openSession(req)` / `withSession(req, fn)` | a tenant-pinned `ZenithSession` (existing type, `session.ts`): Kubernetes session scoped to the tenant namespace, a separate gateway-namespace session in `gateway_api` mode, the managed-database port. A request names ONLY the workspace and environment (plus an optional `databases` port from `databaseRuntime`) |
| `databaseRuntime(input)` | the managed-database port and the workload secret resolver for one environment, bound to its vault scope |
| `withBuildSession(req, fn)` | a session for the platform build namespace only; never a tenant namespace |

Failure is always `ManagedSubstrateError` with a stable `code`: `not_configured`, `tenant_unresolved`, `tenant_invalid`,
`credential_unavailable`, `session_refused`, `registry_unavailable`, `registry_refused`, `build_unavailable`,
`build_refused`. Messages are fixed and never echo a credential, a reference or a provider error body.

### New and changed files

Provider layer, no environment reads (`src/lib/providers/zenith/`):
`managed-port.ts` (interface), `managed-substrate.ts` (implementation over injected capabilities, plus
`readManagedConfigs`), `managed-registry.ts` (per-tenant repository layout and `ownsPinnedImage`),
`managed-build-config.ts` (the build variables and `readBuildConfig`; no default builder image). Changed: `index.ts`
(export), `render.ts` (`ZENITH_BOOTSTRAP_IMAGE`: an inert `registry.invalid` image for a workload with no digest yet),
`platform.ts` (the `build_pipeline` note no longer says "runs no builds").

Platform composition (`src/lib/platform/`):
- `zenith-managed.ts`: THE default composition (`createDefaultManagedSubstrate`, `defaultManagedSubstrate`): reads
  `ZENITH_MANAGED_*`, binds the platform credential vault scope, the product-store tenant resolver and the Kubernetes
  provider. An invalid value degrades to an unconfigured port that names the variable (never throws at worker start).
- `zenith-managed-build.ts`: the LIFE-08/09 source path on the managed cluster: `createZenithSourceStore` (immutable
  in-cluster source Secret) and `createZenithBuildPort` (one builder Job per launch identity, digest from the pod,
  `BuildAttestation` read back from the executed Job and the namespace egress policy), plus the pure helpers
  (`renderBuildJob`, `builderArgs`, `classifyBuildEgress`, `attestBuild`).
- `release-zenith.ts`: rollout, readback and migration adapters (the Kubernetes provider's LIFE-07/LIFE-10 code through
  the managed session); refuses a built image outside the tenant's own repositories.
- `kubernetes-toolkit.ts`: the toolkit definition, now shared with `drivers.ts` (behaviour unchanged).
- Changed: `execution.ts` (composes and wires the substrate), `release.ts` (zenith ports when a substrate is composed),
  `source-bundle.ts` and `approved-source-runtime.ts` (a zenith branch of `prepare`, needing `zenithSources`), `drivers.ts`.

Execution (`src/lib/execution/`):
- `direct-zenith.ts`: plan, final plan and apply for `zenith` environments (render + server-side dry-run in the tenant
  namespace; `applyZenithEnvironment` for the apply), behind the same lease, policy, approval and plan-digest checks.
  Reviewed executable semantics are recorded at plan and re-asserted at final plan, apply and every release dispatch.
- `semantics/direct.ts`: the provider-direct stand-in for the OpenTofu workspace in the semantics digest.
- Changed: `plan.ts` and `apply.ts` (three one-line routing hooks beside the Kubernetes ones), `context.ts` (a
  Zenith-managed environment resolves to a NON-SECRET synthetic connection descriptor, `zenith-managed:<environmentId>`),
  `session.ts` (`withProviderSession` recognises it and opens the managed session via `withManagedSession`, after the
  capability broker still issued the grant), `destroy.ts` (an explicit `withZenithSession` wins, otherwise the composed
  substrate opens the session), `secrets.ts` (managed secrets are written by the apply step), `graph.ts`
  (`findGraphProblems` judges a managed graph by `assessZenithGraph`: platform-provided and not-offered kinds are not
  problems, unsupported kinds are, everything else needs a registered driver and no OpenTofu compile), `release.ts`/
  `build-isolation.ts` (profile `zenith.k8s-build.v1`), `build-provenance.ts` and `source-snapshot.ts` (provider enum),
  `verify.ts` (zenith sessions feed the Kubernetes observability source), `ports.ts` (`ExecutionDeps.managed`),
  `semantics/operation.ts` (managed dispatch uses the stand-in workspace).

Deploy and scripts:
- `deploy/zenith-managed/50-build-namespace.yaml` (+ kustomization, README): `zenith-build`, ServiceAccount
  `zenith-builder` (no token), default-deny ingress, `zenith-build-egress` (DNS only; the operator adds the registry).
- `scripts/managed/seed-platform-vault.ts`: the only way platform credentials reach the platform vault scope (value from
  a file or stdin, never an argument).
- `scripts/k8s/managed-substrate-acceptance.sh`: the local kind + Calico acceptance harness (section 3).

Migration:
- `src/lib/controlplane/db/migrations/0048_managed_source_provider.ts`, registered in `index.ts`: widens the migration-13
  CHECK on `platform.approved_source_snapshots` from `('aws','gcp','azure')` to include `'zenith'`, by rewriting the
  constraint from its own deparsed definition (so no other condition can drift). Idempotent; fails loudly if the
  constraint is missing or has an unexpected shape. Archive format for zenith is `tar.gz` (the existing
  `case when provider='aws' then 'zip' else 'tar.gz'` already covers it).

Docs: `docs/platform/MANAGED-PLATFORM.md` (new section, variables, status rows), `operations/BUILDS.md`,
`operations/TEARDOWN.md`, `operations/README.md`.

### How a request flows with nothing injected

1. `composeExecutionActivities` calls `createDefaultManagedSubstrate({ product })` and passes the port to execution
   (`ExecutionDeps.managed`), to `createReleasePorts({ managed })` and, as `zenithSources`, to source preparation.
2. A `zenith` environment's connection resolves to the synthetic descriptor; every step that asks for a session reaches
   `withManagedSession`: capability broker grant, then `managed.withSession({ workspaceId, environmentId })`.
3. The substrate resolves the tenant from the product store, resolves `ZENITH_MANAGED_KUBECONFIG_REF` from the platform
   vault scope (`ZENITH_MANAGED_VAULT_SCOPE`, default `zenith-platform`) inside `createKubernetesSession`, and returns a
   session whose namespace allowlist is exactly the tenant namespace.
4. Plan/apply: `direct-zenith.ts`. Build: source snapshot, `zenithSources.upload`, builder Job, attestation, signed
   provenance (all existing LIFE-08/09 machinery). Rollout: `release-zenith.ts`. Teardown: `destroy.ts` default opener.

## 2. Acceptance mapping

| Acceptance clause | Implementation | Tests |
| --- | --- | --- |
| Default **session opener** without injected ports | `zenith-managed.ts`, `managed-substrate.ts`, `context.ts`, `session.ts`, `destroy.ts` | `tests/providers/zenith/managed-substrate.test.ts`, `tests/platform/zenith-managed-composition.test.ts` (default substrate opens a tenant-scoped session reading only the platform scope), gated `managed-kind.test.ts` (real API server), `tests/docs/operator-docs.test.ts` (updated pin: destroy default opener) |
| Default **substrate** composition | `createDefaultManagedSubstrate`; unconfigured = a port refusing by variable name | composition test (unconfigured, invalid tier, configured); `tests/execution/zenith-managed-journey.test.ts` ("fails by variable name when the substrate is not configured", "refuses ... a worker that composed no substrate") |
| Default **source build** composition | `zenith-managed-build.ts`, `source-bundle.ts` zenith branch, `build-isolation.ts` profile, migration 48 | `tests/platform/zenith-build.test.ts` (Job spec, builder args, egress classification, attestation vs `assertBuildIsolation("zenith", ...)`, the port against the Kubernetes contract fake, adoption/launch identity), gated `managed-kind.test.ts` (real builder, real push, real policy enforcement) |
| Default **release** composition | `release.ts` + `release-zenith.ts`, `direct-zenith.ts`, semantics binding | `zenith-build.test.ts` (built image only from the tenant's repositories is enforced in `release-zenith.ts`; contract), `zenith-managed-journey.test.ts` (plan, policy, approval, final plan, apply, deploy of a new pinned digest, verify, digest binding, approval refusal, foreign namespace refusal), `zenith-graph-problems.test.ts` |
| "without manually injected test ports" | the composition tests assert the real `execution.ts` contains the wiring; the gated kind test injects nothing but the control-plane lookup | `zenith-managed-composition.test.ts` ("the real composition wires every managed caller"), `managed-profile.test.ts` (kind test builds through `createDefaultManagedSubstrate`) |
| Runs against a local kind cluster | `scripts/k8s/managed-substrate-acceptance.sh`, `tests/providers/zenith/managed-kind.test.ts` | gated, see section 3 |
| Live hosted acceptance | deferred, not claimed | none |

Other tests touched: `tests/providers/zenith/deploy.test.ts` (kustomization now lists `50-build-namespace.yaml`; new
build-namespace checks, including that the shipped egress policy is admitted by the build path),
`tests/docs/operator-docs.test.ts` (the pin that asserted the ABSENCE of a default opener now pins its presence).

## 3. Verification commands (other machine)

Node 22, repo root. None of these were run by the author.

Contract and static (no cluster, no database):

```
npx vitest run tests/providers/zenith/managed-substrate.test.ts tests/providers/zenith/managed-profile.test.ts \
  tests/providers/zenith/deploy.test.ts tests/platform/zenith-managed-composition.test.ts \
  tests/platform/zenith-build.test.ts tests/execution/zenith-managed-journey.test.ts \
  tests/execution/zenith-graph-problems.test.ts tests/docs/operator-docs.test.ts
```

Expected: all pass; `managed-kind.test.ts` is not in this list. Run the existing neighbours too, they share changed files:
`tests/providers/zenith tests/providers/kubernetes tests/execution tests/platform tests/docs tests/controlplane`.
`tests/controlplane/migrations.test.ts` will need the assembler's update for migration 48 (section 4).

Migration 48 against a real Postgres (the repo's existing PG-gated pattern): apply migrations 1..48 to a clean database
(`ZENITH_TEST_PLATFORM_PG_URL`), then check that an `approved_source_snapshots` insert with `provider: 'zenith'` and
`archiveFormat: 'tar.gz'` succeeds, one with `provider: 'oci'` fails, and re-applying 48 is a no-op. No test of this
exists yet; it is the first thing to add if the constraint's deparsed form differs from what the migration expects (it
raises "unexpected shape" rather than guessing).

Local kind acceptance (needs docker, kind >= 0.33, kubectl, npx/tsx; creates and deletes cluster `zenith-life07-man01`):

```
ZENITH_MAN_REGISTRY_IMAGE=<registry image@sha256:...> \
ZENITH_MAN_BUILDER_IMAGE=<kaniko-compatible executor image@sha256:...> \
scripts/k8s/managed-substrate-acceptance.sh
```

You supply the two images, pinned by digest, because this repository pins no digest it has not read from a registry. Any
registry image that serves the v2 API on port 5000 and any builder whose CLI accepts the kaniko flags used in
`builderArgs` (`--context=tar://`, `--dockerfile`, `--destination`, `--digest-file`, `--insecure`) will do. The script
refuses unpinned images, then: creates kind + Calico, applies namespaces, operator RBAC and the build namespace, starts
the registry (NodePort 30500, address `<node IP>:30500`, taught to every node's containerd as plain http), extends the
build egress policy by the registry namespace only, mints a 2 hour token for `zenith-operator`, seals it into the
platform vault scope with `scripts/managed/seed-platform-vault.ts`, and runs `managed-kind.test.ts`. Gateway API and
cert-manager are not installed: the run uses `ingress` mode. Evidence JSON (no token, kubeconfig or server address):
`$ZENITH_K8S_EVIDENCE_OUT/managed-substrate-evidence.json`. Without the script's environment the test SKIPS with a
printed reason (never counted as passed).

Expected from a passing kind run: the default substrate is configured with no injected port; two tenants each get the
tenancy baseline (PSA `restricted`, quota, limit range, default-deny, ServiceAccount) and a Deployment; the tenant session
guard refuses another tenant, `zenith-build`, `kube-system` and `zenith-system`; the release adapter patches the
Deployment to a new pinned digest; a `FROM scratch` source builds, returns a `sha256:` digest from the builder's pod,
an image reference inside the tenant's own repository, and an attestation that passes `assertBuildIsolation("zenith")`;
a probe in `zenith-build` cannot reach the API server that a control probe in `default` reaches (enforcement, needs
Calico). Things most likely to need adjusting on first run: the builder's flags and its handling of a `tar://` context
(`--dockerfile` is passed relative to the context directory, `--context-sub-path` for subdirectories); the containerd
`certs.d` path on the chosen kind node image; whether the kind CA and `127.0.0.1` pass `httpsUrl` (they should: https,
no credentials).

## 4. Known gaps, risks and shared-file updates

Honest gaps, in order of consequence:

1. **No product front door.** A product environment's provider is its connection's provider, and `ProviderId`
   (`src/lib/domain/types.ts`) has no `zenith`. Nothing in the product creates a `zenith` connection or environment, so a
   managed environment can exist only if its store records are written directly (the contract journey does it with the
   fake product port). I tried widening `ProviderId` (it typechecks) and reverted it: it reaches
   `/api/providers/[id]/health` and `actions/defs/connection.ts` and needs a deliberate product decision (how a user
   chooses managed hosting, placement, billing). Everything built here is reachable the moment such an environment exists.
2. **Operator credential breadth.** Observe, plan and deploy sessions use the SAME operator credential (the ClusterRole
   in `40-operator-rbac.yaml`, which can read and write Secrets in every tenant namespace). The session's namespace
   allowlist and the environment-bound namespace guard are the only per-tenant control. `toolkit.read` is not
   environment-bound (an existing shape; callers pass refs they derive). Separating observe from deploy, narrowing the
   operator, and per-tenant credentials are PROD-MAN-04.
3. **Builds share one namespace, one node pool and the node kernel** across tenants, as root inside the builder
   container. Source Secrets are environment-named but readable by the operator. Egress is a NetworkPolicy READ BACK, not
   proven enforced by the control plane (the kind test proves enforcement on Calico only). Sandboxed build runtimes:
   PROD-MAN-04.
4. **Source limit.** The in-cluster hand-off carries about 700 KiB of archive. Larger sources refuse by name. Managed
   object storage is PROD-MAN-03.
5. **Registry digest not independently read.** The digest is the one the builder wrote after pushing; the control plane
   does not query the registry (it may be private or in-cluster). The first independent reader is the kubelet pull at
   rollout. A registry client with the push credential is a follow-up.
6. **Teardown has no trusted managed-database inventory.** The default opener supplies a plain session, so the zenith
   teardown cannot prove database teardown complete and never deletes a managed database.
7. **Reconcile/drift for managed environments is not wired.** The reconcile sweep uses the customer credential broker with
   a platform connection; a managed environment has none, so it registers without a connection and is not observed by the
   sweep. The deploy-time verify and observe steps do work (they go through `withProviderSession`).
8. **Plan tier is provisional** (`ZENITH_MANAGED_DEFAULT_PLAN`, default `free`); the hostname environment segment is the
   environment id (unique and DNS-safe, not pretty).
9. **First-deploy plan is not server-validated**: server-side dry-run of namespaced objects needs their namespace, so a plan
   for a new tenant reports every object as `create` and says so; the apply preflight is all-or-nothing per phase.
10. **Pre-existing, not changed:** the Kubernetes (customer cluster) direct path records no reviewed semantics at plan,
    yet `assertOperationSemantics` refuses a planned operation with none when a semantics store is wired (production
    composition). Its release steps therefore look broken in production composition; the contract journey passes because
    its world wires no store. The managed path does record and bind semantics (`semantics/direct.ts`). The same fix for
    `direct-kubernetes.ts` is a few lines but changes a verified path, so it was left for the orchestrator.
11. No canary on the managed platform; migrations reuse the Kubernetes Job runner.
12. The kind harness requires operator-supplied pinned images and a Linux-like docker; it has not been run.

Verified behaviour changed (call-outs): `findGraphProblems` now has a managed branch (only for `zenith` environments;
Kubernetes and others unchanged); destroy's missing-opener refusal now applies only when no substrate is composed;
the operator-docs pin described above; the deploy kustomization list.

Shared-file updates the orchestrator/assembler must make (I did not touch any of them):
- `tests/controlplane/migrations.test.ts`, `scripts/ci/apply-supabase-migrations.sh`, `emit.ts`, `supabase/migrations/*`,
  `docs/platform/operations/DEPLOYING.md`: register/emit migration 48 (`managed_source_provider`, alters an existing table's
  CHECK; no new table, no new RLS object).
- `src/lib/sensitivedata/inventory.ts`: **no new table.** Nothing to classify. (The platform vault scope uses the existing
  `public.secrets` table under a reserved workspace id.)
- `tenancy.test.ts` / `controlplane-sql-scoping`: **no new store function.**
- `scripts/ci/gate-manifest.mjs`: add the new vitest files to the appropriate lanes:
  `tests/providers/zenith/managed-substrate.test.ts`, `managed-profile.test.ts`, `tests/platform/zenith-managed-composition.test.ts`,
  `tests/platform/zenith-build.test.ts`, `tests/execution/zenith-managed-journey.test.ts`, `tests/execution/zenith-graph-problems.test.ts`.
  `tests/providers/zenith/managed-kind.test.ts` is env-gated and belongs in a kind-profile lane with
  `scripts/k8s/managed-substrate-acceptance.sh`, never counted as passed when skipped.
- `docs/LIMITATIONS.md`: replace "Default managed Zenith execution has no session opener/substrate integration; managed
  teardown needs injected `withZenithSession` ..." with the gaps in this section (notably 1, 2, 3, 6, 7).
- `docs/build/RESUME.md` still says the default opener and hosted substrate are absent.
- `ledger.json`, `PROGRESS.md`: statuses below.
- New environment variables to document in the deployment guide: `ZENITH_MANAGED_VAULT_SCOPE`, `ZENITH_MANAGED_DEFAULT_PLAN`,
  `ZENITH_MANAGED_BUILDER_IMAGE`, `ZENITH_MANAGED_BUILD_NAMESPACE`, `ZENITH_MANAGED_BUILD_PUSH_SECRET`,
  `ZENITH_MANAGED_BUILD_REGISTRY_INSECURE` (already in `MANAGED-PLATFORM.md`).
- The existing `ZENITH_BUILD_ALLOW_OPEN_EGRESS` exception also governs managed builds.

Workflow wiring: none new. `plan.ts`/`apply.ts` hooks sit inside the existing activities; no new workflow, activity,
schedule or route.

## 5. Suggested ledger implementationStatus

`partial: default managed substrate composition built (session opener, tenant resolution, plan/apply, source build, release, teardown opener) with contract tests and a local kind + Calico harness, none run by the author; no product front door for provider zenith, shared operator credential, shared build namespace, 700 KiB source limit, no live hosted acceptance`

## 6. Follow-up: the product front door and managed database teardown (completes the WIP commit e2ee7ed4)

Not RUN by the author (worker rules). `tsc --noEmit` and `eslint` over every changed file are the only checks made.

### Front door: a managed environment can now be created through the product

- `ProviderId` includes `zenith`; `ConnectionConfig` has `ZenithConnectionConfig` (non-secret: `{ provider, mode: "managed", region }`).
  Every exhaustive switch was fixed without casts (identity, scope text, revocation steps, rotation refusal). The capability
  matrix and the offered catalog regenerate unchanged (checked: both "already up to date").
- `connection.createZenith` (`connection-lifecycle.ts`; admin, human only, refused for agents and the Navigator like every
  other connection-creation verb) records the platform row and its product mirror through `createProviderConnection`. It
  reads the region label from the configured substrate and refuses with the variable names when the substrate is not
  configured. One live managed connection per workspace. No OIDC issuer is needed (nothing is federated).
- Verification (`verifyAnyConnection`, reached by `connection.verify`, the REST `verify` route and now also
  `connection.check` for a zenith connection) records `verified`/`failed` on the platform row (what the deploy route reads)
  and mirrors it to the product row. It states only that the managed substrate is configured: no cluster call, no tenant
  session, and no claim about tenant isolation.
- Surfaces: REST `POST /api/platform/v1/connections` accepts `provider: "zenith"`; Platform, Connections has a "Zenith
  managed" tab; Settings, Connections has a "Use the managed platform" card (runs `connection.createZenith` through the
  plan/confirm dialog); the environment form's connection picker lists the connection once verified (`unusableReason` reads
  the registered adapter, which is now `src/lib/providers/zenith/adapter.ts`, registered by `ensureEngine`).
  `connection.create` (the legacy sandbox-style verb) refuses `zenith` and points at `connection.createZenith`.
- MCP: environments are created through `env.create`, which the capability bridge already exposes; it takes a
  `connectionId`, so an agent creates a managed environment by naming the workspace's zenith connection. Creating the
  connection itself stays human-only (`connection.createZenith` is in the bridge's refused list in
  `tests/capabilities/action-bridge.test.ts`).
- The adapter is `available` and always refuses `planSteps`/`executeStep`/`exportBundle` with a message naming the
  execution plane: a zenith environment is a real-provider route, so it is never run by the in-process engine.

### Teardown inventories and tears down managed databases

`destroy.ts` (`zenithDatabaseInventory`, `directCall`): for a zenith environment the worker builds the complete managed
database inventory from the deployed graph PLUS removed resources merged from the workspace-scoped store (provider id from
the stored row) and attaches it to the tenant session as `teardown.databases`. Before this, the provider teardown always saw
"no inventory", reported `ManagedDatabase/<ns>/*` uncertain and so every managed teardown was refused at review.
Ownership proof is layered: only `managed` nodes on provider `zenith` are listed; a stored row must agree on kind,
provider, workspace and environment; adoption claims are still checked by `assertTeardownOwnership`; and the database
adapter's own delete refuses a provider project that is not the one created for this exact (workspace, environment,
address). Policy: `deny` is always retained, `approval` deletes only when `approved`, `allow` deletes. `approved` is true at
review/verify (nothing is deleted; the destroy operation's digest-bound human approval covers exactly the reviewed list) and
at apply only after the fresh `checkDestroyApproval` re-check passes. The managed-database port comes from
`managed.databaseRuntime` and is passed to the session opener only when the inventory is non-empty; failure to build it is a
refusal, never an empty inventory. A caller-supplied `withZenithSession` (contract tests) keeps full control of its session.
`directPlan` now also flags a `ManagedDatabase/...` deletion as `destroysData`.

Tests written, not run: `tests/execution/zenith-destroy-databases.test.ts`, `tests/connections/zenith-connection.test.ts`;
`tests/capabilities/action-bridge.test.ts` lists `connection.createZenith`.
Verify with: `npx vitest run tests/execution/zenith-destroy-databases.test.ts tests/execution/destroy-providers.test.ts tests/connections tests/capabilities/action-bridge.test.ts tests/providers/zenith`.

### Known gaps

1. Per-tenant isolation (separate credentials/namespaces/limits per tenant on the shared cluster) is NOT addressed here; it is
   left to the merge join with MAN-04/05. A zenith connection and its verification say nothing about it.
2. A database created at the provider whose resource row was never recorded (apply failed between create and row write) is not
   in the inventory; the port has no list operation. Teardown cannot discover it.
3. `connection.createZenith` has no PGlite lifecycle test (needs a configured substrate fixture); the preflight/verify branch
   is covered only at contract level.
4. Assembler: add the two new test files to the gate manifest lanes.

## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: Default Zenith session opener/substrate/source build/release composition operates without manually injected test ports.

The AWS planner includes this exact requirement; native provider fixture checks alone leave its full product acceptance pending. See [L1-LIVE-AWS](L1-LIVE-AWS.md) and [owner runbook](../LIVE-ACCEPTANCE.md) for the immutable plan, Wave 5 ProductScenarioPort join, approved permission/session FILE references, owner-only bootstrap, one-command execution and recovery. Commercial, retention, multi-cloud, managed cluster and final signoff decisions remain separate where this row requires them.

Exact Mac commands (Node 22, one workload, Docker 4GiB only for the separate Wave 5 stack):

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
node --version
actionlint .github/workflows/live-acceptance.yml
tofu -chdir=deploy/live-sandbox/aws init -backend=false
tofu -chdir=deploy/live-sandbox/aws validate
npx vitest run tests/acceptance/aws-production.test.ts tests/acceptance/aws-production.live.test.ts --no-file-parallelism --maxWorkers=1
# Only AFTER DEC-CLOUD and all variables in LIVE-ACCEPTANCE.md are exported, for a NEW approved run:
ZENITH_LIVE_AWS=1 npx vitest run tests/acceptance/aws-production.live.test.ts --no-file-parallelism --maxWorkers=1
```

Expected offline: provider contracts pass; actual AWS test is skipped, never accepted as live evidence. Expected live for this source: six actual provider fixtures and native cleanup, zero failed checks, packet incomplete / exit 3 and this requirement pending until its full product journey is joined and independently verified. No actual AWS, real PostgreSQL, Temporal, kind or browser verification was run on the Windows builder. Status for the AWS harness slice: implementation_complete_verification_pending.
