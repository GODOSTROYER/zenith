# WS-APPROVAL-FLOW continuation report

Worktree: `Z:/Projects/Spawned.ai/zenith-wt/ws-approval-flow`
Branch: `ws/approval-flow`
HEAD: `e3ea61a0b977bcc4e25ed030bdde1716f99c4efe`
Date: 2026-10-01

All changes are uncommitted. No Git metadata, dependencies, package files, workflow definitions, or schema migrations were changed.

## Result and approval contract

The broker preserves concrete-plan `require_approval` decisions. Round-zero proposal approvals cannot authorize the plan gate. Plan approval and apply grants require eligible users in the current round, the proposal digest, an unexpired approval, the current role, separation of duties, and the policy's required approval count. Consumed approvals count only while the operation is running in that same round.

The gated plan is write-once. Replacing its digest fails with `plan_changed`; first recording a digest after a later-round human decision also fails. Approval writes check the expected round and reviewed plan digest under the operation row lock. This binds approvals through the existing round and immutable operation digest without adding an approvals-table column. Tests prove approvals recorded before plan stamping cannot authorize a later plan.

`getOperationDetail` and the existing operation GET response expose `planReview: { planDigest, view, cost, decision? }`. The view comes from the original tenant-scoped, non-simulated `tofu_plan` evidence with stage `plan`, never a subsequent final-plan artifact. Its projection keeps resource addresses, actions, attribute names, sensitivity flags, and output names. Attribute/output values and fingerprints are removed. Text is redacted, arrays are bounded, and the serialized review is capped at 60,000 bytes. Invalid or unavailable evidence remains unavailable; unknown cost remains unknown.

The operation page renders this review and enables approval only when it is readable. Browser approval posts the reviewed digest; a stale or missing required digest is refused. REST approval/rejection signals the existing workflow after the final decision. Signal failure is reported without undoing the decision or exposing exception text. The bridge accepts a third `reviewedPlanDigest` argument, handles a stale deployment projection using the authoritative operation, and signals an existing workflow rather than starting it again. Browser-only restrictions remain enforced.

Offline tests exercise the bridge's two approval rounds, a new lease fence, the full activity chain, unchanged-final-plan success, changed-final-plan refusal, and the REST/browser review contract. These use PGlite and a file store with mocked AWS, fake OpenTofu, scripted policy where applicable, and a fake workflow signal gateway. They do not prove live Temporal or AWS behavior. Separate broker tests use the actual broker and ledger with synthetic planning evidence.

## Files changed or added

Production files modified:

- `src/app/(product)/platform/operations/[id]/operation-actions.tsx`
- `src/app/(product)/platform/operations/[id]/page.tsx`
- `src/app/api/platform/v1/operations/[id]/approve/route.ts`
- `src/app/api/platform/v1/operations/[id]/reject/route.ts`
- `src/components/platform/approval-card.tsx`
- `src/lib/bridge/lifecycle.ts`
- `src/lib/capabilities/approvals.ts`
- `src/lib/capabilities/execution.ts`
- `src/lib/capabilities/operations.ts`
- `src/lib/controlplane/approvals/index.ts`
- `src/lib/controlplane/db/repos/approvals.ts`
- `src/lib/controlplane/db/repos/operations-execution.ts`
- `src/lib/controlplane/db/repos/operations.ts`
- `src/lib/controlplane/operations/execution.ts`
- `src/lib/execution/plan.ts`
- `src/lib/execution/platform.ts`
- `src/lib/platform/broker.ts`

Production file added:

- `src/lib/controlplane/db/repos/operation-review.ts`

Test files modified:

- `tests/capabilities/action-bridge.test.ts`
- `tests/execution/ledger-approval.test.ts`
- `tests/execution/platform.test.ts`
- `tests/platform-ui/interactions.test.tsx`
- `tests/platform-ui/pages.test.tsx`
- `tests/platform/deploy-e2e.test.ts`
- `tests/workflows/support.ts`

Test/report files added:

- `tests/platform/plan-approval-routes.test.ts`
- `tests/platform/plan-approval.test.ts`
- `tests/platform/WS-APPROVAL-FLOW-HANDOFF.md`

## Verification history

Every Vitest invocation used `--maxWorkers=2`. No whole-repository Vitest run was made. Counts below are tests, not files; skipped tests are not counted as passed.

