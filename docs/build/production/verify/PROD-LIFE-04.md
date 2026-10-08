# PROD-LIFE-04 Azure data plane and sovereign identity

Branch `prod/life-04-w4`, base `c9a942d6`. Build only: nothing here was run against Azure, and no test was executed
on the build machine (typecheck and eslint only). Sovereign clouds (USGov, China) are CONTRACT-LEVEL: their endpoint
values come from Microsoft's published tables and were never run live. Live acceptance is public Azure only and is
deferred.

## 1. What was built

Audit of the base (kept, not rewritten): trusted source wiring (`release/source-binding.ts`, `source-storage.ts`,
`credentials.sourceStorageHost`), the ACR Tasks release path (`release/acr-task.ts`, `release/build.ts`, LIFE-08
`contextDirOf`/context digest admission in `execution/release.ts`, LIFE-09 isolation attestation in `build.ts`).
Findings: public endpoints were hard-coded in credentials (authority, scopes, hosts), ARM (`ARM_ORIGIN`), Key Vault
(`secrets.ts`, `execution/secrets.ts`, `platform/secret-grants.ts`), Log Analytics, ACR login server and SAS upload
host patterns, private DNS zones, the connection verifier and the bootstrap module; `ROLE` had no AcrPush; role
assignments had no plane classification or propagation handling.

New files
- `src/lib/providers/azure/cloud.ts`: `AzureCloud` table (public, usgov, china): ARM origin/host, Entra authority,
  federation audience, token scopes per audience, Blob/Queue/Key Vault/ACR suffixes, Log Analytics hosts, Monitor
  suffix, `ARM_ENVIRONMENT` value, private DNS zones, `liveAcceptance` flag. Helpers: `azureCloud`, `cloudOf(session)`,
  `audienceForCloudHost`, `acrLoginServerPattern`, `ANY_ACR_LOGIN_SERVER`, `blobHostPattern`, `keyVaultUri(Pattern)`.
  An unknown cloud name is refused (`UnknownAzureCloudError`), never defaulted.
- `src/lib/providers/azure/data-plane-rbac.ts`: role catalog (GUID, plane data/control, risk, allowed target kinds,
  allowed scope ARM types, data actions), `assertRoleFitsTarget`, `splitByPlane`, `scopeFitsRole`,
  `findRoleAssignment` (exact-scope read; parent-scope assignment is `broader_than_required`),
  `awaitDataPlaneAccess` (bounded exponential backoff, deadline max 15 min, retries only RBAC denials,
  `DataPlanePropagationTimeoutError`).
- `scripts/acceptance/azure-live.ts`: public-Azure live harness (see section 3).
- Tests: `tests/providers/azure/{cloud,sovereign,data-plane-rbac,live}.test.ts`.

