# PROD-LIFE-05 and PROD-LIFE-06 verification packet

Branch `prod/life-05-06-w4`, base c9a942d6. Build only: nothing below was run by the author except TypeScript typecheck, ESLint on the changed TypeScript, and `go build` / `go vet` / `gofmt -l` on `go/`. No test, database, Docker, OpenTofu or cloud call was executed. Live cloud acceptance is deferred by the user; every cloud-facing test here is contract level (scripted provider shapes) and says so.

No platform migration, no new table, no new store function and no new workflow or gate wiring is needed. Migration 39 was reserved and is **unused**: work requests are OCI's own durable receipts, and the runner journal already persists the receipt, so a control-plane table would have duplicated the wave-3 effect ledger (DUR-xx, not in this base).

## 1. What was built

### PROD-LIFE-05 OCI replacement and deletion evidence

| Piece | Files |
| --- | --- |
| Work requests as read-only receipts (strict parse, by-id read, compartment listing, resumable await) | `src/lib/providers/oci/work-requests.ts` |
| Independent deletion-completion evidence per resource family (readback authoritative, work request corroborating, MySQL refused) | `src/lib/providers/oci/deletion-evidence.ts` |
| Runner journal records `opc-work-request-id` for create and delete, exposes it in the receipt query, restores compartment bindings from the journal on load, serves only journal-owned work-request reads | `go/internal/runner/kinds/ocihttp_receipts.go`, `ocihttp.go` |
| Allowlist: by-id work-request read for `deployment.deploy`; six compartment work-request listings for `infrastructure.observe` and `incident.investigate`; regenerated Go contract; protocol doc | `src/lib/providers/oci/allowlist.ts`, `runner-transport.ts`, `go/internal/oci/testdata/allowlist.json`, `go/internal/oci/oci_test.go` (sizes 58/58/11), `docs/platform/RUNNER-PROTOCOL-OCI.md` |
| Migration port: replacement runner resumes by reading the journal's create work request (FAILED/CANCELED refused as unknown, unreadable or in flight does not block instance readback); cleanup is independently confirmed (GET state or 404 plus complete listing, delete work request by id) and only logged, never changing the observed exit code | `src/lib/providers/oci/release/migrations.ts` |
| Destroy verification: for an OCI node a driver `missing` stands only if family readback agrees; MySQL, unregistered types and unreadable evidence give `unknown`; `basis` is recorded in the verification checks | `src/lib/execution/destroy.ts` (verify hook) |

Behaviour preserved: a launch whose response was lost leaves a durable intent with no instance id and no work-request id. It stays `unknown`, is never relaunched, and no work request is consulted for it (`ocihttp_receipts_test.go`, `release.test.ts`, `release-work-requests.test.ts`). OCI MySQL stays read-only and refused (`drivers/data/mysql.ts` untouched; `deletion-evidence.ts` returns `unsupported` with a fixed MySQL reason).

Honest limits (also for LIMITATIONS):
- The runner binds every OCID to a trusted compartment. A work-request OCID can be bound only by the runner's own journal, so by-id work-request reads exist only for runner-launched container-instance migrations. Every other family reads work requests through the compartment listing (`?compartmentId=`) filtered by the resource id, and OpenTofu-driven deletes expose no work-request id at all, so for them the evidence is readback plus the listing. Load balancer, Core, DNS, certificates, artifacts, vault, identity and Object Storage have no work-request evidence; their deletion rests on readback alone.
- "Replacement runner recovery" means a replacement process that inherits the durable journal (`auditPath`), as `loadReceipts` already required. A runner with no journal has no receipt and no binding, cannot read the ids, and the control plane keeps the execution `unknown` rather than guessing (it cannot adopt a tagged instance).
- Work-request paths and shapes follow the OCI API reference and were not exercised against a live tenancy.

### PROD-LIFE-06 non-AWS ownership-safe DNS teardown

The native teardown path (guards before review, after the saved plan inspection and after the final human-approval lookup, fixed refusals, `infrastructure.plan` read grant for OCI) was already integrated by the 2026-10-04 handoff (`docs/build/handoffs/NON-AWS-DNS-TEARDOWN-20261004.md`) and is retained. This work adds the missing proof binding, the idempotent readback classification and the live harness.

| Piece | Files |
| --- | --- |
| Per-record-set ownership proof (`DnsRecordSetProof`: provider, zone, name, type, present/absent, sorted values, ownership basis list, state match), deterministic digest, review summary fragment, apply-time equality check, deleted / already_absent / still_present / unknown classification | `src/lib/providers/dns-teardown-proof.ts` |
| Assessors now return the proof they already derived (no new reads, call counts unchanged). GCP: forwarding-rule labels plus value equals rule IP. Azure: record tags, endpoint tags, value match, `asuid` TXT marker. OCI: load balancer tags plus rdata inside its addresses. All: zone readable, and state match when the recorded provider id agrees | `src/lib/providers/gcp/dns-ownership.ts`, `azure/dns-ownership.ts`, `oci/dns-ownership.ts` |
| Review stores `dnsOwnership` (digest and records) in the plan summary; apply recomputes proofs after the final approval lookup and in plan inspection and refuses with a fixed message unless they equal the reviewed ones; a safe non-AWS verdict with no proof is refused; verify classifies each record set against its review and refuses to count absence for a record set with no reviewed proof | `src/lib/execution/destroy.ts` |
| Gated live harness (never calls a cloud; drives the real control plane; cannot approve) | `scripts/acceptance/non-aws-dns-live.ts`, `scripts/acceptance/clients/control-plane.ts` (adds `requestTeardownReview`, `getTeardownReview`) |