| Run | Exact command | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: |
| Baseline | `npx vitest run --maxWorkers=2 tests/platform/deploy-e2e.test.ts tests/platform-ui/interactions.test.tsx` | 29 | 0 | 3 |
| Broker/approvals | `npx vitest run --maxWorkers=2 tests/platform/plan-approval.test.ts tests/capabilities/approvals.test.ts` | 51 | 0 | 0 |
| Activities/UI | `npx vitest run --maxWorkers=2 tests/platform/deploy-e2e.test.ts tests/platform-ui tests/execution/platform.test.ts` | 125 | 0 | 6 |
| REST/UI | `npx vitest run --maxWorkers=2 tests/platform/plan-approval-routes.test.ts tests/platform-ui/interactions.test.tsx` | 34 | 0 | 0 |
| First broad run | `npx vitest run --maxWorkers=2 tests/platform tests/workflows tests/execution tests/capabilities tests/bridge tests/controlplane` | 1358 | 2 | 104 |
| Failure fixes | `npx vitest run --maxWorkers=2 tests/controlplane/migrations.test.ts tests/capabilities/action-bridge.test.ts` | 28 | 0 | 3 |
| Additional plan guards | `npx vitest run --maxWorkers=2 tests/platform/deploy-e2e.test.ts tests/platform/plan-approval.test.ts` | 19 | 0 | 6 |
| Final broad run | `npx vitest run --maxWorkers=2 tests/platform tests/workflows tests/execution tests/capabilities tests/bridge tests/controlplane` | 1364 | 0 | 104 |
| Final metadata relocation | `npx vitest run --maxWorkers=2 tests/platform/plan-approval.test.ts tests/platform/plan-approval-routes.test.ts tests/platform/deploy-e2e.test.ts tests/capabilities/approvals.test.ts tests/bridge` | 156 | 0 | 6 |

The first broad failures were an old-schema migration fixture whose operation creation had no `approval_round` column, and a stale action-bridge expectation for the existing human-only `placement.apply` action. The operation creation projection now reads optional round metadata through `to_jsonb`, preserving the migration fixture. The assertion now matches the already implemented action restriction; no placement production code was changed.

The final broad run included `tests/platform-ui` through the `tests/platform` path filter. It completed with **66 test files passed, 1 skipped, 0 failed** (1,468 tests total). Its log is `C:/Users/user/AppData/Local/Temp/zenith-ws-approval-flow-vitest-final.log`.

TypeScript ran exactly three times:

| Exact command | Run | Result |
| --- | --- | --- |
| `npx tsc --noEmit` | 1 | Failed: 1 diagnostic, plan-review interface was not assignable to `Record<string, unknown>`; corrected the projected object. |
| `npx tsc --noEmit` | 2 | Failed: 2 diagnostics, an incomplete lease test type and a heterogeneous headers array; corrected both fixture types. |
| `npx tsc --noEmit` | 3, final | Passed: 0 diagnostics. |

The third whole-repository check preceded the final relocation of approval-round type metadata into the owned operation/approval modules. This relocation preserved the output shapes and restored `src/lib/capabilities/types.ts` to HEAD. A subsequent scoped check covered all 27 changed TypeScript files and their imports, without a fourth whole-repository invocation:

| Exact command | Run | Result |
| --- | --- | --- |
| `npx tsc --noEmit --project 'C:\Users\user\AppData\Local\Temp\zenith-ws-approval-flow-scoped-tsconfig.json'` | 1 | Failed: 1 diagnostic because the temporary configuration explicitly included a nonexistent `next-env.d.ts`; corrected the configuration. |
| `npx tsc --noEmit --project 'C:\Users\user\AppData\Local\Temp\zenith-ws-approval-flow-scoped-tsconfig.json'` | 2, final | Passed: 0 diagnostics. |

ESLint ran once with the following initial command and passed with 0 diagnostics:

```powershell
npx eslint src/lib/platform/broker.ts src/lib/capabilities/approvals.ts src/lib/capabilities/execution.ts src/lib/capabilities/operations.ts src/lib/capabilities/types.ts src/lib/bridge/lifecycle.ts src/lib/execution/plan.ts src/lib/execution/platform.ts src/lib/controlplane/db/repos/operation-review.ts src/lib/controlplane/db/repos/approvals.ts src/lib/controlplane/db/repos/operations.ts 'src/app/api/platform/v1/operations' 'src/app/(product)/platform/operations' src/components/platform/approval-card.tsx
```

ESLint ran twice with the following full owned-path command. Both runs passed with 0 diagnostics; the second was the final run:

