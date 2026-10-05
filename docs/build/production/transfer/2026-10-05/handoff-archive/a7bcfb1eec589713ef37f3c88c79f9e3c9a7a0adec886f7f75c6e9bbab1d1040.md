# WS-IMAGE-PINS - every build/tool image Zenith runs is digest-pinned, with a guard

Workstream: WS-IMAGE-PINS (orchestrator brief, wave 8) - Branch ws/image-pins - worktree Z:/Projects/Spawned.ai/zenith-wt/ws-image-pins
Base: ws/integrate-w6 (staging: all of wave 7 merged)

## Situation
docs/LIMITATIONS.md ("Still-open gaps at source snapshot 3c1fa66") lists this as an open code gap. Read that line, the linked operator guide, and the code it names before designing anything.
GCP's build step uses `gcr.io/cloud-builders/docker` by tag (src/lib/providers/gcp/drivers/build/build-api.ts ~101). Other providers pin their bootstrap/tool images (see WS-BUILD-AZURE).

## Do
1. Pin gcr.io/cloud-builders/docker (and any other tool/bootstrap image you find) by sha256 digest, keeping the tag in a comment and one exported constant per image.
   Resolve each digest from the registry's public manifest. If you cannot reach the registry, do NOT invent a digest: stop and list the exact images and the
   command the orchestrator must run to resolve them.
2. A repo guard test that scans src/lib/providers/** and deploy/** for image references and fails on any tag-only or :latest reference outside an explicit allowlist.

## Owned paths
src/lib/providers/**/build/** , src/lib/providers/**/drivers/** (image constants only) , deploy/** (image refs only) , tests/security/image-pins.test.ts , tests/providers/** (affected expectations) , docs/platform/operations/BUILDS.md , docs/LIMITATIONS.md
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
