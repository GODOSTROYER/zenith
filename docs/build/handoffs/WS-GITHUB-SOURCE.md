# WS-GITHUB-SOURCE - tenant-scoped GitHub App connector for private source repositories

Workstream: WS-GITHUB-SOURCE (orchestrator brief, wave 8) - Branch ws/github-source - worktree Z:/Projects/Spawned.ai/zenith-wt/ws-github-source
Base: ws/integrate-w6 (staging: all of wave 7 merged)

## Situation
docs/LIMITATIONS.md ("Still-open gaps at source snapshot 3c1fa66") lists this as an open code gap. Read that line, the linked operator guide, and the code it names before designing anything.
C3 source bundles (src/lib/platform/source-bundle.ts) can only fetch public sources; private GitHub access needs a tenant-scoped connector and default composition supplies none.

## Do
1. A GitHub App connector: per-workspace installation (installation id recorded on the workspace's source binding), installation access tokens minted on demand
   (JWT signed with the App private key from ZENITH_GITHUB_APP_ID / ZENITH_GITHUB_APP_PRIVATE_KEY_FILE), scoped to the single repository with contents:read only,
   used once for the archive download and discarded; never stored, logged, or placed in a URL that is logged.
2. Wire it into C3 source acquisition; public repos keep working without it; refuse a repo outside the installation.
3. A browser-only install/bind flow with the callback handled server-side (no token reaches the browser); operator docs for registering the App (that step is the user's).
4. Tests with a mocked GitHub API: JWT claims, token scope request, repo mismatch, token never in logs/errors.

## Owned paths
src/lib/platform/source-bundle.ts (acquisition hook only) , src/lib/sources/github/** (new) , src/app/api/platform/v1/** (github install callback only) , tests/sources/** , tests/platform/source-bundle*.test.ts , docs/platform/operations/BUILDS.md , docs/platform/operations/DEPLOYING.md (env rows) , docs/LIMITATIONS.md , tests/docs/operator-docs.test.ts (env-var list only)
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
