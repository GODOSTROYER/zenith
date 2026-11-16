# PROD-MAN-02 / PROD-MAN-03 verify notes: managed serving integrations, tenant storage, domains and the service catalog

Branch `prod/man-02-03-w5` from `c02c097e`. Platform migration version **49**. Nothing here was executed: no vitest, no kind, no
Postgres, no Temporal. The only checks run on the building machine were `npx tsc --noEmit -p .` and `npx eslint` on every changed
file (results in the handoff). Every test below was desk-checked against the code; read "Known gaps" for what is most likely to need
a fix first. Live hosted acceptance, commercial limits and retention decisions are deferred by the user: every number marked
PROVISIONAL is a starting point, not a decision.

Docs: `docs/platform/MANAGED-PLATFORM.md`, new section "Managed serving", two new variable rows, three table rows updated.

## 1. What was built

### Audit first: what already existed
`src/lib/providers/zenith/**` already had the managed tenancy layer, per-environment wildcard `Certificate` + Gateway (TLS
lifecycle), host rewriting, Gateway API routes, the Neon managed-database port, vault delivery of connection URIs and the
`object_store` driver that **refused** ("per-tenant credentials are not implemented"). LIFE-11 already exports and restores the
managed Postgres, LIFE-02 already publishes the offered catalog, OBS-04 already has the durable critical-job schedule. Nothing
called `openZenithSession` / `applyZenithEnvironment` outside the provider: the composition root is PROD-MAN-01's. So this work
adds the missing mechanisms inside those existing paths and reaches them from real callers where a caller exists today (REST,
durable job, offered catalog), and describes the join for the rest.

