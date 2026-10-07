# PROD-DUR-05 and PROD-DUR-06 verification handoff

Branch `prod/dur-c-w3`, built on `c9a942d6`. Build only: nothing here was executed by the builder. Only `tsc --noEmit` and `eslint` on the changed files were run (both clean). Every test below was written, not run.

## 1. What was built

Verified contracts preserved: no change to `src/lib/platform/plan-artifacts.ts`, `src/lib/controlplane/db/repos/plan-artifacts.ts`, `cleanup-writer-barriers.ts`, `plan-janitor.ts` or `tests/controlplane/cleanup-writer-barriers.test.ts`. The native100 cleanup-writer barrier, settlement and no-unlink behaviour is untouched. The custody layer wraps the production port from outside, so it cannot alter a verified code path.

### PROD-DUR-05, cross-worker custody and PlanView separation
- `src/lib/controlplane/db/migrations/0032_plan_custody_state_recovery.ts` (registered in `migrations/index.ts`), tables listed in section 4.
- `src/lib/platform/plan-custody-crypto.ts`: worker identity-bound unwrap. A grant holds a random 32 byte token sealed with AES-256-GCM under an HKDF key derived from the plan artifact key, the workspace and the worker identity. AAD binds tenant, consuming operation, source artifact, manifest digest, worker, fence and expiry. Previous plan keys open during rotation.
- `src/lib/controlplane/db/repos/plan-custody.ts`: `admit` (fence, lease, operation liveness, tenant, artifact integrity via manifest digest, expiry, permanent worker revocation, supersession of older fences), `verify` (re-proves identity, tenant, fence, expiry and integrity on every read), `revokeWorker`, `listReads`. Every admit and verify, including refusals, is an append-only `plan_custody_reads` row.
- `src/lib/platform/plan-custody.ts` `withWorkerCustody`: wraps the production `PlanArtifactsPort`. `inspect` and `consume` are admitted and verified before the wrapped port is touched; `publish` admits the producing worker; the `dispatch` callback re-verifies immediately before the one dispatch compare-and-set, so a revoked or superseded worker stops before it applies a plan.
- `src/lib/platform/execution.ts` (reachability): the production composition now builds `planArtifacts` through `withWorkerCustody` using the worker's own `workerIdentity`. The literal `createPlanArtifactRuntime(custodyDb, custodyEnv)` line and the other source strings asserted by `tests/docs/operator-docs.test.ts` are unchanged.
- `src/lib/security/raw-plan-material.ts`: structural detection of raw custody material (sealed records, plan byte carriers, custody manifest shape, binary, base64 zip plan strings). Wired at three places:
  - `src/lib/security/result-sanitizer.ts` (the shared model-visible sanitizer used by MCP v3 envelopes, the control HTTP surface, `zenith-reader` and runner custody) now replaces raw plan records and plan strings with `[REDACTED:raw-plan-material]` and reports the kind.
  - `src/lib/execution/plan-evidence.ts` `planEvidence` asserts the evidence summary is PlanView-only before it can be persisted (fail closed).
  - `src/lib/controlplane/db/repos/operation-review.ts` `projectPlanReview` returns no review when a stored summary contains raw custody material, so the browser, API and MCP PlanView paths cannot render it.

