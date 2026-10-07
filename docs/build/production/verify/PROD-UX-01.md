# PROD-UX-01 Accessible privileged operator journey: verification notes

The original journey slice below is retained as historical context. The J3 MFA additions and current execution results follow at the end. No browser, engine, screen-reader or production verification is claimed by J3.

## 1. What was built

Audit first: `/platform` already had operations list, operation detail (digest-bound approve/reject, plan changes table, cost, policy, timeline, pre-execution cancel), environments, incidents, settings, AWS connect. Missing: any runbook UI, readiness UI, live progress, replan/reapproval handling, ownership-transfer review, an explicit uncertain next-steps flow, a legacy deployment view, and a nav with current-page semantics.

New code:

- `src/lib/platform/operator-journey.ts`: the ONE projection (pure, client-safe). `projectPlatformOperation`, `projectLegacyDeployment` (a workflow deployment defers to its linked operation, so uncertainty is carried over), `projectRunbookRun` (a failed run with an uncertain step is uncertain), `reapprovalState` (digest change), `ownershipTransferRows` / `ownershipWarnings` (read the digest-covered `proposal.broker.ownershipTransfers`), `diffRunbookSteps` (exact effect vs previous version), `describeSchedule`, `runbookApprovalEligibility` (display mirror of the route rules), `nextStepsFor`.
- `src/components/platform/journey-panel.tsx`: renders a `JourneyView`: labelled region, one polite `aria-live` status, step list with state words (colour never alone), `aria-current="step"`, explicit uncertain/failed callouts with numbered next steps.
- `src/components/platform/ownership-transfer-review.tsx`: exact transfer table (caption, column/row headers) bound to the proposal digest.
- `src/app/(product)/platform/_components/journey-live.tsx`: polls the same read endpoints (operation, deployment+linked operation, runbook run) and re-runs the same projection; stops when terminal, pauses when the tab is hidden, marks stale after 2 failures, refreshes the server render on stage change, raises a focused `role="alert"` reapproval notice when the review digest changes.
- `_components/platform-nav.tsx` + `layout.tsx`: nav landmark with `aria-current="page"` (most specific link wins), links to Runbooks, Readiness, Connections (LIFE-01), keeps the existing GitHub source link literal (tests/docs asserts it).
- Pages: `operations/[id]` (live progress, ownership review ahead of the approval card, deployment link), `deployments/[id]`, `runbooks`, `runbooks/runs/[id]` (+ `run-actions.tsx`: approve with `bindingDigest`, cancel), `runbooks/schedule-actions.tsx`, `readiness`.
- Loaders (`_lib/loaders.ts`): `loadDeployment`, `loadRunbooks`, `loadRunbookRun`, `loadReadiness`; `loadOperation` now also returns `linkedDeploymentId`. `browser-api.ts`: `browserRead` (GET, platform read paths and `/api/deployments/:id` only).
- `operation-actions.tsx`: focus moves to the decision confirmation; cancel reason linked by `aria-describedby`.

No new API routes, tables, migrations, npm dependencies or shared-registry edits. Every page uses the existing session auth, broker role resolution, runbook service authorization and browser-only approval routes.

## 2. Acceptance mapping

Acceptance: "Connection admin/onboarding/readiness/plan/progress/cancellation/replan/reapproval/uncertainty/accessibility with consistent legacy/platform projections; MFA/step-up and workspace controls for privileged humans."