Destructive approval binding: the human approval still binds the plan digest (the tofu plan "before" state already carries the record values). The proof digest additionally pins which record sets, values and ownership facts were reviewed, so a re-pointed or foreign record between review and apply is refused even if a stale plan digest were presented.

Honest limits: GCP and OCI record sets carry no tags, so their ownership basis is the labelled/tagged target plus an exact value match plus state match; Zenith does not create a dedicated TXT owner marker at deploy time (that would change deployments and plans, out of scope). Azure already has record tags and the companion `asuid` TXT. Deletion itself remains OpenTofu's saved-plan apply; idempotence is its state/refresh behaviour plus the already_absent readback class. A point-in-time guard does not prove later quiescence. No live GCP, Azure or OCI deletion was performed.

## 2. Acceptance mapping

| Clause | Implementation | Tests |
| --- | --- | --- |
| PROD-LIFE-05: same-runner receipts and lost-response uncertainty preserved | `ocihttp_receipts.go` (work-request ids added, intent-without-instance still `unknown`); `migrations.ts` (`unknown` never consults a work request) | Go `TestOCIMigrationReceiptUnknownNeverRelaunches` (existing), `TestOCIMigrationReceiptTimeoutKeepsUnknownIntent` (existing), `TestOCIMigrationReceiptRecordsWorkRequestIDsAndAnswersOnlyOwnedReads`; `tests/providers/oci/release-work-requests.test.ts` "lost-response uncertainty is preserved"; existing `release.test.ts` |
| Independent deletion completion proven, per resource family | `deletion-evidence.ts` `DELETION_FAMILIES`; `destroy.ts` verify hook; `migrations.ts` cleanup confirmation | `tests/providers/oci/deletion-evidence.test.ts` (every family: TERMINATED/DELETED, 404 with and without listing corroboration, truncated, denied, throttled, malformed, deleting, present, simulated; work-request corroboration cases; table vs drivers and allowlist); `release-work-requests.test.ts` "cleanup completion is independently confirmed" |
| Runner replacement recovery proven | Go journal binds and serves journal-owned work-request reads; `migrations.ts` `checkCreateWorkRequest`; `work-requests.ts` `awaitWorkRequest` | Go `TestOCIReplacementRunnerResumesWorkRequestReadsWithoutReexecution`, `TestOCIMigrationReceiptWorkRequestJournalValidation`, `TestOCIMigrationReceiptDeleteWorkRequestIsRecorded`; `tests/providers/oci/work-requests.test.ts`; `release-work-requests.test.ts` "replacement runner recovery" |
| MySQL remains unsupported | `deletion-evidence.ts` `MYSQL_NATIVE_TYPE` refusal; `mysql.ts` unchanged (no compile) | `deletion-evidence.test.ts` "explicit refusals", family-table coverage test; existing `tests/providers/oci/mysql.test.ts` |
| PROD-LIFE-06: ownership proof per record set | `dns-teardown-proof.ts`; assessors return `proof` | `tests/providers/dns-teardown-proof.test.ts` (each provider's proof content, foreign/unreadable have none); `tests/execution/destroy-dns-ownership.test.ts` "stores a per-record-set ownership proof" |
| Refusal for foreign/unreadable records | Existing assessors (unchanged semantics) plus "no proof, no teardown" in `guardDns` | Existing `tests/providers/{gcp,azure,oci}/dns-ownership.test.ts` and `destroy-dns-ownership.test.ts` refusal cases; `dns-teardown-proof.test.ts` "a foreign or unreadable record set has no proof" |
| Destructive approval binding | `destroy.ts` `bindDnsProofs` at final dispatch guard and plan inspection | `destroy-dns-ownership.test.ts` "refuses apply when the reviewed ownership proof is removed / altered / digest forged" (all three providers); `dns-teardown-proof.test.ts` binding cases |
| Idempotent delete with readback | `dnsDisposition` plus verify hook | `destroy-dns-ownership.test.ts` "classifies the deleted record set against its review ... already_absent", "does not count absence for a record set whose review proof is missing"; `dns-teardown-proof.test.ts` classification table |
| Contract tests with recorded API shapes; live harness gated | Fixtures reused: `tests/providers/{gcp,azure,oci}/dns-ownership-fixtures.ts`, plus scripted work-request shapes | `tests/acceptance/non-aws-dns-live.test.ts` (gate and harness logic against a fake control plane; live suites `describe.skipIf`, skipped with an explicit reason) |

## 3. Verification commands (other machine)

Node 22. No new env is required for the contract tests.

```sh
npx tsc --noEmit -p .
npx eslint src/lib/providers/dns-teardown-proof.ts src/lib/providers/oci/work-requests.ts src/lib/providers/oci/deletion-evidence.ts src/lib/providers/oci/release/migrations.ts src/lib/providers/oci/allowlist.ts src/lib/execution/destroy.ts scripts/acceptance/non-aws-dns-live.ts

# TypeScript (expected: all pass; the live suites report as skipped)
npx vitest run --maxWorkers=1 \
  tests/providers/oci/work-requests.test.ts tests/providers/oci/deletion-evidence.test.ts tests/providers/oci/release-work-requests.test.ts \
  tests/providers/oci/release.test.ts tests/providers/oci/allowlist.test.ts tests/providers/oci/allowlist-observability.test.ts tests/providers/oci/mysql.test.ts \
  tests/providers/dns-teardown-proof.test.ts tests/providers/gcp/dns-ownership.test.ts tests/providers/azure/dns-ownership.test.ts tests/providers/oci/dns-ownership.test.ts \
  tests/execution/destroy-dns-ownership.test.ts tests/execution/destroy.test.ts tests/execution/deletion-guards-clouds.test.ts \
  tests/runners/oci-contract.test.ts tests/runners/oci-payload.test.ts tests/acceptance/non-aws-dns-live.test.ts tests/docs

# Go (GOTOOLCHAIN=local, inside go/)
go test ./internal/oci/... ./internal/runner/kinds/...
```

Expected: every listed file passes; `non-aws-dns-live.test.ts` shows nine skipped `LIVE <provider>` tests with the reason in each name and never counts them as passed. `tests/docs` covers the protocol doc listing every allowlist rule and the observability source strings.

Live harness (deferred, run only by a person, sandbox accounts only):

```sh
ZENITH_LIVE_GCP=1 ZENITH_LIVE_API_URL=https://... ZENITH_LIVE_API_TOKEN_FILE=/path/token \
ZENITH_LIVE_GCP_CREDENTIAL_FILE=/path/cred ZENITH_LIVE_GCP_ENVIRONMENT_ID=env_... \
[ZENITH_LIVE_GCP_FOREIGN_ENVIRONMENT_ID=env_repointed] [ZENITH_LIVE_GCP_APPROVED_OPERATION_ID=op_after_human_approval] \
npx vitest run tests/acceptance/non-aws-dns-live.test.ts
```

(`AZURE` and `OCI` likewise.) The harness requests the read-only review, stops at `awaiting_approval` (a person approves the exact digest in the browser), then with the approved operation id waits for `succeeded`.

## 4. Known gaps, risks and shared-file updates

Things most likely to break first:
- `tests/providers/oci/allowlist.test.ts` and `tests/runners/oci-contract.test.ts` depend on the regenerated `allowlist.json` and the exact doc text; `go/internal/oci/oci_test.go` sizes were changed by hand to 58/58/11 and not run.
- `release.test.ts` now sees extra GETs after a cleanup DELETE (receipt query, instance GET, optional work request). Its assertions use `every`/`filter`, so counts of POST and DELETE are unchanged; confirm on the other machine.
- `src/lib/execution/destroy.ts` is the execution core. The edits are additive hooks only: `guardDns` returns proofs, one summary key, `bindDnsProofs` at the two guard calls in apply, `reviewedDnsOwnership`, and the OCI/DNS lines in `verifyDestroyedInfrastructure`. Wave 3 (DUR-xx) edits this file concurrently, so expect a merge conflict in `guardDns`, the `planStage` summary and the verify loop; resolve by keeping both. A review evidence row without `dnsOwnership` is refused at apply for any non-AWS DNS teardown, so a review taken before this change must be redone.
- Go files were built, vetted and gofmt-checked only. The Go tests use fake transports and an inherited temp journal; they were not run.

Integration for the orchestrator (not edited here):
- `docs/LIMITATIONS.md`: replace the stale "Explicit non-AWS DNS teardown still refuses" clause (line ~158) with the integrated, proof-bound state and the honest limits above; add the OCI work-request limits (journal-only by-id reads, listing for other families, no work-request evidence for Core/DNS/LB/certs/vault/identity/Object Storage) and keep the MySQL line.
- `scripts/ci/gate-manifest.mjs`: register the new test files `tests/providers/oci/{work-requests,deletion-evidence,release-work-requests}.test.ts`, `tests/providers/dns-teardown-proof.test.ts`, `tests/acceptance/non-aws-dns-live.test.ts`, and the Go tests in `ocihttp_receipts_test.go`.
- `docs/platform/operations/TEARDOWN.md`: add the `dnsOwnership` review binding and the already_absent readback class.
- Migrations inventory: nothing (39 unused). Store functions or tenancy classification: none.

## 5. Suggested ledger implementationStatus

- PROD-LIFE-05: `oci_work_request_receipts_and_family_deletion_readback_built_contract_tested_live_oci_and_go_runs_open`
- PROD-LIFE-06: `non_aws_dns_teardown_ownership_proof_bound_to_approval_idempotent_readback_contract_tested_live_acceptance_deferred`
