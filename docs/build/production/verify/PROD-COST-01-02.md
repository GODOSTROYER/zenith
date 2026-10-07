> Assembly note (wave 4): this migration was authored as version 40 and is registered as version 37 in `prod/compose` (aggregate `0023_platform_core.sql`). Read "40" below as 37; the file is now `0037_actual_spend.ts`.

# PROD-COST-01 and PROD-COST-02: dated price catalog, complete costs, actual spend

Branch `prod/cost-01-02-w4`, base `c9a942d6`. Build only: nothing here was run (no vitest, no database, no cloud). Typecheck (`npx tsc --noEmit -p .`, Node 22) and `eslint` on every changed file were clean at the last run. COST-03 interfaces (`src/lib/placement/optimizer*.ts`) are untouched; the optimizer keeps consuming the same catalog and `estimateGraphCost` API, which only gained optional fields.

## 1. Summary

### PROD-COST-01 (source-backed dated catalog; estimate / forecast / actual spend)

| Piece | Files |
|---|---|
| Refresh tooling (offline from saved official files, dated provenance, checksums) | `src/lib/placement/catalog-refresh/{types,snapshots,common,normalize-aws,normalize-gcp,normalize-azure,normalize-oci,merge,refresh,index}.ts`, `scripts/cost/refresh-catalog.ts` (`npm run cost:catalog`) |
| Gated live download of public price files | `src/lib/cost/catalog-fetch.ts` (`ZENITH_LIVE_CATALOG_REFRESH=1`; GCP also `ZENITH_LIVE_GCP_CATALOG_API_KEY_FILE`) |
| Catalog schema additions (optional `tiers` on `gb` entries, optional `snapshots[]` with sha256/bytes/url/date) | `src/lib/placement/types.ts`, `src/lib/placement/pricebook.ts` |
| Estimate / Forecast / ActualSpend as three types, forecast and comparison helpers | `src/lib/cost/kinds.ts` |
| Actual-spend reader interface and provider adapters (AWS Cost Explorer + SigV4, GCP BigQuery billing export, Azure Cost Management, OCI Usage API + request signing), live gate | `src/lib/cost/billing/{types,gate,reader,aws,gcp,azure,oci,dates,live,index}.ts` |
| Persistence | migration `src/lib/controlplane/db/migrations/0037_actual_spend.ts` (registered as 37), repo `src/lib/controlplane/db/repos/actual-spend.ts`, `repos/index.ts` |
| Service and REST route (GET view, POST gated refresh) | `src/lib/cost/spend-service.ts`, `src/app/api/platform/v1/environments/[id]/spend/route.ts`, classification in `src/app/api/platform/v1/_lib/bearer-paths.ts` (GET bearer-capable, POST browser-only) |
| Wording that never calls an estimate a cap | `src/lib/cost/wording.ts` (notices, `findCapClaims` guard), `explain.ts`, `placement-comparison.tsx` |

### PROD-COST-02 (complete placement costs and constraints)

| Piece | Files |
|---|---|
| Egress volume tiers in the cost engine (marginal, blended unit price shown, exclusion note replaced when used) | `src/lib/placement/cost-model.ts` (`tieredUsd`, `Ledger.post`), `cost.ts` |
| Extended dimensions: inter-AZ transfer, storage I/O requests, cross-region backup copy; priced only when usage is supplied AND the catalog has the price, otherwise the estimate is refused | `src/lib/placement/extended-costs.ts`, `cost.ts`, `types.ts` (`ExtendedUsageAssumptions`, `CostUsage`), `recommend.ts` (zod usage), solver seed (`solver.ts`) |
| Coverage report: which dimensions each provider/region is priced for | `costDimensionCoverage` in `extended-costs.ts` (printed by the refresh report) |
| Feasibility refusal for budget, residency, availability (typed report, binding blockers, cheapest budget miss, remedies) | `src/lib/placement/reasons.ts`, `feasibility.ts`, `solver.ts` (budget reason via `budgetReason`), `recommend.ts` (`feasibility`, `disclosure` fields), `explain.ts`, MCP tool `src/lib/agent-access/v3/tools/placement.ts` (output only), planner UI `placement-comparison.tsx` + `placement-planner.tsx` |