| Clause | Implementation | Tests |
| --- | --- | --- |
| readiness | `/platform/readiness` over `executionPlaneReadiness`, role-gated, honest limits | operator-pages "readiness page" |
| plan (exact effect diff, approval binding) | existing PlanChangesTable + ApprovalCard (planDigest/proposalDigest bound); runbook `diffRunbookSteps` + binding digest on `/runbooks/runs/[id]` | operator-journey "runbook effect diff"; operator-pages "runbook run page" |
| LIFE-12 ownership-transfer approvals | `OwnershipTransferReview` rendered before the approval card from digest-covered transfers | journey-live "ownership transfer approvals"; operator-pages "operation page journey wiring" |
| MACH-03 runbook approvals | run and schedule approve controls, independent-admin display rules, raw-exec warning, audit trail | journey-live "runbook decisions"; operator-pages |
| progress | `JourneyLive` polling + polite live region | journey-live "JourneyLive" (interval and terminal stop with fake timers) |
| cancellation | operation cancel (pre-execution), runbook cancel (pending/running), reasons when unavailable | operator-journey "cancellation states"; journey-live "cancels through the cancel route" |
| replan / reapproval | `reapprovalState` + focused alert + server refresh; operation page remounts decision on new digest | operator-journey "replan and reapproval"; journey-live "raises a reapproval alert" |
| uncertainty | `uncertain` stage, `outcomeKnown=false`, next steps ("do not retry/re-run", observe, propose new) | operator-journey; journey-live; operator-pages |
| consistent legacy/platform projections | single projection module used by server and client for all three sources | operator-journey "legacy and platform views agree" |
| accessibility (WCAG 2.1 AA) | landmarks (`nav`, labelled `section`, one `main` from the shell), heading order, table captions/scopes, `aria-live`, `aria-current`, focus moves, disabled controls explained via `aria-describedby`, tokens only | journey-live "JourneyPanel semantics"; operator-pages heading/landmark checks |
| connection admin / onboarding | NOT built here (LIFE-01); nav links to `/platform/connections` and `/platform/connections/aws` | n/a |
| MFA/step-up, workspace controls | J3 server guard, TOTP screens and workspace controls (see addendum) | tests/auth/mfa*.test.ts; tests/screens/mfa.test.tsx |

## 3. Verification commands (other machine)

```
npx vitest run tests/platform-ui tests/docs/operator-docs.test.ts
npx tsc --noEmit -p . && npx eslint "src/app/(product)/platform" src/components/platform src/lib/platform/operator-journey.ts tests/platform-ui
```

Expected: all pass. `tests/platform-ui/interactions.test.tsx` and `pages.test.tsx` are unchanged and should still pass (operation page keeps its structure; the loaders mock there does not need the new exports because those pages do not import them). No env vars or services are needed; HTTP replies are fakes, so no live-API claim is made.

## 4. Known gaps and orchestrator follow-ups

- Accessibility was reasoned from structure and jsdom assertions only. No axe run, screen-reader pass, contrast measurement or keyboard walk in a real browser was done; tokens are the existing ones.
- `/platform/connections` (index) is LIFE-01's. Until it merges the nav link 404s. `/platform/connections/aws` exists.
- J3 adds server-side MFA / step-up and workspace controls. Operated browser acceptance remains pending; see the addendum.
- Readiness is a server page only (no REST route), to avoid touching the bearer-path inventory. It reads this process's driver registry, as documented in `bridge/readiness.ts`.
- J3 adds a confirmed UI for the existing engine `deploy.cancel` action. Workflow deployments continue to point to their linked operation.
- Runbook publish and request-run have no browser form; REST remains the entry. Run approval has no separate reject: cancel is the refusal.
- The replan alert relies on the review digest changing between polls; an approval round bump with the same digest is not a replan (the server render and `approvalRound` already govern approval eligibility).
- Hidden-tab polling pauses via `document.visibilityState`; an interval tick is skipped, not queued.

## 5. Suggested ledger implementationStatus

`implementation_complete_verification_pending`

## J3 MFA and legacy cancellation addendum, 2026-10-08

Base: `3a9de905`; worktree `prod6-j3-mfa`. All changes remain uncommitted for the orchestrator. No `.git` writes, dependency edits, migrations, SQL snapshots, real cloud calls or privileged fallbacks.

### Implementation and acceptance mapping

