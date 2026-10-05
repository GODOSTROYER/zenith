# PROD-UX-03 Reviewed revocable plugin boundaries

## 1. Summary

Audit of existing surfaces: the Claude Code plugin lives in a separate repo (`GODOSTROYER/Zenith-plugins`, branch `hardening/plugin-provenance`, not available in this worktree); in this repo a plugin is just an MCP client holding a `za_` credential or OAuth token (`docs/AGENT-CONTROL.md`, `WS-MCP.md`, `WS-SEC.md`). Before this change there was no manifest, no per-tenant review, no plugin-scoped credential, and no way to revoke a plugin without revoking the user's whole connection.

Model built: a plugin is a signed manifest. A workspace admin reviews an exact digest and approves a subset of declared tools/scopes. A member then binds one of their OWN linked credentials to the approved plugin and receives an opaque, audience-bound `zp_` token (hash stored only). On every MCP v3 request the token is resolved live to the parent credential attenuated to the approved tools and scopes, so the broker still decides everything. Revoking a plugin revokes all its tokens in one transaction.

New files
- `src/lib/plugins/manifest.ts` strict zod manifest schema (closed tool set, scopes, publisher, version, artifact digest, literal isolation block), canonical digest, Ed25519 provenance verification against `ZENITH_PLUGIN_TRUSTED_PUBLISHERS`.
- `src/lib/plugins/service.ts` register / review / issue / revoke / `authenticatePluginToken`.
- `src/lib/plugins/runtime.ts` production wiring (platform DB + live credential authority).
- `src/lib/plugins/http.ts` browser-only handlers; `src/lib/plugins/errors.ts`.
- `src/lib/controlplane/db/migrations/0028_plugin_boundaries.ts` (version 28), `src/lib/controlplane/db/repos/plugins.ts`.
- Routes: `src/app/api/integrations/plugins/{route,review,revoke,tokens,tokens/revoke}`.
- Tests: `tests/plugins/{support,manifest.test,service.test,mcp-boundary.test}.ts`.

Edited existing files
- `agent-access/v3/principal.ts` `PluginBinding`, `McpPrincipal.plugin`, `via: "plugin"`, `requirePluginTool`, `toolAllowedFor`.
- `agent-access/v3/tools/index.ts` dispatcher calls `requirePluginTool` before scope check, parse, broker.
- `agent-access/v3/server.ts` `tools/list` filtered to the approved tools.
- `agent-access/v3/auth.ts` `zp_` branch (optional `plugins` dep; absent = `plugin_unavailable` 503, never another verifier); `auth-default.ts` wires the real service.
- `agent-access/control/boundary.ts` v2 endpoint refuses `zp_` explicitly; `control/browser.ts` exports `browser()`.
- `agent-access/security.ts`, `capabilities/secret-guard.ts` redact `zp_` tokens.
- `controlplane/db/migrations/index.ts`, `repos/index.ts` registration.

## 2. Acceptance mapping

Acceptance: "Plugin capability declarations/provenance/schemas/isolation/revocation; no token passthrough or direct credential/store access."

- Capability declarations + schemas: `PluginManifest` (strict; unknown member, unknown tool, tool whose scope is not requested, missing read, duplicate entries all refused). Tests: `manifest.test.ts` "plugin manifest schema".
- Provenance: Ed25519 over `zenith-plugin-manifest-v1\n` + canonical digest of the manifest minus signature, key must belong to the declared publisher in the deployment trust config; no trust config means every registration is refused. Verified at registration (`registerPlugin`) and the stored manifest is re-hashed at review, issue and every authentication. Tests: `manifest.test.ts` "plugin provenance" (tamper, wrong key, wrong publisher, no publishers, bad config); `service.test.ts` registration cases and "altered at rest".
- Per-tenant review/approval: `platform.plugin_registrations` is workspace scoped; admin approves the exact `manifestDigest` and a subset of tools/scopes (`review`); rejected/revoked terminal; audit rows in `plugin_events`. Tests: `service.test.ts` "approval binds the exact digest...", "tenant scoped".
- Isolation: manifest `isolation` accepts only literals (`credentials: none`, `store: none`, `network: mcp-only`, `tokenPassthrough: forbidden`); the only interface is the MCP tool catalog, so the plugin has no path to credential or product stores; the token is accepted only by MCP v3 (v2 explicitly refuses it, other routes never accept `zp_`). Tests: manifest refusals for credential/store/passthrough/network requests; `mcp-boundary.test.ts` "refused everywhere else".
- Enforcement in MCP layer through the broker: dispatcher `requirePluginTool` + `tools/list` filtering + scope attenuation; calls run as the parent integration principal (named `plugin <id>@<ver> via integration <id>`) through the unchanged broker/grant/policy path. Tests: `mcp-boundary.test.ts` (approved tool runs via `authorizeRead` as parent principal; unapproved tool, including a tool the parent holds, is `plugin_capability_denied` before the broker; execute tool denied).
- Revocation immediately invalidates grants: `revoke` marks registration revoked and all grants in one transaction; authentication joins registration status + grant + live parent each request (no cache). Tests: `service.test.ts` "revocation" (2 grants, terminal, idempotent, parent untouched, audit order), "MCP authentication path" next-request refusal, `mcp-boundary.test.ts` mid-session revocation.
- No token passthrough: tokens are minted by Zenith (`zp_` + 32 random bytes), SHA-256 only at rest, bound to the exact `<origin>/api/agent/v3/mcp` audience (a different resource is refused), attenuate the parent credential (can never exceed it; follow it live when it narrows/expires/revokes), never the parent secret or an OAuth token; a `zp_` bearer never reaches the credential authority or OAuth verifier (tests throw if it does); no bearer enters the tool layer; `zp_` is scrubbed from responses. Tests: `service.test.ts` "opaque audience-bound token, stores only its hash", "audience binding", `mcp-boundary.test.ts` "never forwards a bearer", scrubber test.

