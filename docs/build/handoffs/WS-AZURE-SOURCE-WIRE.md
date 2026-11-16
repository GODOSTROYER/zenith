# WS-AZURE-SOURCE-WIRE - default composition builds Azure workloads from C3 source bundles

Workstream: WS-AZURE-SOURCE-WIRE (orchestrator brief, wave 8) - Branch ws/azure-source-wire - worktree Z:/Projects/Spawned.ai/zenith-wt/ws-azure-source-wire
Base: ws/integrate-w6 (staging: all of wave 7 merged)

## Situation
docs/LIMITATIONS.md ("Still-open gaps at source snapshot 3c1fa66") lists this as an open code gap. Read that line, the linked operator guide, and the code it names before designing anything.
Azure source builds need a source reader and a provider-dispatched preparation port; createReleasePorts (src/lib/platform/release.ts) passes `options.azure` through but default composition (src/lib/platform/execution.ts) supplies neither. See src/lib/platform/release-azure.ts and src/lib/platform/source-bundle.ts (C3).

## Do
1. Implement the Azure source reader over the broker Azure session (read the C3 tar.gz from the customer storage account/container C3 uploaded to; verify digest and size bounds).
2. Provider-dispatched preparation port so AWS/GCP/Azure each prepare the bundle form their builder needs (AWS ZIP, GCP/Azure tar.gz) from one call site.
3. Compose both in default composition; refuse clearly when the environment lacks the storage binding.
4. Tests with mocked Azure SDK/REST contracts: digest mismatch, oversized, foreign container, missing binding, happy path into the ACR build.

## Owned paths
src/lib/platform/release*.ts , src/lib/platform/source-bundle.ts , src/lib/platform/execution.ts (composition lines only) , src/lib/providers/azure/** (source read helpers only) , tests/platform/** (release/source tests) , tests/providers/azure/** , docs/platform/operations/BUILDS.md , docs/LIMITATIONS.md
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