### PROD-DUR-06, state backend capability proof and restore
- `src/lib/tofu/backend-capabilities.ts`: per backend matrix of locking, encryption, versioning (`supported`, `provider_managed`, `unverified`, `unsupported`). Includes S3 (AWS and OCI compatible), GCS, Azure, http, local and `pg`. `assertBackendAdmissible` refuses definite gaps. `restoreRefusals` requires a live probe proving versioning enabled, no lock held, encryption present and an unchanged current version. S3, OCI, GCS and Azure have restore adapters with a conditional write; http, local and `pg` do not.
- `src/lib/execution/compile.ts` `backendFor`: the default (non override) path now refuses a backend that cannot lock or encrypt, with the existing `State backend refused:` wording. Every backend `backendForConnection` can emit is admissible, so existing behaviour is unchanged.
- `src/lib/tofu/state-backend-http.ts` (follow-up): restore adapters for GCS (object generations, `ifGenerationMatch`), Azure Blob (blob versions, `If-Match`, a held lease is never bypassed) and OCI Object Storage (native API object versions, `If-Match`). Each has the S3 guarantees: exact-key listing, digest-verified reads, probe of versioning, encryption and lock, a conditional write that creates a new version, readback by the service, and no delete request anywhere. Authentication uses node crypto only, no new dependency: GCS service account key exchanged for a token at the fixed Google token endpoint (RS256 JWT), Azure user-scoped SAS token, OCI API signing key with rsa-sha256 HTTP signatures. Hosts are built only from validated identifiers. `state-backend-open.ts` dispatches by backend kind and is the service default. Unverified locking (OCI) is tolerated for restore only because the write is conditional and runs under the environment lease.
- `src/lib/tofu/state-backend-s3.ts`: AWS S3. Probe (versioning, SSE, lock object, current version), version listing (exact key), verified reads, `writeRestored` (new version, `IfMatch` on the observed ETag, encryption kept). No delete command exists anywhere in it. Credentials come only from a tenant vault secret with exactly `accessKeyId`, `secretAccessKey`, optional `sessionToken`; no endpoint or region can come from a credential or request.
- `src/lib/controlplane/db/repos/state-backend-recovery.ts`: proposal record bound to the exact effect (`proposal_digest` over backend digest, state key, source version, source SHA-256, current version, credential reference), compare-and-set transitions (`proposed` to `approved` carries the digest in the CAS), `provenOwner`, immutable probe evidence. A database trigger forbids editing a reviewed proposal, invalid transitions and any delete.
- `src/lib/platform/state-recovery.ts`: service. Models and integrations may propose; only a human browser session can approve, reject or execute. Execution re-derives ownership (the backend digest must equal one recorded by a plan artifact of the same workspace and environment, and the key must sit under `zenith/<workspace>/<environment>/`), re-probes, takes the environment lease (`env:<id>`, so apply and destroy cannot interleave), writes the approved earlier version as a new current version, reads it back and proves the digest. Failures after the begin transition are recorded `failed_uncertain` and never retried. Nothing deletes an object, version or lock.
- Reachable via REST under `/api/platform/v1/environments/[id]/state-backend`: `GET` (matrix, last probe, history), `POST probe`, `POST restores` (propose), `POST restores/approve|reject|execute` (browser only). Classified in `_lib/bearer-paths.ts`; composition in `_lib/state-recovery.ts`.
- Janitor clause: unchanged and relied on. Production maintenance logically expires encrypted database artifacts and never unlinks (`plan-janitor.ts`, verified by CI-08 and native100). Physical deletion of plan artifacts or state versions is deliberately not implemented.

## 2. Acceptance mapping

| Clause | Implementation | Tests |
| --- | --- | --- |
| Encrypted immutable plan artifacts work across independent workers | existing immutable `plan_artifacts` plus `plan-custody` grants, wrapper in `execution.ts` | `tests/controlplane/plan-custody.test.ts` (multi worker admit, per worker grants, wrapper order) |
| Tenant access | admit/verify scoped by `workspace_id`, tenant checks on manifest, per workspace key derivation and AAD | `plan-custody.test.ts` foreign tenant case; `plan-custody-crypto.test.ts` workspace binding |
| Integrity on every read | `manifest_digest = digest(manifest)` in admit and verify, AEAD wrap, existing AEAD plus rawSha256 in the paired runtime | `plan-custody.test.ts` tampered wrap, copied grant and edited expiry; crypto tamper cases |
| Expiry on every read | grant expiry capped at the artifact expiry and 15 minutes, artifact expiry rechecked in admit and verify | `plan-custody.test.ts` expired grant renewal and expired artifact cases |
| Independent worker takeover and revocation | fence supersession revokes older grants, `revokeWorker`, dispatch re-verification | `plan-custody.test.ts` superseding fence, revocation, wrapper dispatch revocation |
| Sanitized PlanViews separate from raw sensitive plans | `raw-plan-material.ts`, sanitizer rule, evidence assertion, `projectPlanReview` fail closed | `tests/security/plan-view-separation.test.ts` |
| Janitor writer/unlink race closed | unchanged no-unlink logical expiry | existing `cleanup-writer-barriers.test.ts`, `plan-artifact-retention.test.ts` |
| Supported backends prove locking, encryption, versioning, restore | matrix, probe, adapter, service | `backend-capabilities.test.ts`, `state-backend-s3.test.ts`, `state-backend-recovery.test.ts` |
| Restore without unsafe deletion | no delete path, ownership proof, human approval bound to exact digest, lease, CAS, readback, `failed_uncertain` | `state-backend-recovery.test.ts`; `state-backend-s3.test.ts` source scan for delete commands |
| Explicit refusal where unsupported | http, local, pg and unknown kinds refused with plain reasons; unusable or wrong-provider credentials refused | `backend-capabilities.test.ts`, `state-backend-recovery.test.ts`, `state-backend-http.test.ts` dispatch |
| GCS, Azure, OCI restore with conditional write, readback, no delete | `state-backend-http.ts` | `tests/tofu/state-backend-http.test.ts` (signatures verified, CAS refusals, held lease, no DELETE) |