| Contract | Implementation and tests |
| --- | --- |
| Supabase TOTP enrollment and challenge | `src/app/(product)/account/mfa/{enrol,challenge}/page.tsx`, `mfa-flow.tsx`: live account check, verified TOTP selection, enroll, challengeAndVerify, explicit unverified-enrollment cancellation; key/code erased after verification. `tests/screens/mfa.test.tsx` uses mocked SDK responses. |
| AAL2 on privileged human routes | ONE `requireStepUp(req, { subject, workspaceId? })` in `src/lib/auth/mfa.ts`: signature-verified getClaims, exact AAL2, finite unexpired exp, matching live getUser and confirmed email, currently verified TOTP factor. Missing/unknown AAL and removed factors refuse. No getSession, metadata claim, demo identity or provider outage can grant access. `tests/auth/mfa.test.ts`. |
| Reachable server guard | `mfa-routes.ts` runs in the real `server/request.ts` scope before each handler; admin mutation metadata is covered even for new paths. Actions use their registered mutates/risk/role/category metadata and the parsed execute mode. Plan/read helpers remain accessible. `tests/auth/mfa-routes.test.ts` tests the real wrapper, concrete approval/action/confirmation routes and an explicit route inventory with SDK claims mocked. |
| Installation operator controls | `ops/operator.ts` and `waitlist/http.ts` call the same guard after their existing user-ID allowlist checks. No workspace admin becomes an installation operator. Raw maintenance/quotas and waitlist admission/preview are covered. `tests/auth/mfa-operators.test.ts`. |
| Workspace controls | `mfa-policy.ts`: immutable privileged minimum; host-managed per-workspace `requireForAllMutations` and optional MFA `maxAgeSeconds` derived from AMR, never JWT refresh time. Invalid config fails closed. `GET /api/workspace/mfa` resolves the selected member workspace; `settings/mfa-controls.tsx` shows its effective policy. Account/settings/platform links reach enrollment/challenge. |
| Accessible screens | Native form submit, explicit labels, OTP/numeric input hints, described help, focus on code/alert/success, busy/duplicate-submit guard, existing Button/Input tokens, accessible manual setup key and QR alternative. DOM assertions are contract evidence only. Real Playwright/axe gate below. |
| Legacy engine cancellation | `platform/deployments/[id]/legacy-cancel.tsx` confirms and executes the existing tenant-scoped `deploy.cancel` action, disables viewers, preserves partial-change warning, refreshes only after confirmed success. Page and shared `operator-journey.ts` projection are wired; terminal deployments remain uncancellable. Workflow ownership and cancellation are unchanged. |

No new tables, store functions, grants or tenancy classifications. No migration number was assigned, so no migration is added. Workspace controls are deployment-managed, not a new workspace policy JSON key or persistence subsystem. There is deliberately no web switch to weaken the mandatory minimum.

Changed/added files (26 total):

```text
docs/build/production/ledger.json
docs/build/production/verify/PROD-UX-01.md
src/app/(product)/account/mfa/challenge/page.tsx
src/app/(product)/account/mfa/enrol/page.tsx
src/app/(product)/account/mfa/mfa-flow.tsx
src/app/(product)/account/page.tsx
src/app/(product)/platform/deployments/[id]/legacy-cancel.tsx
src/app/(product)/platform/deployments/[id]/page.tsx
src/app/(product)/platform/layout.tsx
src/app/(product)/platform/settings/mfa-controls.tsx
src/app/(product)/platform/settings/page.tsx
src/app/api/auth/mfa/verify/route.ts
src/app/api/workspace/mfa/route.ts
src/lib/auth/mfa-navigation.ts
src/lib/auth/mfa-policy.ts
src/lib/auth/mfa-routes.ts
src/lib/auth/mfa.ts
src/lib/ops/operator.ts
src/lib/platform/operator-journey.ts
src/lib/server/request.ts
src/lib/waitlist/http.ts
tests/auth/mfa-browser.test.ts
tests/auth/mfa-operators.test.ts
tests/auth/mfa-routes.test.ts
tests/auth/mfa.test.ts
tests/screens/mfa.test.tsx
```

Configuration example (no credentials):

```sh
export ZENITH_MFA_WORKSPACE_CONTROLS='{"ws-example":{"requireForAllMutations":true,"maxAgeSeconds":300}}'
```

