# PROD-UX-01 Accessible privileged operator journey: verification notes

Built only; nothing here was executed (typecheck and eslint on changed files only).

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
| MFA/step-up, workspace controls | NOT in this slice (see gaps) | n/a |

## 3. Verification commands (other machine)

```
npx vitest run tests/platform-ui tests/docs/operator-docs.test.ts
npx tsc --noEmit -p . && npx eslint "src/app/(product)/platform" src/components/platform src/lib/platform/operator-journey.ts tests/platform-ui
```

Expected: all pass. `tests/platform-ui/interactions.test.tsx` and `pages.test.tsx` are unchanged and should still pass (operation page keeps its structure; the loaders mock there does not need the new exports because those pages do not import them). No env vars or services are needed; HTTP replies are fakes, so no live-API claim is made.

## 4. Known gaps and orchestrator follow-ups

- Accessibility was reasoned from structure and jsdom assertions only. No axe run, screen-reader pass, contrast measurement or keyboard walk in a real browser was done; tokens are the existing ones.
- `/platform/connections` (index) is LIFE-01's. Until it merges the nav link 404s. `/platform/connections/aws` exists.
- MFA / step-up and workspace controls for privileged humans are not implemented here: there is no existing step-up primitive to bind approvals to in this tree, and inventing one in the UI would be a fake control. Approvals remain browser-session-only with live identity checks in the routes. Needs an auth-layer requirement.
- Readiness is a server page only (no REST route), to avoid touching the bearer-path inventory. It reads this process's driver registry, as documented in `bridge/readiness.ts`.
- Legacy engine deployments cannot be cancelled from the UI (no cancel action exists for them); the projection says so. Workflow deployments point to the operation.
- Runbook publish and request-run have no browser form; REST remains the entry. Run approval has no separate reject: cancel is the refusal.
- The replan alert relies on the review digest changing between polls; an approval round bump with the same digest is not a replan (the server render and `approvalRound` already govern approval eligibility).
- Hidden-tab polling pauses via `document.visibilityState`; an interval tick is skipped, not queued.

## 5. Suggested ledger implementationStatus

`operator_journey_pages_unified_projection_live_progress_runbook_and_ownership_review_readiness_page_browser_a11y_audit_and_step_up_pending`