### New module `src/lib/managed-serving/`
| File | Role |
|---|---|
| `domains.ts` | hostname rules (ASCII, no wildcard/IP/punycode/reserved TLD, never the platform's own domain), the DNS TXT challenge (random token, SHA-256 of the whole TXT value is all that is stored), `systemDomainDns` (node:dns, bounded answers/timeouts), `verifyChallenge`, the proof/renewal/lapse state machine `decideDomainTransition`, provisional windows |
| `domain-service.ts` | claim, verify, list, revoke, `servedCustomHostnames`, `renewalPass` over the platform store and the DNS port |
| `storage.ts` | `scopedStoragePolicy` (allow-only, prefix-confined), per-tenant `ManagedStorageIntent`, `ObjectStorageAdminPort` + the IAM adapter `createIamAdminPort` (lazy `@aws-sdk/client-iam`, already a dependency), `provisionObjectStores` (create, converge, rotate, orphan cleanup, crash-safe), `settleRevocations`, `revokeObjectStoreKeys`, `ObjectStoragePorts` |
| `platform-store.ts` | `loadServingInputs` (verified/retired domains for an environment), `platformStorageKeyStore` |
| `catalog.ts` | the managed tier's promises, `checkManagedCatalogDrift` against the LIFE-02 offered catalog, `serviceAvailability`, `buildManagedServiceCatalog` |
| `readiness.ts` | per-integration state (`not_configured` / `configured_unverified` / `verified` / `failing`), registry-v2 and wildcard-DNS probes, `environmentServingStatus` (Certificate `Ready`, Gateway `Programmed`) |
| `access.ts` | environment membership/admin guard over the broker's scope and role resolvers, managed-provider check |
| `job.ts` | the durable `managed-serving` job body (domain renewal, owed key revocations) |

### Changed provider code (additive, default behaviour unchanged)
| File | Change |
|---|---|
| `providers/zenith/tls.ts` | per verified custom domain: its own Certificate (ACME HTTP-01 issuer) and its own HTTPS listener on the environment Gateway; `listenerForHost`, `isRouteParentFor`, `customDomainTlsNames`; default output byte-identical |
| `providers/zenith/tls-lifecycle.ts` | `customDomains`, `retiredDomains`: ownership check of every custom key Secret before any write, retired Certificate + key removed when owned, teardown covers both |
| `providers/zenith/routing.ts`, `render.ts`, `isolation.ts`, `drivers/network/http-route.ts` | a verified host is kept (not rewritten) and attached to its own listener; the isolation gate accepts a route hostname only if managed or in the verified set, and requires the parent listener to match the host; the route driver finds custom-host routes |
| `providers/zenith/render.ts`, `apply.ts` | `object_store` becomes a provisioning intent when the substrate has an admin credential reference (otherwise still unsupported, so existing tests are unchanged); storage phase before the baseline (`blockedBy: "storage"`); `verifiedDomains`, `retiredDomains`, `autoscaling` inputs |
| `providers/zenith/autoscale.ts` (new), `plans.ts` | HPA policy: tier ceiling (`maxAutoscaleReplicas`: 0/5/20, PROVISIONAL), pod and CPU-request quota clamp, damped scale-down; `maxObjectStores` 0/2/10 (PROVISIONAL) |
| `providers/zenith/drivers/data/object-store.ts` | scoped mode: observe (recorded key, provider key list, provider policy digest) and verify; legacy refusal when scoped credentials are not available |
| `providers/zenith/isolation.ts` | plaintext-secret gate: literal under a secret-named env var, credential-shaped env value, secret on the command line (reuses `capabilities/secret-guard`) |
| `providers/zenith/session.ts`, `substrate.ts` | optional `customDomains`, `storage` on the session; substrate variables `ZENITH_MANAGED_HTTP_CLUSTER_ISSUER`, `ZENITH_MANAGED_OBJECT_STORAGE_IAM_ENDPOINT`, `ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF` |
| `providers/zenith/database-factory.ts`, `secrets/resolver.ts` | generated vault references `storage-key-id` / `storage-secret`; `createStorageCredentialSink` (overwrite for rotation, kinds locked); factory returns it as `storageCredentials` |
| `platform/critical-jobs.ts` | `managed-serving` job (durable-only like the custody jobs) |
| `app/api/platform/v1/...` | `GET /managed-services`, `GET|POST /environments/:id/domains`, `POST .../domains/verify`, `POST .../domains/revoke`, helper `_lib/managed.ts`, `bearer-paths.ts` classification |
| `deploy/zenith-managed/custom-domains/` | optional add-on kustomization: ACME HTTP-01 Gateway (port 80, same-namespace routes only) and HTTP-01 ClusterIssuer placeholder; the base `deploy/zenith-managed` files are untouched (its verified test pins the exact list) |

### Store (migration 49, `0049_managed_serving.ts`, repo `repos/managed-serving.ts`, namespace `managedServing`)
- `platform.managed_domains`: tenant-owned claim + challenge hash + proof clock; partial unique index makes a verified hostname
  globally unique; one live claim per (workspace, environment, host).
- `platform.managed_storage_keys`: non-secret record of each issued key (principal, access key id, prefix, policy digest, vault
  reference); one active key per (workspace, environment, address); superseded keys stay `revoke_pending` until the provider
  confirms revocation.
- RLS on, no policies, service_role select/insert/update.

## 2. Acceptance mapping

### PROD-MAN-02 "Supported registry/gateway/DNS/TLS/secret delivery/storage/managed database integrations operate; established managed DB services reused."
| Clause | Implementation | Tests |
|---|---|---|
| gateway: per-tenant routes | existing Gateway-per-environment + HTTPRoute, now also per verified host | `serving-render.test.ts` (custom domains), `serving-contract.test.ts` (real renderer + SSA against the HTTP contract fake) |
| TLS: ACME / cert-manager | wildcard (DNS-01, existing) and per-host Certificates (HTTP-01) through the gateway-namespace client; issuance observed from `Ready` | `serving-render.test.ts` TLS lifecycle, `integration-readiness.test.ts` `environmentServingStatus`, add-on manifests test |
| DNS | platform wildcard probe; custom-domain TXT proof over real DNS | `domains.test.ts` (local UDP DNS server through the production resolver), `integration-readiness.test.ts` probes |
| registry | built images must be digest-pinned in the platform registry (existing) + registry v2 probe | `integration-readiness.test.ts`, `catalog.test.ts` availability |
| secret delivery | vault references resolved at apply; plaintext gate in the isolation checks | `serving-render.test.ts` "no plaintext secret", `serving-contract.test.ts` (canary never in a manifest, report or log), `serving-kind.test.ts` (kind-gated) |
| storage | scoped per-tenant object storage (below) | `storage.test.ts`, `storage-emulator.test.ts` (gated) |
| managed DB, established services reused | unchanged Neon port; `postgres` stays a managed service, never in-cluster; vault runtime reused | existing `tests/providers/zenith/{neon,vault-runtime}.test.ts`; `catalog.test.ts` lists it and its export/import support |
| "operate", not "configured" | integration state never `verified` without a probe that observed it | `integration-readiness.test.ts`, `services-route.test.ts` |

### PROD-MAN-03 "Tenant object storage, domain ownership proof/renewal, DB export/restore, autoscaling and promised services function."
| Clause | Implementation | Tests |
|---|---|---|
| tenant object storage | per-store prefix, own principal, one inline allow-only policy, key in the vault, references only in the store; rotation; revoke; orphan cleanup; no data deletion | `storage.test.ts`: policy EVALUATED (in-prefix allowed; other tenant, sibling prefix, root, parents, list without/with foreign prefix, admin actions denied), hostile ids, provisioning lifecycle, IAM adapter contract; `domain-store.test.ts` storage-record scoping; `storage-emulator.test.ts` (LocalStack IAM + S3, enforcement case gated) |
| domain ownership proof | DNS TXT challenge, hashed at rest, real DNS verification, globally unique verified host | `domains.test.ts`, `domain-store.test.ts` |
| renewal | durable `managed-serving` job re-verifies inside the 7-day window, 3-day grace, lapse; reads filter by time so a stopped job cannot keep a host served | `domain-store.test.ts` (fake clock, real DNS), `integration-readiness.test.ts` job registration |
| DB export/restore | LIFE-11 `data.export` / `data.import` already support the managed Postgres (`postgres-logical-v1`); surfaced and asserted in the service catalog | `catalog.test.ts` (matrix), existing `tests/portability/**` |
| autoscaling | HPA from the production renderer, tier/quota clamp, damped scale-down, refused on the free tier | `serving-render.test.ts` (policy + render), `serving-contract.test.ts` (real renderer, SSA), `serving-kind.test.ts` (kind-gated, real API server admits it) |
| promised services function; catalog = offered catalog; drift check | `catalog.ts`, `GET /managed-services` | `catalog.test.ts` (no drift today; five tamper cases fail; every offered zenith kind accounted for exactly once; limits derived from `plans.ts`), `services-route.test.ts` |

## 3. Verification commands (other machine, Node 22)

```
npx tsc --noEmit -p .
npx eslint src/lib/managed-serving src/lib/providers/zenith src/app/api/platform/v1 src/lib/controlplane/db tests/managed-serving

# unit / contract / local-engine (PGlite and a local UDP DNS server; no env needed)
npx vitest run tests/managed-serving
# expected: all pass; the two gated files report "skipped" with their reason (never counted as passed)

# existing contracts this change touches (must stay green)
npx vitest run tests/providers/zenith tests/providers/kubernetes tests/secrets tests/platform/critical-jobs.test.ts tests/offered-catalog tests/portability tests/capabilities/portability-broker.test.ts

# real PostgreSQL lane for the store
ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/managed-serving/domain-store.test.ts

# emulator lane (LocalStack or any IAM-compatible endpoint serving IAM + S3)
ZENITH_TEST_IAM_ENDPOINT=http://127.0.0.1:4566 ZENITH_TEST_IAM_ADMIN_KEY_ID=<test> ZENITH_TEST_IAM_ADMIN_SECRET=<test> npx vitest run tests/managed-serving/storage-emulator.test.ts
# add ZENITH_TEST_IAM_ENFORCED=1 (LocalStack ENFORCE_IAM=1) for the "denied outside its prefix" case; without it that case is skipped, by design

# kind lane (disposable cluster named kind-zenith-*, e.g. the PROD-MAN-01 substrate cluster)
ZENITH_TEST_MANAGED_SERVING_KIND=1 KUBECONFIG=<abs private> ZENITH_TEST_K8S_IMAGE=<digest-pinned image> npx vitest run tests/managed-serving/serving-kind.test.ts
```

## 4. Known gaps, things that may break first, and orchestrator actions

Things most likely to need a fix on first run (nothing was run here):
- `serving-contract.test.ts` assumes the production renderer names Deployments/HPAs `web` and `worker` and that the contract fake
  stores HPA objects as applied; adjust the names if the renderer's naming differs.
- `serving-kind.test.ts` and `storage-emulator.test.ts` were written against the client-node v2 object-style API and the SDK; they
  are gated and have never run.
- `domain-store.test.ts` counts rows per test (fresh ids per test) but the renewal pass is cross-workspace, so assertions use
  row state, not pass totals.
- The DNS test server answers TXT only; an environment where UDP to 127.0.0.1 is filtered would fail `domains.test.ts` real-DNS cases.

Honest limits (state them in LIMITATIONS):
- Live acceptance is deferred: no real cluster, gateway controller, cert-manager/ACME, DNS provider, IAM provider or Neon account.
  Evidence is contract-level plus the opt-in emulator and kind lanes.
- No local ACME server (pebble) exists in the repository, so ACME issuance is contract-level only: the objects are rendered and
  applied, and readiness is read from the Certificate's own conditions when a cluster exists.
- The ACME HTTP-01 design needs the platform ACME Gateway and the environment Gateways reachable at the address customers CNAME to;
  Gateway API v1 promises no address sharing. CNAME alignment of the customer's DNS is not checked.
- Object storage isolation is IAM policy enforcement by the provider; the platform proves the policy it asks for, not that a given
  provider enforces it. Per-store byte quotas are not enforceable and not promised. Bucket versioning is bucket-wide.
- `data.export` of a managed OBJECT STORE remains unsupported (`src/lib/portability/matrix.ts` says "not provisioned yet"; that
  text is now stale but the file is outside this worker's paths). Managed Postgres export/restore is LIFE-11's.
- The durable job cannot revoke owed storage keys by itself: the storage admin credential is a platform secret and no platform
  credential resolver is composed into the worker (PROD-MAN-01). It counts them (`revocationsBlocked`) and revocation is retried
  inline at every apply and rotation.
- Custom-domain proof windows (30 days, 7-day renewal window, 3-day grace, 10 per environment) and tier numbers (object stores
  0/2/10, autoscale ceilings 0/5/20) are PROVISIONAL.
- `autoscaling` is opt-in per apply; nothing turns it on by default until the composition root passes it. Scaling needs
  metrics-server, which is not probed.
- Routes for domains are covered at function level (service, access guard, classification) plus the `managed-services` route
  through the real route wrapper; the domain routes themselves have no wrapper-level test because a zenith-provider environment
  needs a seeded product store (follow-up).

### Reachability and the join with PROD-MAN-01
Reachable today: the REST routes, the durable `managed-serving` job (once the maintenance schedule runs it), `GET /managed-services`
and the offered-catalog drift check. Reachable once the session composition root exists: custom-domain serving, object stores,
autoscaling in `applyZenithEnvironment`. The root must, per environment: call `loadServingInputs(sql, tenant)`; open the session with
`customDomains` and `storage: { admin: createIamAdminPort(substrate.objectStorage → {endpoint: iamEndpoint, region, credentialRef: adminCredentialRef}, { resolveSecret: <platform resolver> }), sink: createVaultDatabaseRuntime(...).storageCredentials, store: platformStorageKeyStore(sql, ws, env) }`; pass `verifiedDomains`/`retiredDomains` (and `autoscaling` when the tier should) to `applyZenithEnvironment`; and on environment destroy call `revokeObjectStoreKeys` for each store. No code path refuses silently: with no `storage` port an object store apply stops with `blockedBy: "storage"` and the reason.

### Shared-file updates the orchestrator must make (I did not touch these)
- **Migrations inventory**: version 49 `managed_serving`, checksum is `migrationChecksum(migration0049ManagedServing)`. Registered in `migrations/index.ts` after 41; versions 42-48 belong to siblings. Run emit-sql, update `supabase/migrations/*`, `emit.ts`, `scripts/ci/apply-supabase-migrations.sh`, `DEPLOYING.md`, `tests/controlplane/migrations.test.ts`.
- **`src/lib/sensitivedata/inventory.ts`**:
  - `platform.managed_domains`: owner `managed-serving`, classification `operational`, purpose "custom-domain claims and proof state"; columns `challenge_hash: digestOnly("sha-256 of the DNS TXT challenge value; the token is shown once and never stored")`, `hostname: plain("customer hostname")`.
  - `platform.managed_storage_keys`: owner `managed-serving`, classification `credential-derived`, purpose "scoped object-store key records (access key id and a vault reference; the secret is only in the vault)"; columns `secret_ref: plain("vault reference, not a value")`, `access_key_id: plain("provider key id, not a secret")`.
- **`tests/controlplane/tenancy.test.ts`** classification (all take the workspace as an argument and filter on it in SQL; foreign-workspace behaviour is covered by `tests/managed-serving/domain-store.test.ts`):
  - swept/scoped: `managedServing.claimDomain`, `getDomain`, `getDomainForVerification`, `listDomains`, `verifiedHostnames`, `applyDomainTransition`, `revokeDomain`, `recordStorageKey`, `activeStorageKey`, `listStorageKeys`, `markStorageKeyRevoked`, `retireStorageKey`.
  - system-level (no workspace argument; rows carry their own workspace id, used only by the durable job): `managedServing.listDomainsDue`, `managedServing.listRevokePending`.
  - `controlplane-sql-scoping`: both system functions are intentionally unscoped selects over `platform.managed_domains` / `platform.managed_storage_keys`.
- **`tests/middleware/platform-bearer.test.ts`**: the route inventory count and path list grow by four route files (`managed-services`, `environments/[id]/domains`, `.../domains/verify`, `.../domains/revoke`); expected classifications are in `tests/managed-serving/integration-readiness.test.ts`.
- **Gate manifest / CI**: add `tests/managed-serving/*.test.ts` to the unit lane; the PGlite and local-DNS files need no services; add the three gated lanes (Postgres, emulator, kind) as optional jobs. `scripts/docs/offered-catalog.ts --check` is unaffected (no driver capability flag changed; `object_store` keeps `observe` + `verify`).
- **Critical jobs doc**: `docs/platform/operations/DEPLOYING.md` should list `managed-serving` beside `key-rewrap` and `data-minimize` (durable-only; cadence 60 s; lease `critical-job:managed-serving`).
- **LIMITATIONS.md**: the honest-limits list above.
- **Docs generators**: no capability, policy or MCP tool was added, so `CAPABILITY-MATRIX.md`, `POLICY.md` and the MCP golden are unchanged.

### Verified behaviour deliberately changed
- `isEnvironmentGatewayParent` gained an optional section argument and routes are now checked with `isRouteParentFor` (same result for managed hosts; the existing `tests/providers/zenith/isolation.test.ts` cases are preserved). The unverified-host note in `render.ts` changed its parenthetical text (the prefix `is not served on the managed platform` that `render.test.ts` matches is unchanged).
- `createVaultDatabaseRuntime` now includes `object_store` addresses in its vault scope and returns `storageCredentials`; the connection-URI sink is still limited to Postgres addresses.
- The isolation gate now refuses literal secrets in `env`/`command`/`args`; no existing fixture carries one.

## 5. Suggested ledger implementationStatus
- PROD-MAN-02: `built_contract_local_engine_live_deferred` (registry/gateway/TLS/secret/storage/managed-DB integrations, readiness reporting and the drift-checked catalog built; contract, PGlite and local-DNS evidence; kind and emulator lanes written and gated; live hosted acceptance deferred; composition root is PROD-MAN-01)
- PROD-MAN-03: `built_contract_local_engine_live_deferred` (tenant object storage, domain proof and renewal, autoscaling policy, catalog and drift check built; DB export/restore is LIFE-11; live hosted acceptance deferred; provisional limits)
