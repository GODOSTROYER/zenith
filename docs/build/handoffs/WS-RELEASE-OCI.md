# WS-RELEASE-OCI - release ports for OCI environments (container image rollout + migrations through the runner)

Workstream: WS-RELEASE-OCI (orchestrator brief, wave 8) - Branch ws/release-oci - worktree Z:/Projects/Spawned.ai/zenith-wt/ws-release-oci
Base: ws/integrate-w6 (staging: all of wave 7 merged)

## Situation
docs/LIMITATIONS.md ("Still-open gaps at source snapshot 3c1fa66") lists this as an open code gap. Read that line, the linked operator guide, and the code it names before designing anything.
createReleasePorts has no OCI entry. OCI calls go only through the registered runner (oci.http; src/lib/providers/oci/runner-transport.ts, allowlist.ts, go/internal/oci).

## Do
1. OCI workloads port: update a Container Instance (or the OCI driver's workload kind) to a new image digest via oci.http with the deploy capability; wait for ACTIVE with bounded polling.
2. Migrations port: a one-off container instance run with the command; bounded wait; redacted logs.
3. Build port: refuse clearly ("bring a pre-built OCIR image") unless you can wire OCI DevOps build safely; never fake.
4. Allowlist: add only the exact write rules needed, to the right capability, in src/lib/providers/oci/allowlist.ts; regenerate go testdata
   (scripts/generate-oci-allowlist.ts); update the Go golden sizes in go/internal/oci/oci_test.go. Go tests may be unrunnable; say so.
5. Tests: contract tests over the runner transport fake.

## Owned paths
src/lib/platform/release*.ts , src/lib/platform/execution.ts (composition lines only) , src/lib/providers/oci/** , go/internal/oci/** , scripts/generate-oci-allowlist.ts , tests/platform/** (release tests) , tests/providers/oci/** , tests/runners/** (OCI cases) , docs/platform/RUNNER-PROTOCOL-OCI.md , docs/platform/operations/BUILDS.md (OCI section) , docs/LIMITATIONS.md
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
