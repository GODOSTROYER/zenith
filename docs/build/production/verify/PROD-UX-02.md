# PROD-UX-02 verification: configured client interoperability

Branch `prod/ux-02-w3` (base c9a942d6). Built on Windows without running any test; typecheck
(`tsc --noEmit -p .`) and eslint on the changed files were the only checks run. Everything below that
says "expected" is a prediction for the verifying machine, not a result.

## 1. What was built

Audit first (what existed): MCP v3 (`src/lib/agent-access/v3`), v2 control MCP, RFC 9728 protected
resource metadata for v2 and v3 (exact `resource`, exact issuer, no JWKS leak), OAuth resource-server
verification with exact issuer/audience/client and a per-request grant intersection (`control/oauth.ts`),
linked `za_` credentials with browser consent and revoke, reviewed `zp_` plugin tokens (audience bound), the
`zenith` CLI and `src/lib/sdk` REST client (cookie/bearer REST, no MCP). All of v3 was stateless JSON
only. The Zenith Claude Code plugin (`Z:\Projects\Spawned.ai\Zenith-plugins`, read-only) is a stdio
bridge to the v1/v2 reader with `za_` tokens, JSON-only (it refuses SSE and sessions); it does not use v3.

Missing, now built:

| Gap | Built |
|---|---|
| explicit protocol refusal | `src/lib/agent-access/v3/protocol.ts` (pinned 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26; 400/-32602 with `supported`; 2024-11-05, 2024-10-07, malformed and unknown-older refused; newer unknown counter-offered); wired in `v3/server.ts` for every method |
| streaming + resumable reconnect | `v3/stream.ts` + `server.ts`: SSE for `tools/call` with `_meta.progressToken` and `Accept: text/event-stream`; durable events; `GET` + `Last-Event-ID` resume bound to the principal; progress from the wrapper and from execute/propose steps |
| durable storage | platform migration **35** (assembled; was 36 on the branch) `0035_mcp_streams.ts`: `platform.mcp_streams`, `platform.mcp_stream_events`; repo `repos/mcp-streams.ts` (registered in `repos/index.ts` and `bindRepos`) |
| client cancellation to the broker | `notifications/cancelled` handling (202, in-process registry + durable `cancel_requested_at`); `ToolContext.cancel/progress`; reads race the cancel; `propose.ts` withdraws a recorded proposal via `broker.cancelOperation`; `execute.ts` stops before the claim; `requestCancelled()` error |
| revocation endpoint | RFC 7009 `POST /api/agent/oauth/revoke` (`src/app/api/agent/oauth/revoke/route.ts`, `src/lib/agent-access/oauth/revoke.ts`, `revoke-default.ts`); `za_` -> authority revoke, `zp_` -> `revokePluginTokenByPossession` (new, `src/lib/plugins/service.ts`), OAuth -> revoke the Zenith grant; middleware bypass entry |
| issuer metadata (RFC 8414) | `src/lib/agent-access/oauth/as-metadata.ts` (discovery order, exact-issuer and PKCE/https/JWKS checks); wired into `npm run doctor` (`scripts/doctor.ts`) and the harness |
| scoped consent | `src/lib/agent-access/scope-catalog.ts`; `GET /api/integrations/agent` now also returns `consent` (issuer, both resources, scope catalog, revocation endpoint); Integrations screen shows "You are authorizing" with literal `zenith:<scope>` strings and per-scope OAuth strings |
| conformance harness | `scripts/agent/mcp-conformance/{client,journey}.ts`, `scripts/agent/mcp-conformance.ts` (`npm run agent:conformance`), docs `docs/platform/CLIENT-INTEROP.md` with real-client commands |

UX-03 plugin tokens: unchanged audience binding (`authenticatePluginToken` untouched). The only addition is
`revokePluginTokenByPossession`, which can only end a grant.

## 2. Acceptance mapping