Changed (all additive; public behaviour unchanged when `cloud` is absent)
- `credentials.ts`: session derives authority, token endpoint, scopes, federation audience (the `mintClientAssertion`
  audience is now the cloud's), host allowlist and `ARM_ENVIRONMENT` (non-public only) from the connection's cloud;
  unknown cloud -> `CredentialDeniedError`; `AzureSession.cloud` set only for non-public. `sourceStorageHost` takes the
  connection cloud: binding cloud still selects the Blob suffix (verified behaviour kept), but a binding for another
  cloud than an EXPLICITLY configured connection cloud is refused.
- `arm.ts` (`armClient`, `pollOperation`, nextLink check), `dns-ownership.ts`, `observability.ts` (Log Analytics host),
  `secrets.ts` (vault suffix per cloud; optional `propagation` window), `acr-build.ts` + `release/acr-task.ts` +
  `release/build.ts` (login server and SAS upload host per cloud; `release/journal.ts` accepts any cloud's login server,
  `build.ts` rechecks against the session's cloud), `release/source-storage.ts` (`propagationMs`, cloud from session),
  `release/source-binding.ts`.
- `drivers/identity/identity.ts`: `AcrPush` role and `push` verb (push implies pull, one role, one scope); every grant
  passes `assertRoleFitsTarget` (data-plane catalog role for that target kind, else compile error);
  `skip_service_principal_aad_check = true` on the compiled assignments (the identity is created in the same apply;
  avoids the PrincipalNotFound replication race); federated credential audience comes from `ctx.azureCloud`.
- `drivers/network/network.ts`, `drivers/data/mysql.ts`, `compute/workload.ts`, `compute/function-app.ts`: private DNS
  zones and ACR host detection derive from the cloud (`CompileContext.azureCloud`, set in `execution/compile.ts` from
  the Azure connection's `cloud`).
- `execution/secrets.ts`, `platform/secret-grants.ts`, `platform/credentials.ts`: vault URI, ARM URL and verifier URL
  from the cloud; secret sync passes a bounded propagation window (min(node timeout, 180 s)).
- `platform/source-bundle.ts`: `azurePropagationMs` dep, default min(timeout, 90 s), passed to the Blob reader.
- `connections/schemas.ts` (`cloud` in `CreateAzureInput`), `connections/service.ts` (trust steps name the cloud's
  audience), connections admin form (optional cloud field), `credentials/types.ts` (`cloud?` on config and session),
  `drivers/types.ts` (`CompileContext.azureCloud`), `tofu/env.ts` (`ARM_ENVIRONMENT` allowlisted, value restricted to
  public|usgovernment|china).
- `deploy/azure` bootstrap: `cloud` variable selecting the federated-credential audience, AcrPush added to the
  conditioned assignable roles, README note. `tests/providers/azure/deploy.test.ts` regex updated from
  `local.token_audience` to `local.federation_audience` (VERIFIED-CONTRACT CHANGE: same public value, indirection only).

Verified behaviour touched (state explicitly): `deploy.test.ts` audience regex (above); `identity.ts` compiled role
assignment bodies gain `skip_service_principal_aad_check` (no existing test asserts the exact body);
`function-app.ts`/`workload.ts` ACR host detection is now the strict registry-name pattern (5-50 chars, single label)
instead of any `*.azurecr.io`.

### Non-root contextDir (added)

Mechanism: uploaded archive built only from the validated contextDir (`release/context-archive.ts`, called from
`release/build.ts` after the full archive's sha256 was checked against the recorded digest). The LIFE-08
`contextDigest` binding is untouched: `admitBuildContext` in `execution/release.ts` still re-derives it for the
approved commit before any provider build starts, and the provenance statement still records contextDir and
contextDigest; the Azure upload only narrows bytes that digest covers. A Dockerfile outside the context (repo-root
Dockerfile with a subdirectory context, as on AWS/GCP) is copied to `.zenith/Dockerfile`; nothing else from outside is
uploaded. LIFE-09 isolation attestation is unchanged. The Azure refusal in `contextDirOf` was removed; its test in
`tests/execution/build-isolation.test.ts` now expects `apps/web` (VERIFIED-CONTRACT CHANGE). The launch journal key
includes contextDir for non-root builds only (root keys unchanged). Tests: `tests/providers/azure/context-archive.test.ts`.
The context archive is derived and validated BEFORE the permanent launch claim (non-root builds only), so a derivation failure leaves the key unconsumed and records nothing (test in `build-digest.test.ts`).

## 2. Acceptance mapping

Acceptance: "Trusted source wiring preserved; data-plane permission, sovereign identity/ARM endpoints and real source
builds accepted."

| Clause | Implementation | Tests |
| --- | --- | --- |
| Trusted source wiring preserved | `sourceStorageHost` keeps binding-cloud suffix semantics; resolver/storage unchanged except cloud pass-through and optional propagation; existing `source-binding`, `source-storage`, `credentials` suites untouched | existing `source-binding.test.ts`, `source-storage.test.ts`, `credentials.test.ts` (must stay green); `sovereign.test.ts` "source storage bindings"; `data-plane-rbac.test.ts` Blob propagation off-by-default case |
| Data-plane permission (separate from control plane, least privilege) | `data-plane-rbac.ts` catalog + `assertRoleFitsTarget` in `rolesForGrants`; AcrPush; Blob/KV/ACR roles scoped to one resource; bootstrap lists only data roles as assignable; control-plane roles never workload-assignable | `data-plane-rbac.test.ts` (catalog, plane split, fit/refusals, scope shape, compiled assignments, findRoleAssignment exact scope) |
| Propagation-delay handling | `awaitDataPlaneAccess`; Key Vault sync (`propagation`), Blob reads (`propagationMs`), compile-time `skip_service_principal_aad_check` | `data-plane-rbac.test.ts` (awaitDataPlaneAccess, KV sync, Blob reads) |
| Sovereign identity / ARM endpoints | `cloud.ts` used by credentials, ARM, Key Vault, Log Analytics, ACR, Blob, private DNS, verifier, tofu env, bootstrap audience | `cloud.test.ts`, `sovereign.test.ts` (usgov and china: authority, scope, audience, host allowlist, no token to public hosts, ARM URL/nextLink, Key Vault, ACR, DNS zones, `ARM_ENVIRONMENT` through `buildChildEnv`) |
| Federated identity for sovereign authorities | per-cloud federation audience minted into the assertion and trusted by bootstrap federated credentials and workload federation | `sovereign.test.ts` "exchanges at the cloud's authority..."; `data-plane-rbac.test.ts` bootstrap audience |
| Real source builds | existing ACR Tasks path (LIFE-08 context digest, LIFE-09 isolation, durable launch journal) now cloud-aware; live harness runs a real build into a named registry | `sovereign.test.ts` ACR cases; existing `build-digest.test.ts`, `helpers.test.ts`; live harness check `acr-source-build` (gated) |
| Live harness gated, public only | `scripts/acceptance/azure-live.ts`, `tests/providers/azure/live.test.ts` | `live.test.ts` harness-logic suite (always) and LIVE suite (skipped with reason unless env set) |

## 3. Verification commands (other machine)

Node 22. No database or Docker needed for any of these.

```
npx vitest run tests/providers/azure/cloud.test.ts tests/providers/azure/sovereign.test.ts tests/providers/azure/data-plane-rbac.test.ts tests/providers/azure/live.test.ts
npx vitest run tests/providers/azure tests/tofu tests/platform tests/connections tests/execution
npx tsc --noEmit -p .
```

Expected: all pass; `live.test.ts` shows exactly one SKIPPED test named `LIVE AZURE ACCEPTANCE SKIPPED (...)`.
Existing suites most likely to react: `tests/providers/azure/{static-checks,deploy,credentials,source-storage,helpers,build-digest}.test.ts`,
`tests/tofu/{security-hardening,backends}.test.ts`.

Live (public Azure only, deferred; never run by CI):

```
ZENITH_LIVE_AZURE=1 ZENITH_LIVE_AZURE_CRED_FILE=/path/creds.json [ZENITH_LIVE_AZURE_ALLOW_BUILD=1] \
  npx tsx scripts/acceptance/azure-live.ts
# or: same env with npx vitest run tests/providers/azure/live.test.ts
```

`creds.json`: `{ tenantId, clientId, subscriptionId, region, assertionFile, dataPlane?: { storageAccountResourceId,
container, keyVault, principalId, roleScopeId, roleName, registryId, loginServer, repository } }`. `assertionFile` holds
a fresh federated client assertion (re-read per exchange). Checks: `control-plane-subscription`,
`data-plane-blob-read`, `data-plane-keyvault-metadata` (metadata only, never a value), `role-assignment-exact-scope`,
`acr-source-build` (mutating, needs `ZENITH_LIVE_AZURE_ALLOW_BUILD=1`; pushes one `zn-<hex>` tag). Statuses:
`passed_live | failed | skipped`; any skip makes the verdict `incomplete`; a `usgov`/`china` cloud in the file is
refused.

## 4. Known gaps and orchestrator updates

- No migration, no new table, no store function, no workflow or gate wiring: nothing for the migrations inventory or
  tenancy tests. Gate manifest: add the four new test files to the Azure provider cohort if cohorts are listed by file.
- LIMITATIONS.md: sovereign Azure is contract-level only (values from published tables; ARM, Entra, Key Vault, ACR,
  Blob, DNS zone names unverified live); the per-cloud USGov/China `azurerm` provider environment must also be configured by the customer in
  their bootstrap provider block (documented in `deploy/azure/README.md`); live acceptance for Azure not run.
- `findRoleAssignment` is used by the live harness and exported for operators; the runtime does not call it on a
  hot path (the session has no principal object id). Propagation handling is wired at Key Vault secret sync, source
  Blob reads and the compiled assignments.
- ACR digest evidence for sovereign registries relies on `outputImages` shapes from the preview API
  (2019-06-01-preview) unchanged from the public path.
- The azurerm backend `environment` argument is not set in `backend-config.ts`; the backend honours `ARM_ENVIRONMENT`
  from the session env, which is what `childProcessEnv` now provides.
- Private endpoint zones for Key Vault and ACR exist in the cloud table but no driver creates those endpoints yet.
- Execution-core note for the Wave 3 merge: only `execution/compile.ts` (one conditional context field) and
  `execution/secrets.ts` (three one-line cloud/propagation edits) were touched; neither is on the forbidden list.
  After DUR-0x merges, re-check that `secrets.ts` still passes `propagation` to `syncSecretValue`.

## 5. Suggested ledger implementationStatus

`built_contract_verified_pending_run: cloud abstraction (public/usgov/china) wired through credentials, ARM, Key Vault, Log Analytics, ACR, Blob, DNS, tofu env and bootstrap; data-plane role catalog with least-privilege and propagation handling at Key Vault, Blob and compiled assignments; gated public-Azure live harness (not run). Sovereign clouds contract-level only; live acceptance deferred.`
# L2-LIVE-CLOUDS successor (2026-10-08)

The new entry point is `scripts/acceptance/live/azure/run.ts`, with packet-bound owner permissions, audience-specific short-lived token FILE references, independent paginated inventory and browser-approved teardown in finally. The prior `azure-live.ts` remains unchanged; do not use its direct build path as proof of the new permission/cleanup contract.

See [cloud campaign](../LIVE-ACCEPTANCE-CLOUDS.md) for acceptance mapping: azure-source-binding, azure-data-plane, azure-source-build and a separate sovereign-account azure-sovereign packet. Public Azure cannot close sovereign acceptance. Real source builds remain operated through the existing release fixture. Wave 5 packet/startup/run-tag joins remain pending.

Exact Mac offline commands (Node 22):

```bash
npx vitest run --config scripts/acceptance/live/dns/vitest.config.ts scripts/acceptance/live/dns/offline.test.ts --no-file-parallelism --maxWorkers=2
npx eslint scripts/acceptance/live
npx tsx scripts/acceptance/live/azure/run.ts --plan --packet scripts/acceptance/live/azure/packet.json.example
tofu -chdir=deploy/live-sandbox/azure init -backend=false
tofu -chdir=deploy/live-sandbox/azure validate
```

Exact Mac live successor, only after accountable approval, clean frozen commit and the operated Wave 5 API/worker/runner fixture (startup/packet-emitter join absent from this base):

```bash
export ZENITH_LIVE_AZURE=1
export ZENITH_LIVE_AZURE_CREDENTIAL_FILE="$HOME/.zenith-live/azure-credential-ref.json"
export ZENITH_LIVE_API_TOKEN_FILE="$HOME/.zenith-live/api-token"
npx tsx scripts/acceptance/live/azure/run.ts --packet "$HOME/.zenith-live/azure-packet.json" --permissions "$HOME/.zenith-live/permissions.json" --out "$HOME/.zenith-live/azure-evidence.json"
npx tsx scripts/acceptance/live/azure/run.ts --cleanup --packet "$HOME/.zenith-live/azure-packet.json" --permissions "$HOME/.zenith-live/permissions.json" --out "$HOME/.zenith-live/azure-cleanup-evidence.json"
```

Expected: actual data-plane/build/source/sovereign readbacks for every clause, consumed human destroy approvals, complete independent inventories empty except reviewed bootstrap IDs. Offline fakes or missing sovereignty are not a live pass. Mac profile is one provider/fixture and worker at a time, two small replicas maximum, 4 GiB Docker. No new table, migration or production caller changes; assembler registers custom test config and joins Wave 5 emission/tagging. Suggested harness status: implementation_complete_verification_pending.


## Wave 6 final integration

Status remains `implementation_complete_verification_pending`. Node 22 only. Execute sequentially with Docker Desktop 4 GiB and one kind node; stop each heavy profile before starting another. Live acceptance stays deferred until separate owner approval.

```bash
node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-04 --print > /tmp/zenith-wave6-PROD-LIFE-04.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).