`maxAgeSeconds` accepts integer seconds 60..86400; absence uses the current authenticated AAL2 session. The map is keyed by workspace ID. Product action routes use the resolved cookie workspace, not a caller-supplied foreign workspace header. Platform routes use their existing named workspace/role checks. MFA adds no membership or execution authority. The old role, independent-human, immutable digest, quota, approval, authority, custody and effect checks still run.

### Privileged route coverage at this base

All mutations in the following groups are protected; GET/HEAD/OPTIONS remain ordinary reads except the GitHub callback (it binds trust on GET):

- Operation approve/reject/cancel, portability start, mixed-run cancel/teardown; mixed plans create/adopt children/start.
- Connections create (generic and AWS UI action), rotate, promote/abort rotation, verify/revoke.
- Runbooks publish, request run/schedule, run/schedule approve, cancellation and schedule state.
- Workspace policy, environment autonomy/spend, backend restore review/approve/reject/execute/probe, teardown review.
- Standing grants and mixed-output preauthorizations create/revoke; migration approvals; effect resolution.
- GitHub binding/unbind/callback; runner/machine registration-token issuance and revocation; coding-agent run/create/adopt/cancel/resume.
- Integrations agent review/grants/link approve/revoke; plugin registration/trust review/revoke/token issue/revoke.
- Workspace members/invites/ownership management; hosted app lifecycle/access management; account deletion.
- Raw `/api/admin/ops/maintenance` PUT, `/api/admin/ops/quotas` PUT/DELETE and waitlist preview/admit POST through their operator helpers.
- `/api/actions/:actionId` execution: admin or high-risk mutations, connection/secret/service-operation/deployment changes and legacy cancellation. Human approval/trust/admin actions never accept machine transport. Existing verified integration/Navigator execution seams retain deterministic credential/scope/policy authority; merely adding Authorization to an AAL1 browser request cannot bypass MFA.

### Wave 5 integration joins (read-only inspection, not reimplemented)

| Owner / routes | Join |
| --- | --- |
| MAN-02/03: POST `/api/platform/v1/environments/:id/domains`, `/domains/verify`, `/domains/revoke` | Add as human routes in the inventory when merging. Their existing assertBrowserSession guards stay in place. |
| MAN-06: PUT `/api/admin/billing/assignment`, POST `/api/admin/billing/invoices`, POST `/api/admin/billing/suspension` | Already call requireOpsOperator(request, true), so inherit the updated helper on integration. Require AAL1 refusal/no mutation and AAL2 success fixtures. Billing webhook/internal tick remains authenticated machine authority. |
| OPS-04: POST `/api/platform/v1/recovery/items/:id/decide` | Add human decision route to inventory. Preserve recovery plan/effect and independent-review bindings. |
| OPS-07: POST/DELETE `/api/admin/ops/retention/holds`, POST `/retention/preview`, POST `/retention/archives/:id/verify` and `/restore` | Already use mutating operator helper and inherit it. Future deletion/apply/admission endpoints must call requireStepUp after verified operator identity, before any decision/write. MFA grants no retention-policy approval. |
| OPS-07: `/api/workspace/retention-destination` future mutating export/destination controls | Inspect its exported methods at merge; protect every human mutation through admin metadata or explicit inventory. |
| OPS-09: POST `/api/platform/v1/audit/exports` | Add human inventory entry; keep signature/export authorization. No production signing-key approval is inferred. |
| OPS-01/REL-03 and other new sign-off, retention or release-key/rollout controls | Guard all human decision mutations through requireStepUp; if wrapped with workspaceRole: admin they inherit the generic hook. Raw routes need the explicit helper. Existing SLO GET is read-only; measurement ingest remains deterministic machine authority. |
| MAN-01/04/05 and OPS-08 | No new privileged HTTP mutation paths were found in their available worktree snapshots. Reinventory the final assembled routes; internal workflows/brokers are not replaced by MFA. |

The Wave 5 directories on this machine are snapshots without usable `.git` metadata, so their API files were inventoried directly. Final assembled-route and authority checks remain the integrator's responsibility.

### Exact Mac browser verification commands and prerequisites