| Clause | Implementation | Tests |
|---|---|---|
| exact OAuth issuer | PRM `authorization_servers` = configured issuer (existing); `as-metadata.ts` exact `issuer` equality; doctor | `tests/agent-v3/as-metadata.test.ts`; `oauth-metadata.test.ts` (existing); journey step `discovery`; `scope-catalog.test.ts` (PRM agrees with consent) |
| exact audience | existing `verifyOAuth` (`aud`=exact v3 resource); revoke accepts v3 and v2 audiences only | `client-conformance.test.ts` OAuth leg (v2/other-resource/other-issuer/expired/foreign key refused); `oauth-revoke.test.ts`; plugin audience: `tests/plugins/service.test.ts` (existing) + revoke test |
| scoped consent | `scope-catalog.ts`, `browser.ts` `consent`, `integration-control.tsx` `ConsentSummary`; token scopes intersect grant scopes (existing `bindGrant`) | `scope-catalog.test.ts`, `tests/screens/integrations-consent.test.tsx`, OAuth leg "only scopes in BOTH", journey `scopes` |
| revocation (immediate) | `/api/agent/oauth/revoke` + existing Integrations revoke (grants, linked agents) | `oauth-revoke.test.ts` (real jose + journal + PGlite plugin store), `client-conformance.test.ts` journey `revocation` over HTTP for `za_` and OAuth, middleware bypass + route wiring tests |
| streaming | SSE with progress and stored events | journey `streaming`; conformance "modern call", "default call stays JSON" |
| reconnect | `GET` + `Last-Event-ID`, principal-bound, follows a running call | journey `resume`; "a dropped connection is not a cancellation"; `stream-store.test.ts` (real engine) |
| cancellation | see above | journey `cancel`; "explicit cancellation of a propose call withdraws the proposal"; "cancelled execute stops BEFORE the claim"; "cancel recorded by ANOTHER instance"; `stream-store.test.ts` durable cancel |
| version compatibility | `protocol.ts` | `protocol.test.ts` (pinned set subset of SDK), journey `versions`, route edge cases |
| harness drives clients through the journey, runnable on the verifier machine | `scripts/agent/**`, `docs/platform/CLIENT-INTEROP.md` | `client-conformance.test.ts` runs the same journey over a real socket |

## 3. Verification commands

Node 22 (`Promise.withResolvers` is used in tests).

```
npx vitest run tests/agent-v3/protocol.test.ts tests/agent-v3/as-metadata.test.ts \
  tests/agent-v3/scope-catalog.test.ts tests/agent-v3/oauth-revoke.test.ts \
  tests/agent-v3/stream-store.test.ts tests/agent-v3/client-conformance.test.ts \
  tests/screens/integrations-consent.test.tsx tests/controlplane/tenancy.test.ts
# regression of what the change touches:
npx vitest run tests/agent-v3 tests/plugins tests/agent-link-routes.test.ts tests/agent-serverless-routes.test.ts \
  tests/agent-control-oauth.test.ts tests/screens/integrations-control.test.tsx tests/security/controlplane-sql-scoping.test.ts \
  tests/controlplane/migrations.test.ts tests/cli
ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/agent-v3/stream-store.test.ts tests/agent-v3/client-conformance.test.ts tests/agent-v3/oauth-revoke.test.ts tests/controlplane/tenancy.test.ts
npm run typecheck && npx eslint scripts/agent src/lib/agent-access src/app/api/agent/oauth tests/agent-v3 tests/screens/integrations-consent.test.tsx
```

Expected: all pass on PGlite; the PostgreSQL lane runs the same files. `tests/controlplane/migrations.test.ts`
"contiguous versions from 1" will FAIL on this branch alone (versions 30-35 belong to sibling wave-3
workers) until the assembler merges; every other test is independent of that.

Against a running Zenith (optional, needs a real credential): `npm run agent:conformance -- --print-commands`
prints the commands for Claude Code, Codex and MCP Inspector; see section 7 of `docs/platform/CLIENT-INTEROP.md`.
Those real-client runs were NOT performed by the builder.