Already present before this change and left as is: NAT hours and GB, public IPv4 hours, load balancer hours/capacity, internet egress (first tier), cross-region and cross-cloud transfer, object/queue/DNS requests, provisioned IOPS, backups and snapshots, logs.

Docs: `docs/platform/operations/COST.md` rewritten sections (kinds, caps, spend API, extended dimensions, refresh tool, remaining gaps). `tests/docs/operator-docs.test.ts` had one assertion for the old text "Forecasts and actual spend still have no ingestion path"; it now asserts the new "a scheduled collector that stores spend periodically does not exist".

## 2. Acceptance mapping

PROD-COST-01: "Refreshable official-source-backed catalogs replace weak values and distinguish estimates/forecasts/actual spend."

| Clause | Implementation | Tests |
|---|---|---|
| Refreshable from official sources | normalizers for the four official formats, `applyRefresh`, CLI `apply`, gated `fetch` | `tests/cost/catalog-refresh.test.ts` |
| Dated provenance and checksum | manifest with sha256/bytes/url/date per file; checksum verified before use; refreshed catalog records `snapshots[]`, a new dated source per provider and a per-entry note with the snapshot hash prefix | "snapshot integrity", "applyRefresh and the refresh pipeline" |
| Replace weak values | entries read from a file become `official_api`; entries without a rule keep their old value AND evidence class and are counted (`notRefreshedCount`, `weakRemainingCount`); >50% moves and drops to zero are flagged, not applied | "flags a price jump", "keeps un-refreshed entries" |
| Runs offline from saved snapshots in tests, no live calls | fixtures under `tests/cost/fixtures/price-snapshots` (contract-level, hand-built in the documented shape, checksummed) | whole file; `fetch` only with an injected in-memory `fetch` and a closed gate |
| Estimate, Forecast, ActualSpend separate | `kinds.ts` discriminated types; `cost_estimates` accepts only estimates, `actual_spend_snapshots` only `actual_spend` with a response checksum (DB check constraint too); forecast derived only from actual spend | `tests/cost/kinds.test.ts`, `tests/cost/actual-spend-store.test.ts`, `tests/cost/spend-service.test.ts` |
| Actual spend reader interface, provider adapters behind live gating | `ActualSpendReader`, four adapters, `billingGate`, `createLiveBillingReader` (refuses before reading the credentials file or calling fetch) | `tests/cost/billing.test.ts` (recorded responses, contract level); `tests/cost/live-billing.live.test.ts` (skipped without opt-in, never counted as passed) |

PROD-COST-02: "Include egress/NAT/IPv4/IO/requests/backups; reject infeasible budgets/residency/availability; estimates never represented as hard billing caps."

| Clause | Implementation | Tests |
|---|---|---|
| Egress including tiers | catalog `tiers` + engine marginal pricing (internet and cross-cloud), tiers produced by the refresh normalizers | `tests/placement/extended-costs.test.ts` ("egress volume tiers"), `catalog-refresh.test.ts` ("flows through the cost engine") |
| NAT (hourly + GB), IPv4 hourly, IO, requests, backups | base model (existing) plus extended inter-AZ, storage I/O requests, cross-region backup copy; coverage report states what each catalog prices | `extended-costs.test.ts`, existing `tests/placement/cost.test.ts` |
| Missing price is never zero | supplied extended usage without a catalog price throws `MissingPriceError`; solver turns it into a `price:` rejection | "refuses to estimate a supplied dimension the catalog has no price for", "flows through the solver" |
| Reject infeasible budget / residency / availability | `assessFeasibility`: typed `feasibility` on the recommendation (REST, action, MCP data), binding blockers, nearest budget miss, remedies | `tests/placement/feasibility.test.ts` |
| Never a hard billing cap | `BUDGET_NOTICE`/`ESTIMATE_NOTICE`, `disclosure: { isBillingCap: false }`, `budget.notABillingCap`, UI subtitle and infeasible callout, wording guard over product copy | `tests/cost/kinds.test.ts` ("wording"), `feasibility.test.ts` |

## 3. Verification commands (other machine)

Node 22, repository root.

```
npx vitest run tests/cost tests/placement tests/docs/operator-docs.test.ts tests/middleware/platform-bearer.test.ts tests/capabilities/routes.test.ts tests/agent-v3 tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts
```