Not run here: needs actual local Supabase Auth (TOTP enabled), the prepared Zenith API/platform store, two disposable admitted workspace admins, and installed Chrome. No Docker, PostgreSQL, Temporal, kind or browser service was started on Windows. No live cloud is needed or allowed by this gate.

**Important startup join:** base `supabase/config.toml` currently has `[auth.mfa.totp] enroll_enabled = false` and `verify_enabled = false`. J1/verifier must set BOTH to true in the owned disposable prepared stack configuration (and provision two confirmed users). This file is outside J3 ownership and was not edited. There is no application fallback when Auth MFA is disabled.

Use the J1 prepared configuration/private-CA pooler and fixture workspace database. For a lean 8 GiB Mac / 4 GiB Docker MFA lane, run only Auth, API gateway, PostgREST, PostgreSQL/pooler and one native Zenith API, then one headless browser/one test worker. No Temporal worker, kind, build worker, telemetry stack or cloud emulator is needed for this MFA-only test. Stop other heavy lanes first; do not ignore health checks. Keep the existing verifier disk floor. This lean lane does not replace the full default-stack or J2 operation journey.

```sh
# Shell must use the verifier's pinned Node 22 (check before starting).
node --version
# ZENITH_MFA_STACK_DIR is J1's owned, prepared disposable Supabase directory.
# Its copied config has TOTP enroll/verify enabled; retain J1's TLS pooler.
npx supabase start --workdir "$ZENITH_MFA_STACK_DIR" \
  --exclude studio,imgproxy,edge-runtime,logflare,vector,realtime,storage-api

# In a separate shell load J1's private prepared .env.local, including real
# local Auth public URL/key and platform DB/TLS configuration. Never print it.
export ZENITH_PLATFORM_ORIGIN='http://127.0.0.1:3400'
NODE_OPTIONS='--max-old-space-size=1536' npx next dev -p 3400

# Private fixture file, created by J1/J2's disposable-user setup, chmod 600.
# Shape: {origin,identities:[{email,password,workspaceId},{email,password,workspaceId}]}.
# Use two distinct confirmed/admitted admins, initially without verified TOTP.
# Values are runtime-generated local fixture credentials, never committed.
export ZENITH_MFA_BROWSER=1
export ZENITH_MFA_BROWSER_FIXTURES_FILE="$ZENITH_MFA_FIXTURE_FILE"
export ZENITH_MFA_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
npx vitest run tests/auth/mfa-browser.test.ts --no-file-parallelism --maxWorkers=2
```

Expected opted-in result: **2 passed / 0 failed / 0 skipped**. Both identities enroll through the real UI/provider, confirm AAL2 on the real server, start a fresh AAL1 password session, fail a wrong code and complete step-up. AAL1 approval probes fail 403; after step-up deliberately malformed approval requests reach existing validation (400) without changing an operation. Real keyboard Enter and axe WCAG 2/2.1 AA checks run at 1280 and 375 px on enrollment, success and challenge states. Browser DOM containing QR/key is never included in receipts. Assertions never intercept Auth or API traffic. Missing opted-in prerequisites fail, rather than becoming skips. Without ZENITH_MFA_BROWSER=1 the two cases explicitly skip and count as **not run**, never passed.

Cleanup: close browser (suite finally/afterAll), stop only the API process started for this lane, then run `npx supabase stop --workdir "$ZENITH_MFA_STACK_DIR"` for the positively owned disposable stack. Delete the two disposable users/factors/private fixture file through J1/J2 cleanup. The suite intentionally never deletes identities, workspaces or unrelated Auth factors.

Manual NVDA acceptance (Windows, not run by this job): after owner-approved startup is available here, walk enrollment/challenge and legacy-cancel confirmation with Tab/Shift-Tab/Enter; record label announcements, alert and success focus, QR manual alternative and role-denial explanation. Mac axe is not an NVDA result. The broader platform-page contrast/a11y/default two-operator journey remains with the existing UX-01/J2 verifier.