```powershell
npx eslint src/lib/platform src/lib/capabilities src/lib/bridge src/lib/execution src/lib/controlplane tests/platform tests/workflows tests/capabilities tests/bridge tests/execution tests/platform-ui 'src/app/api/platform/v1/operations' 'src/app/(product)/platform/operations' src/components/platform/approval-card.tsx
```

After the metadata relocation, the following focused ESLint command passed with 0 diagnostics:

```powershell
npx eslint src/lib/capabilities/approvals.ts src/lib/capabilities/operations.ts src/lib/bridge/lifecycle.ts
```

`git diff --check` passed repeatedly with 0 findings, including the final check after this report was added. No failing whitespace checks remain.

## Checks that could not run

The final 104 skips are:

| Suite | Skipped | Reason |
| --- | ---: | --- |
| `tests/platform/deploy-e2e.test.ts` | 6 | Temporal runtime unavailable. |
| `tests/workflows/client.test.ts` | 11 | Temporal runtime unavailable. |
| `tests/workflows/replay.test.ts` | 7 | Temporal runtime unavailable; replay compatibility not verified here. |
| `tests/workflows/deploy.test.ts` | 38 | Temporal runtime unavailable. |
| `tests/workflows/worker.test.ts` | 1 | Temporal runtime unavailable. |
| `tests/workflows/operations.test.ts` | 27 | Temporal runtime unavailable. |
| `tests/workflows/approval-time.test.ts` | 3 | Time-skipping server unavailable; the 24-hour approval timeout was not executed. |
| `tests/controlplane/migrations.test.ts` | 3 | Real PostgreSQL URL not supplied. |
| `tests/controlplane/open.test.ts` | 2 | Real PostgreSQL URL not supplied. |
| `tests/controlplane/executor.test.ts` | 1 | Real PostgreSQL URL not supplied. |
| `tests/execution/compile-refs-providers.test.ts` | 2 | Real OpenTofu network checks are opt-in. |
| `tests/execution/journey.test.ts` | 3 | Real OpenTofu executable unavailable to the test process. |

Temporal is installed on the host, but its WinGet link was inaccessible to Node. `temporal --version` failed with "No application is associated with the specified file". Invoking the resolved executable also failed:

```powershell
& 'C:\Users\user\AppData\Local\Microsoft\WinGet\Packages\Temporal.TemporalCLI_Microsoft.Winget.Source_8wekyb3d8bbwe\temporal.exe' --version
```

Result: access denied. Neither version check succeeded. No sandbox escape was requested or attempted.

The orchestrator must run the Temporal suites and replay outside this sandbox. Test support accepts `ZENITH_TEST_TEMPORAL_CLI` for a runnable CLI and `ZENITH_TEST_TEMPORAL_SERVER` for a preinstalled time-skipping test server. Downloads are now explicitly opt-in with `ZENITH_TEST_TEMPORAL_DOWNLOAD=1`; unavailable offline servers produce explicit skips. Real PostgreSQL tests require `ZENITH_TEST_PLATFORM_PG_URL`. Network-dependent OpenTofu schema checks require `ZENITH_TEST_TOFU_NETWORK=1`. Real OpenTofu journeys require a runnable `tofu` binary. Docker, WSL, live AWS, and real OpenTofu/OPA CLI execution were not used or verified.

## External integration follow-up and decisions

The platform operation page/REST path and the bridge function support reviewed plan approval. The legacy registered `deploy.approve` action still accepts only a deployment ID and calls the bridge with two arguments. Its source is explicitly excluded from this workstream, so it was left unchanged. It therefore safely refuses plan-round approval when the reviewed digest is missing.

Required follow-up in `src/lib/actions/defs/deploy.ts`:

- At line 285 and the `deploy.approve` definition around lines 300-307, provide a separate approval input schema with optional `planDigest: z.string().regex(/^[0-9a-f]{64}$/).optional()`. Preserve proposal-round compatibility and the cancel action's schema.
- At line 354, call `approveWorkflowDeployment(ctx, deployment, input.planDigest)`.
- Any legacy approval UI caller must send the digest of the plan the human actually reviewed, or direct the user to `/platform/operations/{operationId}`. Do not automatically substitute the current digest for missing review evidence.

Approval-round read metadata is an additive intersection on the owned operation-detail and approval-result types. Fixed broker signatures, proposal contracts, `src/lib/capabilities/types.ts`, and controlplane public types were preserved. The final diff stays inside the owned paths.

The write-once-plan decision was retained and strengthened to reject attempted replacement explicitly. No workflow behavior or replay markers were changed. Approval binding uses the current round plus the immutable recorded plan digest, with an explicit reviewed digest at approval time. No committed work was undone.