Expected: all pass, except:
- `tests/controlplane/migrations.test.ts` (run it too) fails until the orchestrator adds `actual_spend_snapshots` to its table list (see section 4).
- `tests/cost/live-billing.live.test.ts` cases show as SKIPPED with the reason in the title (never passed). With no env they must be skipped, not failed.
- `tests/cost/actual-spend-store.test.ts` and `tests/controlplane/tenancy.test.ts` run on PGlite always; set `ZENITH_TEST_PLATFORM_PG_URL` for the PostgreSQL lane.
- `tests/cost/billing.test.ts` "reproduces the documented get-vanilla signature" uses AWS's published SigV4 test vector written from memory (signature `5fa00fa3...fbf31`). If only that case fails, check the vector against AWS's SigV4 test suite before suspecting the signer; the signer's structure is also covered by the other cases.

Offline tooling smoke (no network):

```
npm run cost:catalog -- apply --snapshots tests/cost/fixtures/price-snapshots --version 2026-10-07.1 --out <tmp>/catalog.json
npm run cost:catalog -- age --now 2026-10-15T00:00:00Z --max-days 45
```

Expected: `apply` prints "updated", "flagged 1 or more (aws.fargate.vcpu_hour not applied)", exits 2 because a flagged change was not applied; `age` prints 10 days and exits 0.

Live (deferred by the user, run only with explicit opt-in; none was run):

```
ZENITH_LIVE_CATALOG_REFRESH=1 npx vitest run tests/cost/live-billing.live.test.ts
ZENITH_LIVE_AWS=1 ZENITH_LIVE_AWS_BILLING_CREDENTIALS_FILE=<abs> ZENITH_LIVE_AWS_BILLING_SCOPE=<12-digit account> npx vitest run tests/cost/live-billing.live.test.ts
```
(same pattern for GCP, AZURE, OCI; see the file header for the credentials file shapes).

## 4. Known gaps, risks, and shared-file updates for the orchestrator

Gaps (explicit):
- The bundled catalog `2026-10-05.2` was NOT refreshed. It has no `tiers`, no inter-AZ, storage I/O or cross-region backup copy prices and no snapshots list. The tooling and engine support them; a real refresh from live files must be run, its report reviewed, and the result adopted as a new dated artifact (steps in `COST.md`). Until then egress is first-tier-only and the three extended dimensions refuse when usage is supplied.
- The normalizer rules encode the documented shapes of the AWS Price List, GCP Cloud Billing Catalog, Azure Retail Prices and OCI price list files. They are tested against hand-built fixtures in those shapes, not live files; some usage-type, meter-name and unit strings may need adjustment on the first live refresh. Rules cover networking, egress, NAT, IPv4, block storage, snapshots, requests, DNS, logs and the main AWS compute/database/cache classes; GCP/Azure/OCI compute and database SKUs have no rule yet and stay as they were.
- AWS regional EC2 offer files are very large; `catalog-fetch.ts` refuses files over 450 MB rather than truncating. Use a pre-filtered saved copy in that case.
- Actual-spend adapters were exercised only against recorded, hand-built responses. Credentials come from an operator-supplied file named by `ZENITH_LIVE_<PROVIDER>_BILLING_CREDENTIALS_FILE`; they are not bound to the Zenith credential broker (that lives in the execution core, which this wave must not touch). Billing refresh is POST, browser-session only, scope derived from the environment's own verified connection, repeat reads inside ten minutes served from storage. It is not admin-gated (no broker method for that was added) and there is no scheduled collector: spend is stored only when a person asks. GCP additionally needs `ZENITH_GCP_BILLING_EXPORT_TABLES` (JSON map project id to export table).
- Forecast is a run-rate only (floor plus observed daily average); it does not model credits, refunds or billing lag, and says so.
- Extended usage fields (`interAzGb`, `storageIoMillions`, `crossRegionBackupCopyGb`) are accepted by the REST/action constraint schema (`RecommendConstraints`) but deliberately NOT added to the MCP `zenith_recommend_placement` input schema: that would change its pinned schema digest in `tests/agent-v3/golden/catalog.json` and needs a schema version bump decision. The MCP tool output gained `feasible`, `disclosure` (data) and `feasibility` (untrusted).
- The planner UI shows the feasibility callout; no new screen was built for actual spend (the REST route and typed view exist; no page reads them yet).
- Not verified: the SQL migration and repo (PGlite/PostgreSQL run pending), the feasibility test assumptions about specific rejection mixes (they assert kinds present, not exact counts), and every test in this change.