Primary references: [Supabase TOTP enrollment/challenge](https://supabase.com/docs/guides/auth/auth-mfa/totp), [MFA overview/AAL](https://supabase.com/docs/guides/auth/auth-mfa), [CLI start/excluded services](https://supabase.com/docs/reference/cli/supabase-start).

### Windows execution record

Every shell prepended `C:\Users\user\.local\sdk\node22` to PATH; `node --version` returned `v22.23.3`. No npm install/ci, Go command, whole-suite run, Docker, actual PG/Temporal/kind, cloud request, commit or history operation.

| Exact check command | Passed / failed / skipped |
| --- | --- |
| `npx vitest run tests/auth/mfa.test.ts tests/auth/mfa-routes.test.ts tests/screens/mfa.test.tsx --no-file-parallelism --maxWorkers=2` | 155 / 1 / 0; the new missing-AAL fixture helper accidentally defaulted explicit undefined to AAL2. Fixture construction fixed; assertion retained. |
| `npx vitest run tests/auth/mfa.test.ts tests/auth/mfa-routes.test.ts tests/screens/mfa.test.tsx tests/auth/mfa-browser.test.ts --no-file-parallelism --maxWorkers=2` | 160 / 0 / 2; browser gated, not run. |
| `npx vitest run tests/platform-ui/operator-journey.test.ts tests/platform-ui/operator-pages.test.tsx tests/auth/workspace-sharing.test.ts tests/screens/account-page.test.tsx --no-file-parallelism --maxWorkers=2` | 93 / 1 / 0; existing legacy-cancel-unavailable assertion is stale against the assigned requirement (see below). |
| `npx vitest run tests/auth/mfa.test.ts tests/auth/mfa-routes.test.ts tests/auth/mfa-operators.test.ts tests/screens/mfa.test.tsx tests/auth/mfa-browser.test.ts --no-file-parallelism --maxWorkers=2` | 143 passed / 0 assertion failures / 2 gated skips, plus 1 unhandled worker-start error; DOM worker timed out before its 25 tests could run. Exit 1, NOT a pass. |
| `npx vitest run tests/auth/mfa.test.ts tests/auth/mfa-routes.test.ts tests/auth/mfa-operators.test.ts tests/auth/mfa-browser.test.ts --no-file-parallelism --maxWorkers=2` | Final Node successor: 146 / 0 / 2, exit 0. Includes static coverage of every existing explicit browser-only platform mutation. |
| `npx vitest run tests/screens/mfa.test.tsx --no-file-parallelism --maxWorkers=2` | Final DOM successor: 25 / 0 / 0, exit 0. |
| `npx vitest run tests/auth/mfa.test.ts tests/auth/mfa-operators.test.ts --no-file-parallelism --maxWorkers=2` | After explicit parameterized header-fixture typing: 63 / 0 / 0, exit 0. Same assertions and cases retained. |
| `$files = @(git diff --name-only -- '*.ts' '*.tsx'); $files += @(git ls-files --others --exclude-standard -- '*.ts' '*.tsx'); npx eslint @files` | Executed twice (before and after final fixes): both exit 0, 24 files, 0 errors / 0 warnings. |
| `npx eslint tests/auth/mfa.test.ts tests/auth/mfa-operators.test.ts` | Recheck after fixture typing: exit 0, 2 files, 0 errors / 0 warnings. |
| `$env:NODE_OPTIONS = '--max-old-space-size=4096'; npx tsc --noEmit -p .` | Attempt 1 stopped via Ctrl+C, exit 1 without a compiler verdict during prolonged shared-machine contention. Attempt 2 exit 1, exactly 2 TS2345 diagnostics in new parameterized header fixtures. Explicit Record fixture types added, no assertions changed. Attempt 3 exit 0, 0 diagnostics. |
| `git diff --check` | exit 0; no whitespace findings at that checkpoint. |
| `node --version`; `npx --no-install tsc --version` | exit 0: Node 22.23.3, TypeScript 5.9.3. |
| `node -e 'const fs = require("fs"); const ledger = JSON.parse(fs.readFileSync("docs/build/production/ledger.json", "utf8")); const row = ledger.requirements.find(r => r.id === "PROD-UX-01"); if (row.implementationStatus !== "implementation_complete_verification_pending" || row.state !== "in_progress" || !row.implementationNote) process.exit(1); console.log("UX-01 ledger status/note: pass");'` | exit 0, 1 metadata check passed / 0 failed / 0 skipped. |

Counts overlap and must not be summed as unique acceptance. SDK/provider and execution doubles are contract evidence, not operated Supabase or engine proof.

Final focused evidence: **171 passed / 0 failed / 2 gated browser skips** across the Node and DOM runs, with the affected 63 Node cases repeated successfully after the typing fix. Final typecheck passes with 0 diagnostics; all changed TypeScript files pass lint. The separate existing regression run still has the one stale outside-owned assertion described below. Overall operated acceptance is pending, not verified.

Read-only inspection used `git status --short`, `git log --oneline -10`, `git diff --stat`, `git diff --name-only`, `git ls-files --others --exclude-standard`, `rg`/`rg --files`, PowerShell Get-Content/Get-ChildItem/Get-Item/Select-Object/Measure-Object and Get-Process. Missing guessed files/globs during discovery produced diagnostic errors and were corrected by file inventory; no mutation resulted. An optional Get-Item probe for root tsconfig.tsbuildinfo found no file (exit 1); no build artifact was removed or modified. Attempts to diff nine Wave 5 snapshot directories with `git -C <snapshot> diff --name-only c02c097e HEAD -- src/app/api` failed as not Git worktrees; direct read-only API inventory replaced them. Get-CimInstance Win32_Process was denied by the sandbox; no permissions escalation or peer process termination was attempted. Only this job's first typecheck session was stopped with Ctrl+C, as recorded above. SDK/CLI primary documentation was read through web search/open/find; no application or provider request was made by that lookup.

### Remaining integration work, stale assertion and scope decisions

- `tests/platform-ui/operator-journey.test.ts:83-88` still says an in-process `rolling_back` deployment cannot be cancelled from the screen. The real engine already has cancellation (`engine.ts:865`) and the new UI invokes the existing `deploy.cancel` action, so its old availability/reason expectations are provably stale. Per owned-test boundaries it was not edited. The orchestrator should rename that case, keep its stage/step-order assertions, assert cancel.available is true and cancel.reason is undefined, retaining assertion strength; new `tests/screens/mfa.test.tsx` covers nonterminal/terminal states, role denial and real action wiring. No existing test expectation was changed by J3.
- The newly authored J3 screen test initially expected POST for server confirmation; it now expects GET because confirmation has no side effects and must remain available during read-only maintenance. The same AAL2 guard protects both methods. A new route/maintenance contract assertion checks this explicitly. This is a change to J3's own draft test, not a pre-existing assertion/gate change.
- Older route tests outside tests/auth/tests/screens that fake only sessionUser/verifyRequestIdentity must also provide explicit signed AAL2 claims (finite unexpired exp), matching confirmed live user and a verified TOTP factor. Keep all their denial, policy, digest, tenant and effect assertions. Do not mock requireStepUp or bypass it to go green. Their assembled successor is pending, not claimed passed here.
- The middleware/boot/admission order is preserved. Step-up runs before the route handler, after existing admission and request/membership resolution; it does not defer quota or DUR execution checks.
- Workspace controls are host-managed because J3 has no assigned migration and must not invent/extend another owner's policy schema. The UI exposes effective controls; a future admin-edit persistence seam requires an explicitly assigned schema/policy join.
- Operated MFA, axe, browser keyboard, contrast, manual NVDA and engine/provider cancellation remain not run (need the Mac/local default stack or owner-approved Windows screen-reader environment). Supabase TOTP must be enabled by the stack owner. Supabase-level factor recovery/removal stays with the identity provider; this UI only cancels its current unverified enrollment.
- Ledger row remains `implementation_complete_verification_pending`, state `in_progress`; historical evidence remains unchanged. The orchestrator must regenerate aggregate docs and add the five test files to the unit/browser gate inventory without weakening required identities. No release flag or verification state was promoted.

Suggested commit: `feat(auth): require operator MFA for privileged actions`
