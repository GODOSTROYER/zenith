# PROD-MAN-06 Separable metering and billing

Branch `prod/man-06-w5`, base `c02c097e`. Platform migration `51` (`0051_billing`). Build only: nothing here has been run by the
builder except `tsc --noEmit -p .` and `eslint` on every changed and new file (both clean). No test, database or provider call was run.

Requirement: "Metering/quotas/plan assignment/invoice/payment-webhook reconciliation and safe suspension/export operate; BYOC/self-hosted do
not require Zenith billing."

Commercial status: DEC-BUSINESS (pricing, terms, payment accounts) is NOT decided and PROD-MAN-07 is separate. Every plan is a placeholder
marked `provisional` (`provisional: true`, ids end in `_provisional`, every view carries `PLAN_NOTICE`). Stripe is TEST mode only: the adapter
refuses any key that is not `sk_test_`/`rk_test_`. No key, webhook secret or provider id is committed; every test generates its own at run time.

Audit of existing billing/Stripe code before building: there was none in `src`. "Stripe" appeared only as secret-shape detectors
(`capabilities/secret-guard.ts`, secrets backend, env panel) and test fixtures. `src/lib/cost/billing/*` is the unrelated provider-cost
reader (PROD-COST-01, a customer's own cloud bill), and `src/lib/hosted/usage` is the hosted-apps product's own spend estimate (SQLite/hosted
schema); neither is touched. Billing here is a new, separable module that reads the platform schema.

## 1. Summary of what was built

New module `src/lib/billing/` (all reachable from real callers):

| File | Role |
|---|---|
| `config.ts` | `ZENITH_BILLING` = `disabled` (default) or `managed`; an unknown value is `disabled` and reported. Stripe test-key check, grace/net days, loopback-only API base seam |
| `plans.ts` | The provisional plan catalog (`free_/team_/scale_provisional`), meters (3 billable, 2 informational), quotas (`maxActiveOperations`, per-meter `included`/`rateCents`/`hardCap`), `PLAN_NOTICE` |
| `period.ts` | UTC calendar-month periods |
| `store.ts` | All SQL (accounts, account events, usage, invoices, webhook events). No delete anywhere. Tenancy classification in the file header |
| `metering.ts` | Usage from durable records: managed resource hours (`platform.resources`), build minutes (`platform.build_launches`, terminal), storage GB (`platform.portability_exports`), operations executed (`platform.operations`), egress GB ESTIMATE from `platform.cost_estimates` (flagged `estimated`, never charged). Idempotent, level-triggered, bounded, closed once invoiced |
| `invoice.ts` | `priceInvoice` (pure) and `generateInvoice` (ended period only, one invoice per workspace and period, exact lines frozen in a `draft` row, provider call with idempotency keys derived from the row id, zero total = `no_charge`, provider failure leaves the draft and retries identically) |
| `provider.ts` | `InvoiceProvider` adapter interface and typed errors |
| `stripe.ts` | `StripeTestInvoiceProvider` (form-encoded v1 customers/invoices/invoiceitems/finalize with `Idempotency-Key`, `send_invoice`, no card, no PII) and the documented `Stripe-Signature` scheme: `signStripePayload`, `verifyStripeSignature` (HMAC-SHA256 over `t.payload`, constant-time, multi-`v1`, 300 s tolerance both directions) |
| `webhook.ts` | `handleStripeWebhook`: managed-only, bounded raw body, signature BEFORE parse and store, one-transaction idempotent reconcile (event id first-writer-wins, our invoice matched by provider id AND workspace metadata, amount check, terminal `paid`, stale-failure ignore, draft adoption for the crash window). Stores digest + outcome only |
| `standing.ts` | Dunning and safe suspension: standing derived from durable invoices (`active` -> `past_due` -> `suspended`/nonpayment, grace measured from the oldest unpaid due date), payment lifts it, operator suspension is never lifted automatically. Holds no delete path |
| `admission.ts` | `assertBillingAdmitted`: called from `assertDispatchAdmitted`. Suspended -> 402 `billing_suspended`; plan active-operation cap and hard usage caps -> 429 `plan_quota_exceeded`. `export` and `destroy` dispatch are never refused. `disabled` returns before any I/O. Store outage keeps the last known standing (never suspends a payer, never lifts a suspension) |
| `export.ts` | `buildTenantExport`: workspace-bound, bounded per section with `truncated`, secret-scrubbed, digest-checked; works in every billing state including `disabled` |
| `service.ts` | `runBillingTick` (collect usage for previous+current period, invoice the ended period after a 6 h settle window, run dunning), `billingView`, `invoiceProviderFromEnv` |

Other changed or new files:

- `src/lib/controlplane/db/migrations/0051_billing.ts` and its registration in `migrations/index.ts`.
- `src/lib/ops/errors.ts`: two additive codes `billing_suspended` (402), `plan_quota_exceeded` (429) and layer `billing`.
- `src/lib/ops/admission.ts`: `DispatchKind` gains `"export"`; `assertDispatchAdmitted` calls `assertBillingAdmitted` right after the maintenance check (before the dispatch bucket), so the guard order is unchanged: OPS-02 admission -> DUR-A -> DUR-B -> DUR-C -> DUR-D -> provider. The refusal happens before the claim, exactly like OPS-02's.
- `src/lib/portability/start.ts`: passes `kind: "export"` for `data.export` (so export stays dispatchable while suspended) and `"dayTwo"` for import/adopt/release.
- Routes (platform tenant surface): `GET /api/platform/v1/billing` (member), `GET /api/platform/v1/billing/export` (admin), `POST /api/platform/v1/billing/webhook` (signature). Classified in `bearer-paths.ts` as `browser-only`, `browser-only`, `webhook-signed`.
- Routes (operator, `ZENITH_OPS_ADMIN_IDS`, same-origin writes): `GET|PUT /api/admin/billing/assignment`, `GET|POST /api/admin/billing/invoices`, `POST /api/admin/billing/suspension`.
- Scheduled pass: `POST|GET /api/internal/tick/billing` (cron bearer first, control store only).
- `tests/middleware/platform-bearer.test.ts`: the classified-route count `97` -> `100` (three new platform routes; the assembler may need to re-merge this number with siblings).
- Tests: `tests/billing/_support.ts`, `billing-unit.test.ts`, `billing.engine.test.ts`, `billing-routes.test.ts`.

Database objects (migration 51): `platform.billing_accounts`, `billing_account_events`, `billing_invoices`, `billing_usage_events`,
`billing_webhook_events`. RLS enabled, no anon/authenticated grants, service role only. Triggers: accounts/invoices/webhook events refuse
delete; account events are append-only; invoice content is immutable and `paid`/`void`/`no_charge` never change status; usage rows of an
invoiced period are closed; a recorded webhook event is final. Nothing in these tables is ever deleted.

### Operator configuration (env only, nothing stored)

| Variable | Meaning |
|---|---|
| `ZENITH_BILLING` | `disabled` (default; BYOC and self-hosted) or `managed` |
| `ZENITH_BILLING_STRIPE_SECRET_KEY` | Stripe TEST key (`sk_test_`/`rk_test_`); a live key is refused and invoicing stays off (usage is still metered) |
| `ZENITH_BILLING_STRIPE_WEBHOOK_SECRET` | the webhook endpoint's signing secret; without it the webhook answers 503 |
| `ZENITH_BILLING_GRACE_DAYS` | days after an invoice is due before nonpayment suspends NEW work (default 14, 0..90) |
| `ZENITH_BILLING_NET_DAYS` | days from invoice creation to due date (default 14, 1..90) |
| `ZENITH_BILLING_STRIPE_API_BASE` | test seam, honoured only for `http://127.0.0.1` / `http://localhost` |

## 2. Acceptance mapping

| Clause | Implementation | Tests |
|---|---|---|
| Metering from durable records (workloads, builds, storage, egress estimate from COST) | `metering.ts` | `billing.engine.test.ts` "usage metering from durable records" (exact expected quantities from seeded rows, period scoping, idempotency, in-progress period, tenant scope) |
| Aggregation per tenant per period | `store.aggregateUsage`, unique key (workspace, meter, source, period) | same, plus `billing.engine.test.ts` view test |
| Quotas tied to plan | `plans.ts` + `admission.ts` (active-operation cap, hard caps; estimated/informational meters never count) | "admission of new work": active cap with the starting operation excluded, hard cap vs uncapped plan, estimated meters ignored |
| Plan assignment | `store.assignPlan`, `/api/admin/billing/assignment` | engine "plan assignment" (audit, versions, unknown plan, stale writer, suspension survives a plan change); routes test |
| Invoice generation via Stripe test API behind an adapter | `invoice.ts`, `provider.ts`, `stripe.ts` | unit: adapter refuses live keys, exact request sequence/shape/idempotency keys, typed errors without the key; engine: one invoice per period, idempotent repeat, zero = no_charge, provider outage leaves a draft and retries with the same keys, no provider = draft |
| Webhook ingestion with signature verification | `stripe.verifyStripeSignature`, `webhook.handleStripeWebhook`, webhook route | unit: valid, independent HMAC re-implementation, tampered body, wrong secret, retimed, tolerance both ways, multi-`v1`, malformed headers, no secret; engine+routes: signature precedes parse and store (a store that throws is never reached), 400/503/404 outcomes |
| Idempotent reconciliation | `webhook.ingestStripeEvent`, `store.transitionInvoice`, `billing_webhook_events` | engine: 5 concurrent identical deliveries -> one applied; replay different id on paid = ignored; stale failure ignored; paid beats earlier failure; amount mismatch; cross-workspace/missing metadata/currency rejected; unmatched; draft adoption; digest-only storage |
| Dunning -> safe suspension | `standing.ts`, `admission.ts` | engine "dunning and safe suspension": schedule, zero grace, oldest-due clock, partial settlement, operator suspension not lifted by payment, level-triggered no-op writes no event |
| Suspension NEVER deletes data | no delete path in code; delete-refusing triggers | engine: row counts of resources/operations/exports/estimates/billing tables never fall through suspend + dunning + export + reinstate; live resource statuses unchanged; SQL DELETE refused on every billing table; append-only events |
| Suspend new dispatch, keep serving read/export | `assertBillingAdmitted` (402 for deploy/dayTwo/remediation/runner_job; `export`/`destroy` never refused), `portability/start.ts` kind, billing route/export route have no billing gate | engine admission tests, and through the real `assertDispatchAdmitted` (suspended deploy/dayTwo refused, export/destroy admitted) |
| Tenant data export available while suspended | `export.ts` + `GET /api/platform/v1/billing/export` | engine "tenant export": suspended workspace exports resources/operations/exports/estimates/billing sections, secret-scrubbed, tenant-scoped, bounded with `truncated`, stable digest |
| `billing: disabled` for BYOC/self-hosted bypasses all billing paths | `config.ts` default; every entry point checks mode first | engine "billing: disabled": admission with a store that throws for `{}`, `disabled` and a typo, for every dispatch kind, even for a workspace the store says is suspended; tick with a store that throws; through `assertDispatchAdmitted`; webhook/operator/tick routes 404/`enabled:false`; export still works with no billing section |
| Provisional plans clearly marked | `plans.ts` | unit "provisional plan catalog"; routes test (every returned plan `provisional` and `_provisional`) |
| Stripe test mode only, keys from env | `config.ts`, `StripeTestInvoiceProvider` ctor | unit config + adapter tests; all secrets generated at run time (`_support.ts`) |

## 3. Verification commands (other machine)

Node 22. No new dependencies.

```
npx vitest run tests/billing/billing-unit.test.ts
npx vitest run tests/billing/billing.engine.test.ts
npx vitest run tests/billing/billing-routes.test.ts
npx vitest run tests/middleware/platform-bearer.test.ts
npx vitest run tests/ops
npx vitest run tests/portability
npx vitest run tests/controlplane/migrations.test.ts tests/security/sensitive-inventory.test.ts tests/security/controlplane-sql-scoping.test.ts tests/controlplane/tenancy.test.ts
```

Engine suites run on PGlite always and on PostgreSQL when `ZENITH_TEST_PLATFORM_PG_URL` is set (the two `assertDispatchAdmitted` cases skip on
the postgres lane unless `ZENITH_TEST_OPS_EXCLUSIVE_PG=1`, because the maintenance row is process-global). Expected: all pass. No live provider,
no Stripe, no network.

Things most likely to need a first-run fix (not run by the builder): the SQL seeds in `_support.ts` (`operations` terminal status plus
`finished_at`, `build_launches` terminal rows through the cleanup-writer barrier trigger, `portability_exports`), and the migration's check/trigger
syntax on PGlite.

## 4. Known gaps and shared-file updates for the assembler

Known limits (stated, not hidden):

- Pricing, terms, payment accounts, retention and the grace policy are provisional placeholders (DEC-BUSINESS, PROD-MAN-07). Nothing here is an offer.
- Live Stripe acceptance is NOT done: the adapter is verified at contract level against an injected fetch with Stripe's documented request/response
  shapes and signature scheme; nobody called Stripe's API. `invoicesOpened` only means the adapter returned an `in_` id.
- Payment collection is by Stripe's own `send_invoice` flow; Zenith collects no card and has no checkout, customer portal or tax handling.
- Metering approximations: managed hours treat `updated_at` of a `deleted` resource as the stop time; resources that are only planned, failed or
  `unknown` are not metered; storage is the retained portability-export bytes only (no hosted-apps or plan-artifact storage); builds are
  provider build time of terminal launches only; egress is a COST model assumption, flagged `estimated` and never charged.
- A workspace with no assignment is, in managed mode, held to the default plan's active-operation cap and is never metered or billed (no account).
  The scheduled pass meters accounts that exist.
- Invoicing happens 6 h after period end (`INVOICE_SETTLE_MS`); a record landing after the invoice exists is not billed (the period is closed).
- A voided invoice keeps the period closed (one invoice row per workspace and period); corrections would be a Stripe-side adjustment.
- `destroy` is never refused by billing: stopping spend is not held hostage to a balance. This is a deliberate reading of "suspend new dispatch".
- Reinstating by an operator while an invoice is still unpaid past grace is honest but temporary: the next dunning pass re-derives standing.
- No billing UI page was built (the requirement names no UI); the member view and export are JSON endpoints and the operator surface is API only.
- The dunning/billing pass is an HTTP tick, not a Temporal Schedule: it is not registered in `CRITICAL_JOBS` (so no health-table or workflow change).
  Cron fallback semantics apply; the pass is idempotent and level-triggered.

Shared-file updates the orchestrator/assembler must make:

1. Migration inventory: version `51` `billing`. The migration test requires contiguous versions from 1, and 42-50 belong to siblings; the aggregate
   SQL/`supabase/migrations` emit and `apply-supabase-migrations.sh` are regenerated by the assembler. If the assembler renumbers, rename the
   file and the `migration0051Billing` export.
2. `src/lib/sensitivedata/inventory.ts` (OPS-06 guard) must classify five new tables. Suggested: all `operational` / `none-needed` ids and counts
   (no secret column exists in any of them); `billing_account_events.actor` and `billing_account_events.detail`, `billing_invoices.lines`,
   `billing_usage_events.detail` are operational JSON written only by this module from fixed shapes; `stripe_customer_id`, `stripe_invoice_id`,
   `stripe_event_id` are provider identifiers, not credentials; `billing_webhook_events` is `digest-only` for the payload. Retention: `ledger`
   (never deleted; PROD-OPS-07 pruning must not target these).
3. Store function tenancy classification (all in `src/lib/billing/store.ts`, deliberately NOT in `controlplane/db/repos`, so `tenancy.test.ts`
   and `controlplane-sql-scoping.test.ts` do not see them; same stance as `src/lib/ops/store.ts`): WORKSPACE-BOUND (every statement filters on
   `workspace_id`): `getAccount, assignPlan, applyStanding, setStripeCustomer, recordAccountEvent, listAccountEvents, upsertUsage, aggregateUsage,
   listUsage, isPeriodClosed, getInvoice, getInvoiceByPeriod, listInvoices, insertDraftInvoice, markInvoiceOpen, markInvoiceNoCharge,
   recordInvoiceError, transitionInvoice, unpaidInvoices`; SYSTEM reads for the scheduled pass / operator: `listAccounts, listStandingCandidates`;
   SYSTEM lookup by the provider's globally unique id (caller cross-checks workspace from the event metadata): `findInvoiceByProviderId`;
   SYSTEM keyed by provider event id: `beginWebhookEvent, finishWebhookEvent, webhookOutcome`.
4. Gate manifest / lanes: add `tests/billing/billing-unit.test.ts`, `billing-routes.test.ts` (control-plane PGlite lane) and
   `billing.engine.test.ts` (engine lane, PGlite plus the PostgreSQL lane) to the fast and engine gates.
5. `.github/workflows/tick.yml`: add `billing` to the `for pass in ...` list (`POST /api/internal/tick/billing`). It answers `enabled:false`
   and does nothing unless `ZENITH_BILLING=managed`, so adding it is safe on every host.
6. `tests/middleware/platform-bearer.test.ts`: route count is `100` here (97 + 3). Re-merge with siblings' counts.
7. `docs/platform/operations/DEPLOYING.md` / env reference: document the six `ZENITH_BILLING*` variables above. `docs/LIMITATIONS.md`: the
   provisional/DEC-BUSINESS and test-mode-only limits above. `ledger.json` / `PROGRESS.md`: see section 5.
8. Verified behaviour changed: none intentionally. `DispatchKind` gained `"export"` and `portability/start.ts` now passes it for `data.export`;
   OPS-02 treats every kind identically, so its behaviour is unchanged (the existing `tests/ops` and `tests/portability` suites should be re-run).

## 5. Suggested ledger implementationStatus

`implementation_complete_verification_pending; provisional_plans_dec_business_undecided; stripe_test_mode_contract_level_live_acceptance_deferred_by_user`

## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: Metering/quotas/plan assignment/invoice/payment-webhook reconciliation and safe suspension/export operate; BYOC/selfhosted do not require Zenith billing.

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

## L3 live and operational verification (2026-10-08)

Acceptance contract: Metering/quotas/plan assignment/invoice/payment-webhook reconciliation and safe suspension/export operate; BYOC/selfhosted do not require Zenith billing.

Profile: **managed**. The owner observation matrix in [LIVE-ACCEPTANCE-MANAGED.md](../LIVE-ACCEPTANCE-MANAGED.md) maps every clause above to real product receipts, provider reads and traffic or operational observations. Fill distinct checks for every clause; a generic operation-status assertion is insufficient.

Implementation: `scripts/acceptance/live/managed/{plan,runner,transport,cli}.ts`, `scripts/acceptance/live/mixed/probes.ts`, the profile shell entry point. Offline checks: `tests/acceptance/live-managed.test.ts`, `tests/acceptance/live-managed-transports.test.ts`; actual Mac owner-gated checks: `tests/acceptance/live-l3.gated.test.ts`. No library injection replaces the CLI transport.

Mac prerequisites: Node 22; clean committed integrated RC; running owner-operated disposable Zenith/PostgreSQL/Temporal stack; managed cloud/CNI/runtime and two tenants for managed isolation; exact sandbox accounts/regions/real DNS/ACME/registry/Stripe test mode/private source fixtures as applicable. The shared runbook lists exact accounts, credentials as FILE references, and separate DEC-CLOUD, DEC-BUSINESS, DEC-RETENTION and signing/signoff approvals. For the lean 8 GB Mac/4 GiB Docker profile, observe an already operated remote sandbox; local cluster/engine rehearsals run one heavy process at a time after J1/J11/J14 integration.

Exact Mac commands, after owner has prepared the private recipe, permissions and approval FILEs described in the shared runbook:

```bash
bash scripts/acceptance/managed-acceptance.sh --plan --fixture "$L3_PRIVATE/managed.recipe.json"
export ZENITH_LIVE_SCOPE_FILE="$L3_PRIVATE/permissions.json"
npx tsx scripts/release/permissions-cli.ts check
export ZENITH_L3_APPROVAL_FILE="$L3_PRIVATE/managed.approval.json"
export ZENITH_L3_BUDGET_FILE="$L3_PRIVATE/budget.json"
export ZENITH_L3_OUT="$PWD/.data-live/l3"
ZENITH_LIVE_MANAGED=1 bash scripts/acceptance/managed-acceptance.sh --run --fixture "$L3_PRIVATE/managed.recipe.json"
# On interruption: audit the original journal/lock, then cleanup only with the same RC and approvals.
ZENITH_LIVE_MANAGED=1 bash scripts/acceptance/managed-acceptance.sh --cleanup-only --fixture "$L3_PRIVATE/managed.recipe.json"
```

Expected: --plan opens no credential and makes zero calls; --run exits 0 only when every required profile scenario, actual assertion, approved cleanup and independent inventory passed. Exit 1 is a failed check, 2 refusal, 3 incomplete/cleanup-only. Live vitest alternative is in the shared runbook; all three live tests explicitly skip when their gates are disabled. Never count those skips as acceptance passes.

Not run here: cloud, real PostgreSQL, Temporal, Docker/kind, browser and operated-stack rehearsals. This row remains pending live/operational evidence and applicable owner decisions. Do not interpret generic tag-index scans as proof of all global/untaggable/unsupported resources being gone. Add direct provider-specific inventories from L1/L2 and review the actual observation matrix before accepting the ledger clause.

Integration joins: exact managed/release grants are absent from the shipped unapproved permissions.json; owner/integrator approval required before any live call. Use the original normal browser approval paths for all execution/teardown. Share the conservative budget book with L1/L2; connect J1/J2/J4/J5/J6/J11/J14/J15 receipt producers and J12 dossier/signoff. No platform migrations, aggregate SQL, package or published migration edits in this job.

Suggested ledger status: `implementation_complete_verification_pending` (L3 harness built; requirement verification and unresolved owner decisions remain pending).


## Wave 6 final integration

Status remains `implementation_complete_verification_pending`. Node 22 only. Execute sequentially with Docker Desktop 4 GiB and one kind node; stop each heavy profile before starting another. Live acceptance stays deferred until separate owner approval.

```bash
node scripts/ci/wave6-gates.mjs --requirement PROD-MAN-06 --print > /tmp/zenith-wave6-PROD-MAN-06.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).
