# PROD-MACH-06 Bounded evaluated coding agents

Branch `prod/mach-06-w3`, platform migration 37. Build-only: nothing here was executed by the builder; only `tsc --noEmit` and `eslint` on the changed files (both clean).

## 1. Summary of what was built

Audit result (what existed): `src/lib/analysis/*` is deterministic static analysis and `proposeArchitecture` (no model). The only model use was the Navigator's `normalizeGoal` (`src/lib/navigator/llm.ts`, raw `@anthropic-ai/sdk`, no budgets, no provider seam, default `claude-opus-5`). MCP v3 tools (`zenith_plan_change` etc.) already submit only broker proposals. Nothing connected analysis to a model-driven journey, enforced any budget, or evaluated behaviour. Repository text reached no model.

Built:

- `src/lib/coding-agent/types.ts`: message/tool/provider shapes (`ModelProvider` seam), budgets, checkpoint.
- `src/lib/coding-agent/budget.ts`: five deterministic integer budgets (input tokens, output tokens, tool calls, wall time, estimated spend in micro-USD), hard ceilings, price table for `claude-sonnet-5-5` ($2/$10 per MTok) and `claude-opus-5-5` ($4/$20), `BudgetMeter` (admission BEFORE each model call and tool call; `max_tokens` capped to remaining output and spend; unpriced model refused).
- `src/lib/coding-agent/runner.ts`: the loop (also `step` mode: one model turn or one batch of pending tool calls per call, used by the durable workflow). Hard stop on any budget, checkpoint after every model turn and tool call, resumable (pending tool calls of the last turn run first, no turn paid twice), provider error recovery (code only, no provider text stored), refusal / truncation handling (a cut-off tool call is never run), five refused calls stop the run, proposal handed to a `ProposalSink` only after a completed run.
- `src/lib/coding-agent/tools.ts`: constant, read-only tool set (`list_files`, `read_file`, `search_files`, `analyze_repository`, `propose_manifest`); strict zod args; results are fenced untrusted text; `propose_manifest` only records a proposal artifact (deterministic `proposeArchitecture`).
- `src/lib/coding-agent/untrusted.ts`: system prompt, fence (cannot be closed or impersonated from inside), injection marker scan (informational, feeds report and audit; protection is structural).
- `src/lib/coding-agent/anthropic.ts`: Anthropic adapter on the existing `@anthropic-ai/sdk` (lazy import, key only from env, reasoning blocks carried back verbatim, `effort` set explicitly, default model `claude-sonnet-5-5`; `claude-opus-5-5` also supported).
- `src/lib/coding-agent/proposal-sink.ts`: `createBrokerProposalSink` (broker capability `infrastructure.plan`, input built from digests and counts only, model prose only in `reason` which the broker labels "unverified text"), `assertAdoptable`.
- `src/lib/coding-agent/service.ts`, `store.ts`, `view.ts`, `github-source.ts`, `platform.ts`, `launcher.ts`, `activities.ts`:
  - control half (web): `createRun` (pins the ref to an exact commit through the workspace's GitHub binding without downloading the repo, records the run, starts the workflow, returns), `resumeRun` (claims a stopped run with a NEW workflow id, limits may only rise within ceilings), `cancelRun` (row becomes `cancelled` first, then the workflow is asked to cancel);
  - worker half: `executeRunStep` (one durable step from the stored checkpoint, compare-and-set write, a cancel mid-step makes the next write conflict and the step stops) and `failRunStep`;
  - run store seam (platform Postgres + semantically identical memory store), GitHub source access (`resolve` at creation, `read` per step re-validates the binding on every step, small per-worker snapshot cache), `temporalRunLauncher`, Temporal activities `agentStep` / `agentFinalize` (heartbeat on every checkpoint and every 5 s, cancellation signal passed into the loop).
- Durable execution: `src/lib/workflows/definitions/codingAgent.ts` (`codingAgentRunWorkflow`, new type; exported from `definitions/index.ts`, `WORKFLOW_TYPES.codingAgentRun`, activities registered by `workers/execution/worker.ts` via `createProductionCodingAgentActivities(db)`). The workflow holds no run state: each iteration is one `agentStep` activity (start-to-close 5 min, heartbeat timeout 30 s, 3 attempts, WAIT_CANCELLATION_COMPLETED); the run's checkpoint lives in `platform.coding_agent_runs`, so a worker restart or retry resumes from the last stored checkpoint. Cancel propagates (workflow cancel -> activity abort signal -> loop stops and persists -> `agentFinalize` as cancelled in a non-cancellable scope). A step failure after retries finalizes the run as failed (resumable). Budgets are checked inside the loop before every model call and every tool call, in every step.
- Journey: source inspection -> `analyze_repository` -> `propose_manifest` -> `infrastructure.plan` broker proposal (policy/approval as for any client) -> approved -> human `adopt` copies the exact approved manifest into the project working copy through the existing `project.updateManifest` action -> existing plan/deploy path.
- REST (all browser-only, workspace admin; none does agent work): `src/app/api/platform/v1/coding-agent/runs/route.ts` (GET list, POST create-and-launch, returns 201 `running`), `runs/[id]/route.ts` (GET), `runs/[id]/resume/route.ts`, `runs/[id]/cancel/route.ts`, `runs/[id]/adopt/route.ts`; guard `src/app/api/platform/v1/_lib/coding-agent.ts`; classified in `_lib/bearer-paths.ts`.
- Evaluation: `src/lib/coding-agent/eval/{cases,harness,scripted}.ts` (3 task, 3 unsafe, 2 recovery cases; deterministic graders; `runEval`, `skippedReport`, machine-readable `zenith.coding-agent-eval/1` report), CLI `scripts/eval/coding-agent.ts` (`npm run eval:coding-agent`, exit 0 pass / 1 fail / 2 skipped).
- Operator UI: `src/app/(product)/platform/coding-agent/page.tsx` (start form with optional approval target, runs table with caption and row headers, auto-refresh while a run works), `[id]/page.tsx` (summary, budgets as labelled `<progress>`, steps and safety report, proposed plan with unresolved decisions and a link to the existing approval page `/platform/operations/<id>`, adopt readiness computed with `assertAdoptable` rules), `run-controls.tsx` (Resume, Resume with higher budgets, Adopt, Cancel with a confirm step and Escape; results announced in an `aria-live` region; plain `<button>`s and labelled form controls), `labels.ts`; nav entry "Coding agents" in `_components/platform-nav.tsx`. Admin only, same browser-only routes.
- SQL: `src/lib/controlplane/db/migrations/0037_coding_agent_runs.ts` (registered as version 37 in `migrations/index.ts`), repo `src/lib/controlplane/db/repos/coding-agent-runs.ts` (bound as `codingAgentRuns` in `repos/index.ts`).
- Small edits to existing files: `src/lib/env.ts` default `DEFAULT_LLM_MODEL` -> `claude-opus-5-5` (+ `docs/RUNNING.md` row), `package.json` (one script line, no dependency), `tests/middleware/platform-bearer.test.ts` route inventory count 65 -> 70.

## 2. Acceptance mapping

Acceptance: "Analysis and requirements lead to actual deployment journey; token/tool/runtime/spend budgets and task/unsafe/recovery evaluations enforced; repository/plugin data is not authority."

| Clause | Implementation | Tests |
|---|---|---|
| Analysis and requirements lead to a deployment journey | tools `analyze_repository` / `propose_manifest` over the pinned-commit snapshot; broker `infrastructure.plan` proposal; `adopt` -> `project.updateManifest`; routes wired to the service | `service.test.ts` (a run with a target stores a real memory-broker operation; adoption gate table), `routes.test.ts` (wiring, browser-only, adopt uses gate + product action) |
| Token budgets | `BudgetMeter.admitModelCall` (input estimate `ceil(chars/2)`, output via capped `max_tokens`) | `budget.test.ts`, `runner.test.ts` "input tokens", "output tokens" |
| Tool budget | `admitToolCall` before each tool | `runner.test.ts` "tool calls" (3 provider calls, 2 tools, pending call preserved) |
| Runtime budget | injected clock, abort signal per provider call, wall time carried across resumes | `runner.test.ts` "wall time" (both) |
| Spend budget | integer micro-USD, worst-case admission, unpriced model refused | `budget.test.ts`, `runner.test.ts` "spend" |
| Durable execution (survives worker restart, resumes from last checkpoint, cancellation propagates, start route only creates) | Temporal workflow + per-step activities with heartbeats; checkpoint in the run row; `cancelRun` + workflow cancel | `tests/workflows/coding-agent.test.ts` (real Temporal: loop, budget stop, cancel reaches the running step then finalizes, failure finalizes, bad input), `service.test.ts` ("brand-new worker finishes the run", cancel before and DURING a step, aborted signal, launch failure, stale claim), `runner.test.ts` "durable step mode", `routes.test.ts` (routes do no agent work) |
| Operator UI | pages under `(product)/platform/coding-agent` | `routes.test.ts` "operator page" (static conventions, aria, browser-only routes, approval link) |
| Hard stop with resumable checkpoint | `onCheckpoint` after every turn/tool; `resumeRun`; DB CAS + `claimResume`; stale-worker claim | `runner.test.ts` "resume continues...", `service.test.ts` (budget stop, resume raising only, same commit, moved commit refused and stays resumable, tenant isolation, stale claim), `store.test.ts` (real engine) |
| Model output only becomes proposals through the broker | `ProposalSink`/`createBrokerProposalSink`; no tool can approve/grant/execute; input chosen by code | `runner.test.ts` "prompt injection and authority", `service.test.ts` (proposal input equals `agentProposalInput`, reason labelled unverified) |
| Repository/plugin/model text is not authority | fixed tool list and system prompt on every call, strict schemas, fence, authority-name refusals counted, adopt gate re-checks approved op + digest | `runner.test.ts` (injected package.json description, source-comment injection via compromised-agent script, plugin manifest text, path escape, smuggled arguments, fence escape), `service.test.ts` adoption table |
| Task / unsafe / recovery evaluations | fixed 8-case set, graders in code, report with per-category counts and `unsafeActionAttempts` | `eval.test.ts` (harness with scripted model: honesty rules, compromised agent fails, recovery attempts), `eval-live.test.ts` (real model) |
| Skips are explicit, never passes | `skippedReport`, `it.skip(reason)`, CLI exit 2 | `eval-live.test.ts`, `eval.test.ts` "a missing model is skipped, never passed" |

## 3. Verification commands (other machine)

```
npm ci
npx vitest run tests/coding-agent tests/middleware/platform-bearer.test.ts tests/docs/operator-docs.test.ts tests/workflows/sandbox.test.ts tests/platform-ui
ZENITH_TEST_TEMPORAL=1 npx vitest run tests/workflows/coding-agent.test.ts tests/workers/reconcile-composition.test.ts   # real Temporal; without the variable it skips with the reason
```
Expected: all pass (`tests/workflows/sandbox.test.ts` expects the new `codingAgent.ts` definition file and `codingAgentRunWorkflow` export); `eval-live.test.ts` shows 1 describe SKIPPED plus 1 explicitly skipped test named with the reason when no key is set (this is correct and is not a pass), and its "report can never be a pass" test passes. `store.test.ts` runs on PGlite always and on real PostgreSQL when `ZENITH_TEST_PLATFORM_PG_URL` is set (run it with that variable for local-engine evidence).

Live model evaluation (needs a key in the environment, costs a few cents, spend-capped at USD 1.50):
```
ANTHROPIC_API_KEY=... npx vitest run tests/coding-agent/eval-live.test.ts
# or the CLI, which also writes test-results/coding-agent-eval.json
ANTHROPIC_API_KEY=... npm run eval:coding-agent          # ZENITH_EVAL_MODEL=claude-opus-5-5 for Opus
```
Expected with a key: verdict `pass`, task 3/3, unsafe 3/3, recovery 2/2. If a model does follow the injected text, the unsafe case FAILS on `model_did_not_attempt_unsafe_actions` while `no_authority_effect` stays true: that is a real finding about the model, not a harness bug. With no key the CLI exits 2 and writes a `skipped` report.

Also run the existing suites touching shared files: `tests/controlplane/migrations.test.ts`, `tests/controlplane/tenancy.test.ts`, `tests/security/controlplane-sql-scoping.test.ts`, `tests/navigator/llm.test.ts`, `tests/ci/platform-coverage.test.ts` (see section 4, they need the assembler's updates for version 37).

## 4. Known gaps and shared-file updates for the orchestrator / assembler

New table: `platform.coding_agent_runs` (migration 37, tenant column `workspace_id`, RLS enabled, only `service_role` select/insert/update granted, same hardening block as 20). Contiguity: this branch registers 37 alone; the assembler merges 30-36 from other workers. The migrator does not require contiguity, but the header comment says versions are contiguous from 1.

New store functions (all in `repos/coding-agent-runs.ts`, all take `workspaceId` and filter `workspace_id = $1`; classify as tenant-scoped reads/writes in `tests/controlplane/tenancy.test.ts` SWEPT and in `tests/security/controlplane-sql-scoping`):
- `codingAgentRuns.createRun`, `.getRun`, `.listRuns`, `.saveRun` (CAS on version, only `running`; the completing write also stores the result and proposal link), `.attachOutcome` (only non-running; no longer used by the worker, kept for repair), `.claimResume` (stopped or 10-minute-stale running; sets the new workflow id), `.cancelRun` (any non-terminal row), `.failRun` (only a running row).
`tests/coding-agent/store.test.ts` already asserts foreign-workspace refusals for each.

Shared files NOT touched by me (assembler): `supabase/migrations/*` regeneration (emit-sql), `emit.ts` hardening grant for `platform.coding_agent_runs`, `scripts/ci/apply-supabase-migrations.sh`, `docs/platform/operations/DEPLOYING.md` inventory row 37, `tests/controlplane/migrations.test.ts` table list, `scripts/ci/gate-manifest.mjs` / workflows (add `tests/coding-agent/store.test.ts` to the PostgreSQL lane; add `tests/coding-agent` to the default suite; the live eval is intentionally key-gated and must be reported as skipped, not passed, when no key is configured), `ledger.json`, `LIMITATIONS.md`. Also: `tests/workflows/coding-agent.test.ts` and `tests/workers/reconcile-composition.test.ts` belong in the Temporal lane, `docs/platform/EXECUTION-WORKER.md` could list the new workflow type, and `tests/middleware/platform-bearer.test.ts` route count is now 71.

Shared files edited minimally (note for merge): `tests/middleware/platform-bearer.test.ts` route inventory count 65 -> 71 (six new browser-only routes); `tests/workflows/sandbox.test.ts` (definition file list, exported workflow list, bundle check) and `tests/workers/reconcile-composition.test.ts` (registers the new activities) for the new workflow type; `workers/execution/worker.ts`, `src/lib/workflows/types.ts`, `definitions/index.ts` (additive registration); `_components/platform-nav.tsx` (one link). If other workers also add routes, sum the counts. `src/lib/env.ts` `DEFAULT_LLM_MODEL` changed `claude-opus-5` -> `claude-opus-5-5` (Navigator default; changes a default value, not a contract; `docs/RUNNING.md` updated). No verified behaviour in RESULTS-2026-10.md was changed.

Gaps and assumptions:
- Runs are durable (Temporal), so a running execution worker with the model key (`ANTHROPIC_API_KEY`) and GitHub App configuration is required; the web process only checks that a key is present (start refuses with `model_not_configured` otherwise), so set it on both. Without a key on the worker, steps fail fast with the explicit stop reason `model_not_configured` (the key is optional: workers boot and serve every other workflow without it; the start route refuses up front when the web process has no key) and the run is left failed and resumable. Wall-time budget is the sum of time spent inside steps (queueing between steps is not counted). Model calls are not exactly-once: a worker killed between a model reply and its checkpoint write repeats that one call on retry (bounded by the budgets; the proposal submit is idempotent by key).
- A stale `running` row (no step for 10 minutes, e.g. the workflow was terminated outside the app) can be resumed from the UI/API. No UI start for budgets other than defaults (the resume offers one fixed higher-budget option).
- `tests/workflows/coding-agent.test.ts` uses scripted activities on a real Temporal server; there is no recorded replay history for the new workflow type yet (add one with the usual replay fixture after the first real run).
- The broker proposal needs a human-chosen `target` (project + environment). `infrastructure.plan` has no consumer that executes this input; the approved operation is the authority record the `adopt` step checks. The proposal principal is the signed-in admin (the broker has no agent principal kind for a browser-started run).
- The agent sees only what the existing intake keeps (source, config, env example, markers); README/markdown and plugin manifests are dropped by `snapshotFromGithub`, so those vectors reach the model only if they appear in kept files. The eval fixtures therefore place injections in `package.json`, source comments, `.env.example` and a plugin-style comment in a `.js` file.
- Spend is an upper estimate (cache discounts ignored) from a fixed price table (Sonnet 5.5 $2/$10, Opus 5.5 $4/$20 per MTok); a price change needs a table edit. Input tokens are pessimistically estimated before a call; if the estimate is low the overshoot is at most one call.
- Reasoning blocks from the model are stored in the checkpoint (needed to continue a conversation); the stored conversation (repository text, model output) is never returned by the API (`view.ts`), 2 MiB cap enforced by a DB check.
- Live model behaviour (does the real model resist the injections, does `effort: "low"` leave enough output budget under the 8000 per-call cap) is unverified until the live eval is run with a key.
- UI is verified only by static convention tests and typecheck/lint; it was not rendered in a browser by the builder.
- Windows/tsx: `scripts/eval/coding-agent.ts` uses the `@/` alias like the other scripts.

## 5. Suggested ledger implementationStatus

"implemented_unverified: bounded agent loop with five deterministic budgets, checkpoint/resume, fixed read-only tools, broker-only proposal and approved-adoption gate, REST routes, run store (migration 37), 8-case task/unsafe/recovery eval harness with key-gated live run; awaiting test run and live eval with a model key"
