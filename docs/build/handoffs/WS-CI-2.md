# WS-CI-2 — CI covers everything that now exists; Node engine pin (SEC-F9)

Workstream: WS-CI-2 (new; orchestrator brief) — Branch ws/ci-2 — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-ci-2
Base: platform/integration

## Situation
- .github/workflows/ci.yml (and siblings) were written by WS-CI before most of the platform landed.
  Many suites, gates and toolchains added since may not be in CI: tests/platform (Temporal test env),
  tests/agent-v3, tests/cli, tests/placement, tests/platform-ui, tests/security, Go `./...` incl.
  internal/oci and the machine goldens (cross-language: Go regenerate/compare + TS validate), OPA
  `npm run policy:check`, `npm run platform:emit-sql -- --check`, `npx tsx scripts/docs/capability-matrix.ts --check`,
  gated real-OpenTofu validate lanes (ZENITH_TEST_TOFU_NETWORK=1 with a plugin cache), real Postgres
  lane (ZENITH_TEST_PLATFORM_PG_URL with a service container), gofmt/vet.
- SEC-F9 (MEDIUM): Node 24.x has a JSON.parse defect (nodejs/node#60606); CI and the Dockerfiles pin
  Node 22 but package.json `engines` says `>=22.16`. Pin: tests/security/runtime-sanity.test.ts
  (`it.fails("SEC-F9 …")`).

## Owned paths
.github/workflows/** (except tick.yml — WS-OPS) ; package.json `engines` field ONLY (and `.nvmrc` /
`.node-version` if present) ; tests/ci/** ; tests/security/runtime-sanity.test.ts (flip the SEC-F9 pin only).

## Build
- One coherent CI: lint, typecheck, unit (vitest projects), platform e2e with the Temporal test env,
  Postgres lane, OpenTofu validate lane (cached providers), Go lane, policy/emit-sql/matrix checks,
  docs drift; required checks named stably; no secrets needed for any default lane; the
  live-acceptance workflow stays manual + environment-protected.
- engines: exclude the affected Node 24 versions (e.g. `>=22.16 <23`, or a range that admits only
  fixed 24.x releases if you can cite the fixed version); flip the SEC-F9 pin; tests/ci asserts the
  workflows include every gate above (so removing one fails a test).

## Verification
- npx tsc --noEmit ; npx eslint tests/ci tests/security/runtime-sanity.test.ts
- npx vitest run --maxWorkers=2 tests/ci tests/security/runtime-sanity.test.ts
- (actionlint if available; say if not)
