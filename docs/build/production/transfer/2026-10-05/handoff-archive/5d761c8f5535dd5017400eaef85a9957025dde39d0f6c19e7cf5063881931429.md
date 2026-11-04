# WS-RELEASE-K8S - release ports for Kubernetes environments (image rollout + migration jobs)

Workstream: WS-RELEASE-K8S (orchestrator brief, wave 8) - Branch ws/release-k8s - worktree Z:/Projects/Spawned.ai/zenith-wt/ws-release-k8s
Base: ws/integrate-w6 (staging: all of wave 7 merged)

## Situation
docs/LIMITATIONS.md ("Still-open gaps at source snapshot 3c1fa66") lists this as an open code gap. Read that line, the linked operator guide, and the code it names before designing anything.
createReleasePorts throws "Release ports are unavailable for this provider" for kubernetes. Kubernetes drivers (src/lib/providers/kubernetes/**) already do SSA, ownership and rollout reads.

## Do
1. Kubernetes workloads port: deployImage = server-side-apply the container image (by digest) on the owned Deployment/StatefulSet with field manager zenith and ownership checks; waitSteady = rollout status with a bounded wait.
2. Migrations port: run a one-off Job from the workload's pod template with the command, owned + labelled, TTL, bounded wait, redacted log tail.
3. Build port: explicit "bring a pre-built image" unless an external registry/builder is configured; refuse clearly, never fake a build.
4. Wire into the createReleasePorts dispatch; contract tests against the existing fake API server; a gated kind test if the repo has the harness.

## Owned paths
src/lib/platform/release*.ts , src/lib/platform/execution.ts (composition lines only) , src/lib/providers/kubernetes/** (release helpers) , tests/platform/** (release tests) , tests/providers/kubernetes/** , docs/platform/operations/BUILDS.md (Kubernetes section) , docs/LIMITATIONS.md
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
