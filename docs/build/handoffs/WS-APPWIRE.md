# WS-APPWIRE — make the platform API usable by integrations, and ship the policy bundle

Workstream: WS-APPWIRE (new; orchestrator brief) — Branch ws/appwire — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-appwire
Base: platform/integration @ e92a3df (tsc clean)

## Problems (verified by the orchestrator)
1. Bearer callers are refused before reaching the platform REST handlers.
   - `src/middleware.ts` exempts the agent MCP paths, the OIDC issuer and the runner/machine
     signed paths (`isAgentSignedPath`), then runs the Supabase cookie gate (`updateSession`) on
     everything else, which answers 401 "Sign in to use the API" to a request with no session.
     So an integration calling `/api/platform/v1/capabilities/propose|check`,
     `/api/platform/v1/operations[/…]` (GET), `/operations/{id}/events`, `/operations/{id}/cancel`,
     `GET /environments/{id}/autonomy`, `GET /workspace/policy` with `Authorization: Bearer za_…`
     never reaches its handler.
   - `route()` in `src/lib/server/request.ts:~171` calls `requireProductRequestAccess(req)` (waitlist
     admission) before the handler; with the waitlist gate on, a bearer-only caller has no session
     and is refused (noted by WS-CAP; the MCP route avoids `route()` for this reason).
   - Browser-only routes MUST stay browser-only: `operations/{id}/approve`, `/reject`,
     `PUT environments/{id}/autonomy`, `PUT workspace/policy` (they already refuse any
     Authorization header via `src/app/api/platform/v1/_lib/browser.ts`). Admin runner/machine
     routes (tokens, revoke, list) keep the browser gate.
2. SEC-R2 (MEDIUM): an unexpected request error writes credentials to the server log. Pinned as
   `it.fails` in `tests/security/request-error-logging.test.ts` — read it; the logging lives in
   `route()`'s error path.
3. The OPA policy bundle is not shipped. `src/lib/policy/engine.ts` loads
   `ZENITH_POLICY_WASM` or `<cwd>/policy/dist/policy.wasm` (+ `policy/dist/manifest.json` hash
   check). `next.config.ts` has no `outputFileTracingIncludes` for `policy/dist/**`, and
   `docker/worker.Dockerfile` copies only `src/lib` and `workers/execution` into the build and
   `dist/execution` into the runtime image — so the broker (every `/api/platform/v1` and
   `/api/agent/v3/mcp` request) and the worker answer `policy_unavailable` in a real deployment.

## Owned paths
src/middleware.ts ; src/lib/server/request.ts ; src/app/api/platform/v1/_lib/** ;
next.config.ts ; docker/worker.Dockerfile ; tests/server/appwire-*.test.ts (new) ;
tests/middleware/** (new) ; tests/ci/** (only Dockerfile/next-config assertions that must change) ;
tests/security/request-error-logging.test.ts (ONLY flip the SEC-R2 `it.fails` to `it` once fixed).
Do NOT touch src/lib/server/boot.ts or workers/** (WS-COMPOSE owns them).

## Build
1. Middleware: an exact, regex-anchored allowlist of the bearer-capable platform REST paths (and
   methods) that bypass the cookie gate ONLY when the request carries `Authorization: Bearer`.
   The handler still authenticates (route principal resolution). Keep the browser-only and admin
   routes on the cookie gate. Put the path table in one small exported module (e.g.
   `src/app/api/platform/v1/_lib/bearer-paths.ts`) with tests: every route file under
   src/app/api/platform/v1 is classified (bearer-capable / browser-only / agent-signed / admin),
   so a new route fails the test until classified.
2. `route()`: for a request authenticated by a valid bearer integration credential, skip waitlist
   admission (the credential itself proves workspace membership) — or move admission after
   principal resolution so it applies to session users only. Never weaken the session path.
   Tests: bearer + waitlist on → handler reached; cookie user not admitted → still refused;
   forged/invalid bearer → 401, no handler.
3. SEC-R2: redact/bound the error before logging (use the merged redactors, e.g.
   src/lib/credentials/redact.ts `redactCredentials`); flip the pin.
4. Policy bundle: `outputFileTracingIncludes` for the routes that load the policy engine
   (`/api/platform/v1/**`, `/api/agent/v3/**`, and any other route the broker serves) →
   `./policy/dist/**`; worker Dockerfile copies `policy/dist` into the runtime image at the path
   the engine resolves (or sets ZENITH_POLICY_WASM). Tests: next.config exports the includes;
   Dockerfile copies policy/dist into the final stage; engine resolution works for both layouts.

## Verification
- npx tsc --noEmit ; npx eslint src/middleware.ts src/lib/server/request.ts src/app/api/platform/v1/_lib tests/server tests/middleware
- npx vitest run --maxWorkers=2 tests/server tests/middleware tests/capabilities tests/agent-v3 tests/security/request-error-logging.test.ts tests/ci
