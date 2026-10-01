# WS-DESTROY-REVIEW - a first, read-only destroy review anyone authorized can start

Workstream: WS-DESTROY-REVIEW (orchestrator brief, wave 8) - Branch ws/destroy-review - worktree Z:/Projects/Spawned.ai/zenith-wt/ws-destroy-review
Base: ws/integrate-w6 (staging: all of wave 7 merged)

## Situation
docs/LIMITATIONS.md ("Still-open gaps at source snapshot 3c1fa66") lists this as an open code gap. Read that line, the linked operator guide, and the code it names before designing anything.
Teardown today needs pre-existing execution evidence and a readable matching PlanView before a human can approve; there is no first step that produces that destroy plan. Files: src/lib/actions/defs/env-teardown.ts, src/lib/execution/destroy.ts, src/app/(product)/platform/environments/[id]/environment-teardown.tsx, docs/platform/operations/TEARDOWN.md.

## Do
1. A read-only "review teardown" entry (browser action + the platform REST/MCP surface the other env actions use) that, under observe credentials and the
   environment lease, runs the destroy plan (planDestroy), records tofu_plan evidence + the PlanView artifact, and opens a pending teardown proposal bound to that
   digest. It never applies. Mutating capability is NOT required to request a review; applying still needs the existing human approval + guards.
2. Idempotency per environment (one open review at a time; a new review supersedes a stale one with a recorded reason).
3. UI: a "Review teardown" button and the review state on the environment page; the existing approve path consumes it.
4. Tests: review creates evidence + proposal and applies nothing; an agent can request but not approve; superseding; refusal paths.

## Owned paths
src/lib/actions/** , src/lib/execution/destroy.ts , src/lib/capabilities/** (teardown review wiring only) , src/app/(product)/platform/environments/** , src/app/api/platform/v1/** (teardown routes only) , src/lib/agent-access/v3/** (teardown review tool only) , tests/actions/** , tests/execution/destroy*.test.ts , tests/capabilities/** , tests/screens/platform/** , docs/platform/operations/TEARDOWN.md , docs/LIMITATIONS.md
Anything outside: list it in your final report as an orchestrator follow-up instead of editing it.

## Rules that always apply
Deterministic code owns credentials, policy, approvals, state and execution; models only propose. Approvals are human, browser-only,
bound to an immutable plan digest. No secret value in logs, state, evidence, errors, URLs or test output. Nothing is labelled live-verified.
Update docs/LIMITATIONS.md: remove or narrow the gap line you closed, and keep any remainder honest.

## Verification
- `npx tsc --noEmit` (at most twice) ; `npx eslint <touched paths>`
- `npx vitest run --maxWorkers=1 <the suites you touched or that cover the code you changed>`
- `npx vitest run --maxWorkers=1 tests/docs` if you changed any doc or a claim a docs guard checks
- Anything your sandbox cannot run (tofu, opa, go, temporal, Docker, live cloud): write the test anyway, gate it the way the repo
  already gates such tests, and SAY it was not run; the orchestrator runs it outside the sandbox.