Things most likely to break first on the other machine:
1. `tests/cost/billing.test.ts` SigV4 vector (see above).
2. `tests/cost/catalog-refresh.test.ts` expectations that depend on the base catalog values (for example the Fargate vCPU flag assumes the bundled `0.04048`, which the current catalog has).
3. `tests/docs/operator-docs.test.ts` COST.md assertions (I added sections; the verbatim included/excluded lists for the default estimate are unchanged).
4. `tests/placement/feasibility.test.ts` availability/residency cases that depend on the latency table's OCI zone counts (`oci/ap-mumbai-1` has 1 zone per the existing solver test).

Shared-file updates the orchestrator must make (I did not touch these):
- `src/lib/controlplane/db/migrations/emit.ts`: hardening grant for `platform.actual_spend_snapshots` (service_role: select, insert only), and regenerate `supabase/migrations/*` (the migration is `0037_actual_spend.ts`, version 37, table below).
- `tests/controlplane/migrations.test.ts`: add `actual_spend_snapshots` to the expected table list.
- `docs/platform/operations/DEPLOYING.md`: inventory row for migration 37; document `ZENITH_LIVE_<PROVIDER>=1`, `ZENITH_LIVE_<PROVIDER>_BILLING_CREDENTIALS_FILE` (AWS, GCP, AZURE, OCI), `ZENITH_GCP_BILLING_EXPORT_TABLES`, `ZENITH_LIVE_CATALOG_REFRESH`, `ZENITH_LIVE_GCP_CATALOG_API_KEY_FILE`. These live outside `src/lib/placement` and the other scanned module roots, so `operator-docs.test.ts` does not require them, but operators need them.
- `scripts/ci/gate-manifest.mjs` / `.github/workflows/*`: register the new test files (`tests/cost/*.test.ts`, `tests/placement/extended-costs.test.ts`, `tests/placement/feasibility.test.ts`); `live-billing.live.test.ts` must be reported as skipped, never passed, when ungated.
- `docs/LIMITATIONS.md` line about cost: forecast and actual spend now have a gated code path (not run live); catalog refresh tooling exists but the bundled catalog is unrefreshed.
- Ledger/PROGRESS: see section 5.

Platform schema inventory (new):
- Table `platform.actual_spend_snapshots` (tenant column `workspace_id`, RLS enabled, no policies, `anon`/`authenticated` revoked, `service_role` select+insert). Unique `(workspace_id, provider, scope, period_start, period_end, response_sha256)`.
- Store functions (both already classified in `tests/controlplane/tenancy.test.ts`, which I edited): `actualSpend.insertActualSpend` (workspace-bound write, in `WRITES`), `actualSpend.listActualSpend` (swept: foreign workspace B gets nothing; A's row seeded). `controlplane-sql-scoping.test.ts` needs no entry (every statement carries `workspace_id`).
- No workflow or Temporal wiring is needed. Gate wiring: see above.

Test files I edited outside my own: `tests/docs/operator-docs.test.ts` (one assertion), `tests/placement/catalog.test.ts` (extended SKUs are not orphans), `tests/controlplane/tenancy.test.ts` (classification), `tests/middleware/platform-bearer.test.ts` (two route rows).

Verified behaviour changed: none intentionally. Default-catalog estimates, solver results and rejection reasons are byte-identical (the budget reason is now built by `budgetReason` with the same text; the solver seed includes extended usage only when supplied).

## 5. Suggested ledger implementationStatus

PROD-COST-01 and PROD-COST-02 (same string):

`implemented_unverified: refresh tooling (offline from checksummed snapshots, gated fetch), tiered egress and extended cost dimensions in the engine, typed estimate/forecast/actual-spend with gated provider billing adapters and a stored spend view, and typed feasibility refusal built; the bundled catalog is not yet refreshed, live billing and live price downloads have not been run, and nothing has been test-run`