## 3. Verification commands

Node 22 (`export PATH="/c/Users/user/.local/sdk/node22:$PATH"`). Real engine lane uses the existing gate `ZENITH_TEST_PLATFORM_PG_URL`; the same files also run on PGlite without it.

```
npx tsc --noEmit -p .
npx vitest run tests/platform/plan-custody-crypto.test.ts tests/tofu/backend-capabilities.test.ts tests/tofu/state-backend-s3.test.ts tests/tofu/state-backend-http.test.ts tests/security/plan-view-separation.test.ts
ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/controlplane/plan-custody.test.ts tests/controlplane/state-backend-recovery.test.ts
npx vitest run tests/controlplane/tenancy.test.ts tests/middleware/platform-bearer.test.ts tests/security/result-sanitizer.test.ts tests/security/mcp-secret-leakage.test.ts tests/security/controlplane-sql-scoping.test.ts tests/docs/operator-docs.test.ts
ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/controlplane/cleanup-writer-barriers.test.ts tests/controlplane/plan-artifact-retention.test.ts tests/controlplane/plan-artifacts.test.ts tests/security/plan-artifact-secrecy.test.ts
```

Expected: all new files pass on PGlite and PostgreSQL; the last group is the unchanged verified native100 and custody contracts and must remain at their prior results (cleanup-writer-barriers 100/100). `tests/middleware/platform-bearer.test.ts` was edited: seen route count 65 to 71 and six new route lines.

## 4. Gaps, risks, shared-file updates for the assembler

New tables (all carry `workspace_id`, RLS enabled, `anon` and `authenticated` revoked, `service_role` granted, like migration 7):
- `platform.plan_custody_grants` (tenant, FK to operations): store functions `admit`, `verify`, `revokeWorker`.
- `platform.plan_custody_reads` (tenant, append only): `listReads` and the internal `recordRead`.
- `platform.state_backend_probes` (tenant, append only): `recordProbe`, `latestProbe`.
- `platform.state_backend_restores` (tenant, guarded transitions, no delete): `propose`, `get`, `backendOf`, `list`, `approve`, `reject`, `beginExecution`, `complete`, `failUncertain`, `expireStale`; `provenOwner` reads `plan_artifacts`.
Both repo modules are registered in `repos/index.ts` as `planCustody` and `stateBackendRecovery`, so `tenancy.test.ts` (completeness guard, bindRepos, dynamic foreign-tenant sweep) and `controlplane-sql-scoping.test.ts` cover them. `PlanCustodyError`, `StateRecoveryRecordError` and `restoreProposalDigest` are in `PURE_HELPERS`. Classification as entered in `tests/controlplane/tenancy.test.ts`:

| Function | Class | Notes |
| --- | --- | --- |
| `planCustody.listReads` | SWEPT read | foreign workspace returns empty |
| `stateBackendRecovery.provenOwner`, `latestProbe`, `get`, `backendOf`, `list` | SWEPT reads | each swept as the foreign workspace and must be empty or null |
| `planCustody.admit`, `verify`, `revokeWorker` | WRITES | workspace bound; refusals in `plan-custody.test.ts` |
| `stateBackendRecovery.recordProbe`, `propose`, `approve`, `reject`, `beginExecution`, `complete`, `failUncertain`, `expireStale` | WRITES | workspace bound with guarded transitions; refusals in `state-backend-recovery.test.ts` |
| `planCustody.PlanCustodyError`, `stateBackendRecovery.StateRecoveryRecordError`, `restoreProposalDigest` | EXEMPT | pure, no SQL, excluded from bindRepos |