## 3. Verification (other machine)

```
npx vitest run tests/plugins
npx vitest run tests/agent-v3 tests/agent-control-oauth.test.ts tests/capabilities
npx vitest run tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts tests/docs
ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/plugins/service.test.ts   # real Postgres lane
```
Expected: all pass. `tests/plugins` uses PGlite by default (no env vars). The Ed25519 keys are generated at runtime.

## 4. Known gaps / shared-file updates

- No UI. The management surface is the browser-session JSON API (`/api/integrations/plugins*`); the Integrations screen does not yet list plugins, show the manifest/provenance, or call these routes. The token response is the only place a `zp_` token is ever shown.
- Parent credential must be a linked `za_` credential (Postgres authority). OAuth-grant parents are not supported for plugin tokens (refused: the lookup uses `listCredentials`).
- Provenance trust is deployment config (`ZENITH_PLUGIN_TRUSTED_PUBLISHERS`: `{ "<publisher>": [{ "keyId", "publicKey": "<base64 raw ed25519>" }] }`). There is no transparency log, no key rotation workflow beyond listing several keys, and the `artifact.digest` is recorded and signed but Zenith does not fetch or hash the artifact itself (the separate plugin repo's provenance work is what binds the artifact bytes to that digest).
- Isolation is enforced at the API boundary (what a token can reach), not by a sandbox around the plugin process; the plugin repo/host owns process isolation.
- The v1/v2 endpoints and other routes do not accept `zp_`; only v2 has an explicit refusal, the others fail as an unrecognized credential.
- Test expectations I could not confirm without running: `mcp-boundary.test.ts` relies on the agent-v3 harness (`authorizeRead` principal argument position 1; JSON-RPC error shape for an unregistered tool). If the HTTP "unapproved tool" case shape differs, the dispatcher-level assertions in the same test are the load-bearing ones.
- Tests were not run (build-only rule). `tsc --noEmit` and eslint on all changed files are clean.

Shared-file updates for the orchestrator
- Migration inventory: new version 28 `plugin_boundaries` (tables `plugin_registrations`, `plugin_grants`, `plugin_events`); versions 21-27 are assigned elsewhere, so the contiguity test only passes after assembly. `emit.ts` hardening grants (service_role only; `plugin_events` select/insert only; anon/authenticated revoked, RLS enabled, same as `optimizer_settings`) are already in the migration SQL; regenerate `supabase/migrations`, DEPLOYING.md inventory and `tests/controlplane/migrations.test.ts` table list.
- Tenancy classification (`tests/controlplane/tenancy.test.ts`, `tests/security/controlplane-sql-scoping.test.ts`) for `repos/plugins.ts`: tenant scoped by `workspace_id` in SQL: `register, get, list, review, revoke, createGrant, listGrants, revokeGrant, touchGrant, listEvents`. Token-keyed (workspace derived from the row, caller binds it): `resolveGrantByTokenHash`, `diagnoseTokenHash` (256-bit token hash is the key; never called with a caller-supplied id). Tables are workspace owned by `workspace_id` text column (no FK to workspaces, same as `optimizer_settings`).
- No workflow, gate manifest or workflow wiring needed. New env var documented above (`ZENITH_PLUGIN_TRUSTED_PUBLISHERS`).
- LIMITATIONS: add the "no UI", "linked-credential parents only", "no artifact fetch/hash, no process sandbox" items above.

## 5. Suggested ledger implementationStatus

"implemented_unverified: signed manifest schema, provenance verification, per-workspace review, audience-bound revocable plugin tokens, MCP v3 enforcement; awaiting test run; no UI, linked-credential parents only"

## 6. Addendum: UI, real plugin check, artifact digest

UI: `/platform/plugins` (`src/app/(product)/platform/plugins/{page,plugins-manager}.tsx`, nav link in `platform/layout.tsx`, shared projections in `src/lib/plugins/view.ts`). Lists plugins (admins see all, members see approved), manifest detail (publisher and verified key, manifest digest, archive sha256, requested scopes, declared tools, skills, subagents, MCP servers), approve a subset (tool and scope checkboxes, `read` locked, nothing-selected blocked), reject, revoke (reason plus second confirmation), token list with revoke, token issue (token shown once in a read-only field). Fieldsets/groups carry aria labels, status messages use `role="status"`, disabled buttons give reasons. Test: `tests/platform-ui/plugins.test.tsx` (jsdom, fake HTTP). Run: `npx vitest run tests/platform-ui/plugins.test.tsx`.

Real plugin check (`Z:\Projects\Spawned.ai\Zenith-plugins`, `plugins/claude-code`): the plugin is `plugin.json` (name `zenith`, version), 12 skills, 2 read-only subagents (`zenith-inspector`, `zenith-release-reviewer`, tools Read/Glob/Grep) and one stdio MCP server (`node ${CLAUDE_PLUGIN_ROOT}/runtime/bridge/cli.mjs stdio`, env `ZENITH_API_VERSION`). The schema could not describe those, so it now has an optional signed `components` block (skills, agents, mcpServers; env keys that look like credentials are refused, command must be a bare executable name) and `artifact.format`. Also `capabilities.apiVersion` is required and must be `"v3"`.
Important gap: the bridge shipped there speaks MCP v2 (`ZENITH_API_VERSION=2`, tools like `zenith_prepare_change`, token from `ZENITH_TOKEN`/`zenith login`). Plugin tokens are accepted only by v3, so that plugin can be registered and reviewed but cannot use a plugin token until its bridge targets v3. The sample below is for that v3 build.

Sample manifest (signature and archive digest are produced by the release operator; the values shown are placeholders, not real):

```json
{
  "schemaVersion": 1,
  "id": "godostroyer/zenith",
  "name": "Zenith for Claude Code",
  "description": "Inspect, architect and deploy through browser-reviewed Zenith changes.",
  "version": "0.3.0",
  "publisher": { "id": "godostroyer", "name": "GODOSTROYER" },
  "artifact": { "digest": "sha256:<64 hex: sha256 of the published plugin archive>", "format": "tar.gz", "url": "https://<release host>/zenith-claude-code-0.3.0.tar.gz" },
  "capabilities": {
    "apiVersion": "v3",
    "tools": ["zenith_get_topology", "zenith_get_capabilities", "zenith_plan_change", "zenith_prepare_deploy", "zenith_execute_approved_operation",
              "zenith_query_logs", "zenith_investigate_incident", "zenith_compare_revisions", "zenith_estimate_cost", "zenith_get_operation", "zenith_get_operation_events"],
    "scopes": ["read", "plan", "write", "logs"]
  },
  "components": {
    "skills": ["connect", "deploy", "edit", "export", "incident", "inspect", "link", "observe", "plan", "promote", "publish", "rollback"],
    "agents": [{ "name": "zenith-inspector", "tools": ["Read", "Glob", "Grep"] }, { "name": "zenith-release-reviewer", "tools": ["Read", "Glob", "Grep"] }],
    "mcpServers": [{ "name": "zenith", "transport": "stdio", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/runtime/bridge/cli.mjs", "stdio"], "env": { "ZENITH_API_VERSION": "3" } }]
  },
  "isolation": { "credentials": "none", "store": "none", "network": "mcp-only", "tokenPassthrough": "forbidden" },
  "signature": { "alg": "ed25519", "keyId": "<trusted key id>", "value": "<base64 ed25519 over zenith-plugin-manifest-v1\n + manifest digest>" }
}
```

Artifact digest: `artifact.digest` is the sha256 of the published plugin archive and is covered by the signature (the manifest digest includes it, so changing it invalidates the signature). Zenith does not fetch or hash the archive. The client or installer MUST download the archive, compute its sha256 and compare it to the reviewed `artifact.digest` (shown on the review page as "Archive sha256") before installing, and refuse on mismatch. The plugin repo's trusted launcher/provenance gate is the place that check belongs.