## 4. Known gaps and what may break first

Assumptions about SDK 2.0.0 behaviour that were read from its source but never executed, in the order they
are likeliest to fail:

1. `McpServer` option `supportedProtocolVersions` and the legacy transport's priming event: the SDK sends the
   priming event only when the request carries `MCP-Protocol-Version >= 2025-11-25`; older clients get ids
   from their first progress event. The harness sends 2025-11-25.
2. `context.mcpReq.notify(progress)` reaching the POST's SSE stream in stateless legacy mode, and the SDK not
   tying handler aborts to `request.signal` (the streamed path hands the SDK a request with no abort signal).
3. `isLegacyRequest` for a bare `GET` (the test only asserts that no 200 stream is offered).
4. Modern (2026-07-28) `responseMode: "auto"` upgrading to SSE only when progress is emitted (the test
   accepts JSON or SSE).
5. `tests/screens/integrations-consent.test.tsx` drives the form through React with a native input setter.

Known limitations (also in `docs/platform/CLIENT-INTEROP.md` section 8): the official MCP SDK client
(`@modelcontextprotocol/client`) is not installed and no dependency could be added, so the automated harness
uses its own fetch client and `--official` is an unexecuted optional leg; Zenith hosts no authorization server
(no RFC 8414 document of its own, no DCR, no refresh tokens, issuer-side token revocation is not performed);
resume depends on the running instance staying alive up to 55 s; non-streamed in-flight cancellation reaches
only the instance holding the call; modern (2026) requests have no resumable ids (retry with the same
idempotency key); no real Claude Code/Codex run, no live issuer, no PostgreSQL run were done on the builder.

Verified behaviour changed: none intentionally. Observable differences: a `MCP-Protocol-Version` or
`initialize` version outside the pinned set is now refused by Zenith (400/-32602) before the SDK sees it
(previously the SDK refused unsupported header versions itself and negotiated down on initialize);
`GET /api/integrations/agent` gained a `consent` member; `v3/server.ts` was restructured (JSON replies are
produced exactly as before).

## 5. Shared-file updates the orchestrator/assembler must make

- Migration inventory: new **platform migration 35 `mcp_streams` (renumbered from 36 at assembly)** (`src/lib/controlplane/db/migrations/0035_mcp_streams.ts`,
  registered in `migrations/index.ts`); include in the wave-3 `0022_platform_core.sql` emit. Tables:
  `platform.mcp_streams`, `platform.mcp_stream_events` (both RLS enabled, anon/authenticated revoked,
  service_role select/insert/update/delete).
- Store functions (`repos.mcpStreams`, registered in `repos/index.ts`/`bindRepos`) and tenancy classification.
  I already added these to `tests/controlplane/tenancy.test.ts`; re-apply if the assembler regenerates it:
  - SWEPT (workspace_id and principal digest in SQL): `readStreamEvents`, `streamCancelRequested`, `streamStatus`
  - WRITES (bind supplied workspace and principal digest): `openStream`, `appendStreamEvent`, `requestStreamCancel`, `finishStream`
  - EXEMPT: none. `controlplane-sql-scoping` requires `workspace_id` in every function mentioning a tenant
    table: satisfied by construction.
- Gate manifest: add the seven new unit files in section 3 to the agent/MCP cohort; the PGlite files
  (`stream-store`, `client-conformance`, `oauth-revoke`) belong with the lane that already runs PGlite suites.
  Add a doctor/conformance mention to the operator runbook if desired.
- LIMITATIONS: add the items in section 4 ("Known limitations").
- No workflow, Temporal, OPA or Go change. No new npm/Go dependency. `package.json` gained one script
  (`agent:conformance`).

## 6. Suggested ledger implementationStatus

`in_progress / client_interop_built_audience_scopes_revocation_streaming_resume_cancel_version_refusal_unit_and_loopback_conformance_unrun_real_clients_and_official_sdk_client_unverified`