Assembler updates (also LIMITATIONS: key re-wrap, brokered restore sessions, unproved live providers): migration 32 is registered in `index.ts` but 30 and 31 belong to sibling workers (gap until merged); regenerate emitted SQL and `supabase/migrations`, update `migrations.test.ts` and the schema version expectations, `gate-manifest.mjs` for the seven new test files, `LIMITATIONS.md` and the ledger. `docs/platform/operations` should document the three new routes and `ZENITH_PLAN_ARTIFACT_KEY` reuse by the custody layer (no new env variable).

Known gaps, stated plainly:
- The custody wrap binds authorization and audit to a worker identity and makes a copied grant useless to another identity. It does not stop a process that holds the plan artifact key from decrypting the artifact. Per worker re-wrapping of the artifact with a KMS or HSM data key is not built. Threat model: the grant defends against a stolen or replayed database row, a worker that lost its fence or was revoked, a cross-tenant request and an altered binding; each is refused and audited. It does not defend against a compromised worker process that already holds the plan artifact key (it can decrypt any artifact it can read), nor against an operator with both database and key access. That residual risk is accepted for now because workers must hold the key to apply plans at all; the mitigation path is a per-artifact data key wrapped by a KMS key that only the admitted worker identity may use. This is a recorded limitation, not a claim of per-worker confidentiality.
- `revokeWorker` only reaches workers that already hold grants in the workspace (plus fence supersession). There is no pre-registration list that blocks a never-seen identity.
- Restore adapters exist for S3, GCS, Azure Blob and OCI. http and local are refused with a reason. The pg backend stays explicitly refused: PostgreSQL state has no object versions (recover it from database backups or point-in-time recovery) and Zenith emits no pg backend because its connection string is a credential. No live cloud backend was exercised: adapter tests use scripted in-memory servers (OCI and GCS signatures are verified with the real public key), so real provider behaviour is unproved. Specific unproved assumptions: GCS lock object name `<prefix>/default.tflock`; Azure versioning inferred from the `x-ms-version-id` response header (cannot tell disabled from suspended) and the SAS must grant read, write and list; OCI native `objectversions` listing shape and `version-id` response header; S3 `IfMatch` writes.
- Restore credentials are a tenant vault secret referenced by `credentialsRef` (S3 keys, GCS service account key, Azure SAS, OCI signing key), like portability storage. The brokered workload-identity sessions (`GcpSession`, `AzureSession`, OCI runner transport) are not used: they exist only inside a granted operation, the default Azure broker authorizes only bound source storage, and the OCI runner transport is JSON-only with a bucket-level path allowlist. A brokered restore path is a documented gap.
- Restore is REST and browser only. No MCP tool and no product UI page were added (the approve and execute routes are browser-only by design).
- Proposal expiry by clock (`expires_at`) is enforced in SQL predicates but has no timed test because the field is immutable by trigger.
- Physical retention and pruning of plan artifacts or state versions is not implemented and not approved. It stays a separate operator-policy item.
- Concurrent DUR-A (intent/outbox), DUR-B (approval/dispatch) and DUR-D (uncertain mutation dedup) were not touched. `withWorkerCustody` composes around the port, so DUR-B changes to dispatch authority only need to keep the `dispatch` callback signature.
- Verified behaviour changes: none to native100 paths. Behavioural additions: production artifact operations now fail with `plan_custody_refused` if the worker identity is not valid (`^[A-Za-z0-9._-]{1,64}$`, already enforced by worker config) or the lease or operation is not live at admission; `compile.ts` now refuses a backend that cannot lock or encrypt.

## 5. Suggested ledger implementationStatus

PROD-DUR-05: `source_complete_unexecuted: worker identity bound custody grants with audit and dispatch re-verification wired into the production composition; raw plan material separated at evidence, PlanView projection and the model-visible sanitizer. Tests written, not run.`

PROD-DUR-06: `source_complete_unexecuted: backend capability matrix with live probes (S3, GCS, Azure, OCI), human approved non destructive versioned restore with readback and lease exclusion; GCS, Azure and OCI adapters with conditional writes; http, local and pg refused explicitly; janitor unchanged. No live backend proof; tests written, not run.`
