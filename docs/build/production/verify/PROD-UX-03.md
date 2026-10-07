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

## J9 reference launcher, 8 October 2026

This addendum supersedes the earlier missing artifact/process-isolation notes
for the new reference launcher. Historical server evidence above remains
historical. No acceptance state has been promoted to verified. Base is
`3a9de905`; all changes are uncommitted in `prod6-j9-plugin-launcher`.

### Files and behavior

- `src/cli/plugins/{authority,launcher,runtime,main,bin}.ts`: executable entry,
  exact reviewed manifest digest and existing Ed25519 publisher verification,
  bounded unauthenticated HTTPS download and SHA-256 pin, strict dedicated
  child-credential authority contract, revocation supervision, owned Docker
  container/volume lifecycle and fail-closed cleanup. Disabled TLS verification
  is refused; optional CA files must contain only valid public certificates.
- `deploy/plugin-sandbox/{runner,gateway,transport}.mjs`: Node22-only process
  entry, bounded strict ustar extraction inside the container, API-only Unix
  socket gateway and fetch adapter. `README.md` documents supported formats,
  fixed limits and runtime behavior.
- `tests/cli/{plugin-launcher,plugin-sandbox,plugin-runtime}.test.ts` and
  `tests/plugins/launcher-support.ts`: signature, digest, review and credential
  refusals; modeled daemon order/rollback/removal; cancellation, revocation,
  outage and narrowing; archive traversal/link/device/duplicate/checksum
  refusals; real local HTTP listener with explicitly modeled upstream; socket
  fetch routing and credential-header removal. Fake secrets and Ed25519 keys
  are generated at runtime.
- `tests/cli/plugin-launcher-docker.test.ts`: three gated actual Docker controls
  for revoke, authority outage and cancellation. The HTTPS authority/MCP
  fixture is modeled and labeled; Docker isolation and cgroup removal are real.
  It checks uid, effective capabilities, no-new-privileges, root/payload writes,
  Docker/host-store absence, denied direct API/metadata TCP connectivity,
  approved MCP socket reachability, environment allowlist, Docker configuration,
  no token in Docker env, and removal of both containers and the tmpfs volume.
  The process forks a TERM-resistant child before revocation.
- This verify document, `PROD-UX-03-commands.md` (every local shell batch and
  outcome), and the UX-03 ledger row. No other ledger row, migration,
  aggregate snapshot, package, installer, execution guard or Wave-5 file changed.

### Acceptance mapping

| Clause | Implementation and evidence |
| --- | --- |
| Capability declarations / schemas | Reuse `parseManifest`; select only a signed Node stdio entry. `assertLease` limits tools/scopes to the signed capabilities and exact workspace/project/environment identifiers. Gateway limits RPC methods, tools, routes and targets. `plugin-launcher.test.ts`, `plugin-sandbox.test.ts`, existing `manifest.test.ts`. |
| Provenance / artifact integrity | Reuse real Ed25519 verification against configured publishers; compare the exact reviewed canonical digest; signed HTTPS URL, redirect refusal, bounded body and raw-byte SHA-256. Container runner rehashes the mounted archive before extraction. Unsigned, tampered, untrusted or mismatched artifacts cannot start. Contract tests plus actual downloaded Docker fixture archive. |
| Process isolation | Network mode `none`, non-root 65532, read-only rootfs/public payload bind, all capabilities dropped, no-new-privileges, no daemon socket or host stores, fixed pids/CPU/memory/tmpfs. A trusted sidecar supplies only Zenith MCP through a shared Unix socket. Contract flags are tested here; actual kernel/engine controls require the gated Docker spec. |
| Scoped credential / no token passthrough | Only a fresh dedicated `za_` child arrives through stdin and anonymous Docker attach pipes; no saved login, inherited credential env, argv secret, credential files or logs. The child receives only that token; the gateway constructs upstream auth and strips caller headers. `LaunchLease` binds its hash, review, registration, workspace, MCP audience, finite projects/environments, tools/scopes and expiry. The real platform issuance/auth/revocation join is **absent and required**, as detailed below. Ordinary parent `za_` and `zp_` grants are refused. |
| Revocation | Host and gateway perform live checks every second; the gateway also checks before each MCP call. Any revoke/expiry/review change/narrowing/outage or failed gateway stops the process and all descendants with `docker rm --force`, followed by owned volume removal. Normal exit also cleans resources. Cleanup failure is a failure, retains scratch and never becomes a pass. Contract tests here; actual Docker controls gated. In-flight accepted platform operations are not rolled back. |
| No direct credential/store access | Only read-only public scratch and the Unix socket volume are mounted. Socket HTTP rejects credential/store paths, other methods, bearer/cookie headers, unapproved tools, foreign scope, batches and redirects. The API and broker still own authorization, policy, approvals and execution. No direct cloud calls are added. |

### Required integration joins and limitations

1. The integrator must add `plugin` dispatch and help to `src/cli/main.ts`,
   forwarding the complete argv and runtime to `runPluginCli`. That file is
   outside J9 ownership. The direct executable is already reachable:
   `npx --no-install tsx src/cli/plugins/bin.ts plugin run ...`.
2. Add the authoritative `POST /api/integrations/plugins/launch/check` join.
   Request: dedicated scoped child `Authorization: Bearer za_...`, JSON
   `LaunchBinding` (`registrationId`, `workspaceId`, `manifestDigest`,
   `credentialDigest`, exact HTTPS MCP `audience`). Response is exactly the
   strict `LaunchLease` schema in `authority.ts`: `status: active`,
   `credentialKind: plugin_scoped_za`, all request bindings, nonempty finite
   `projectIds` / `environmentIds`, approved `tools` / `scopes`, and `expiresAt`
   no more than 24 hours ahead. Any error, absent endpoint, invalid body,
   mismatch, expiry, permission change or unavailable authority refuses launch
   or stops the current run. No other endpoint or credential verifier is tried.
3. The platform owner must implement browser-human issuance of a fresh dedicated
   `za_` child, bound to the exact approved registration/digest and attenuated
   to both review and live parent scopes/targets. Ordinary `za_` records cannot
   self-assert `plugin_scoped_za`. It must authenticate only for its MCP audience
   and approved tools, reuse existing principal/broker guards, and reject direct
   credential/store/other API access. The check must read live review, grant,
   child and parent authority, membership and expiry every time. Plugin/grant/
   parent revocation must invalidate this child; the existing browser revoke
   transaction must include dedicated launcher children. No bearer-only consent
   or approval minting is permitted. Existing server `zp_` issuance cannot meet
   J9's expressly required `za_` contract and is not silently substituted.
4. The check endpoint/child issuance are absent at this base. Production launch
   therefore explicitly refuses `launch_authority_unavailable` before artifact
   fetch or resource creation. The modeled authority used in contract and Docker
   fixture tests is **not** operated platform authority evidence. Full UX-03
   implementation requires these joins; pending ledger wording does not close
   that gap. No new table, store function, migration, sensitive-data inventory,
   workflow or execution gate is introduced by this worktree. The join owner
   must inventory any persistence it adds and preserve all existing guard order.
5. Only gzip ustar regular files/directories, one signed Node22 stdio entry and
   MCP v3 JSON calls are supported. ZIP, tar links/PAX/GNU extensions, other
   executables, credential env, loaders and v2 configuration are explicitly
   refused. Plugin stdout/stderr are suppressed. This reference supervisor does
   not expose a host stdio MCP bridge or claim Claude Code/Codex interoperability.
   Native fetch clients use the trusted socket adapter; other clients need
   explicit Unix-socket support. The separate legacy v2 plugin is not claimed
   compatible. Fixed 128 MiB per-container memory includes the 64 MiB work
   tmpfs; large packages may exceed runtime limits and fail.
6. Revocation detection is bounded by the one-second poll plus the three-second
   authority timeout, followed by Docker removal (15-second command deadlines).
   It is not instantaneous and cannot undo already dispatched platform effects.
   Gateway-side checks block new requests when authority is lost. Docker engine
   outage can prevent physical termination; cleanup errors are surfaced and
   owned resource labels/scratch remain available for operator repair.

### Mac verifier: lean actual Docker specification

Run serially, with Node22.23.3, native ARM64 Linux Docker, Docker Desktop at
4 GiB, and the program's 22 GiB free-disk floor. No Postgres, Temporal, kind or
default stack is needed for this **runtime-only** specification. Two containers
use 256 MiB memory and 0.5 CPU combined; no application dependencies are installed
inside them. The modeled HTTPS fixture binds an ephemeral local host port and
is reachable through Docker Desktop's `host.docker.internal`. No cloud API is
contacted. Missing fixture inputs fail when the gate is enabled.

```bash
# Use the verifier's existing Node22 installation before these commands.
test "$(node --version)" = v22.23.3
docker info --format '{{.OSType}}'                  # expected linux
df -k .                                          # enforce the 22 GiB floor
docker pull --platform linux/arm64 node:22.23.3-bookworm-slim
export ZENITH_PLUGIN_SANDBOX_IMAGE="$(docker image inspect node:22.23.3-bookworm-slim --format '{{index .RepoDigests 0}}')"
docker image inspect "$ZENITH_PLUGIN_SANDBOX_IMAGE" --format '{{.Architecture}}'  # arm64
tls_dir="$(mktemp -d /tmp/zenith-plugin-tls.XXXXXX)"
chmod 700 "$tls_dir"
cat > "$tls_dir/openssl.cnf" <<'EOF'
[req]
prompt = no
distinguished_name = dn
x509_extensions = v3
[dn]
CN = host.docker.internal
[v3]
subjectAltName = DNS:host.docker.internal,IP:127.0.0.1
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$tls_dir/openssl.cnf" \
  -keyout "$tls_dir/server.key" -out "$tls_dir/server.crt"
chmod 600 "$tls_dir/server.key"
export ZENITH_PLUGIN_TEST_TLS_CERT_FILE="$tls_dir/server.crt"
export ZENITH_PLUGIN_TEST_TLS_KEY_FILE="$tls_dir/server.key"
ZENITH_TEST_PLUGIN_DOCKER=1 npx vitest run tests/cli/plugin-launcher-docker.test.ts --no-file-parallelism --maxWorkers=2
# Expected 3 passed / 0 failed / 0 skipped. Each test removes only its owned
# containers and volume. No global prune. Retain failure receipts and inspect
# only affected zenith.plugin.launch labels if engine cleanup fails.
rm -f "$tls_dir/server.key" "$tls_dir/server.crt" "$tls_dir/openssl.cnf"
rmdir "$tls_dir"
unset ZENITH_PLUGIN_TEST_TLS_CERT_FILE ZENITH_PLUGIN_TEST_TLS_KEY_FILE
```

The actual runtime spec is not runnable here (needs Docker and generated TLS
files). It is not a default-platform or real grant-issuance pass.

### Mac verifier: operated default-platform successor after joins

Start J1's lean private-CA default stack using its owned startup instructions.
Do not duplicate installer/Postgres/Temporal configuration here. Configure the
same publisher trust in the API and launcher. In a signed-in workspace browser,
register/review the exact v3 manifest and approve only the required tools. Issue
a dedicated short-lived launcher `za_` child with one explicit project and
environment using the integration described above. Use a signed long-lived
plugin artifact served over HTTPS, a pinned local Node22 image, and an API origin
reachable from both host and gateway. Parent tokens are not valid substitutes.

```bash
export NODE_EXTRA_CA_CERTS="$ZENITH_DEFAULT_STACK_CA_FILE"
# ZENITH_PLUGIN_TRUSTED_PUBLISHERS contains public deployment trust JSON.
# PRIVATE_LAUNCH_TOKEN_FILE is owner-only, contains the freshly issued CHILD,
# and is created locally by browser consent; never place it in argv or logs.
cat "$PRIVATE_LAUNCH_TOKEN_FILE" | npx --no-install tsx src/cli/plugins/bin.ts plugin run \
  --manifest "$PLUGIN_MANIFEST_FILE" --digest "$REVIEWED_MANIFEST_DIGEST" \
  --registration "$PLUGIN_REGISTRATION_ID" --workspace "$WORKSPACE_ID" \
  --url "$ZENITH_DEFAULT_STACK_HTTPS_ORIGIN" --image "$ZENITH_PLUGIN_SANDBOX_IMAGE" \
  --server zenith --ca-file "$ZENITH_DEFAULT_STACK_CA_FILE"
# In the browser, revoke that plugin while it is running.
# Expected nonzero launcher exit; no owned containers/volume; next MCP request
# denied. Retain sanitized authority/revocation audit and actual Docker receipt.
# Repeat separately for child revocation, parent revocation/expiry, narrowing,
# and authority outage; each must stop and deny new requests.
```

Also confirm ordinary parent `za_`, the existing `zp_` grant, unsigned manifest,
wrong reviewed digest and altered archive each refuse without an executable
container. Inspect `/platform/plugins` approval/revocation with the Mac browser
verifier. Required native default-stack/browser checks are **not run (needs J1,
the scoped child/authority joins, Mac Docker and browser)**. Report actual
runtime fixture evidence separately from operated browser/authority evidence.

### Local command outcomes

Every PowerShell shell invocation prepended
`$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH`.
`node --version` returned `v22.23.3`. Counts below overlap; do not sum attempts.

| Exact verification command | Outcome |
| --- | --- |
| `npx vitest run tests/cli/plugin-launcher.test.ts tests/cli/plugin-sandbox.test.ts tests/cli/plugin-launcher-docker.test.ts --no-file-parallelism --maxWorkers=2` (attempt 1) | exit 1; 21 tests passed, 0 assertion failures, 2 suites failed to transform, 0 skips. Fixed an unterminated template literal in new `runtime.ts`; no assertions changed. |
| Same exact command (attempt 2) | exit 0; 52 passed / 0 failed / 3 skipped; 2 suites passed / 1 Docker suite skipped. |
| `npx vitest run tests/cli/plugin-launcher.test.ts tests/cli/plugin-sandbox.test.ts tests/cli/plugin-runtime.test.ts tests/cli/plugin-launcher-docker.test.ts tests/plugins/manifest.test.ts --no-file-parallelism --maxWorkers=2` | exit 0; 82 passed / 0 failed / 3 skipped; 4 suites passed / 1 Docker suite skipped. |
| `npx eslint src/cli/plugins/authority.ts src/cli/plugins/launcher.ts src/cli/plugins/runtime.ts src/cli/plugins/main.ts src/cli/plugins/bin.ts deploy/plugin-sandbox/gateway.mjs deploy/plugin-sandbox/runner.mjs deploy/plugin-sandbox/transport.mjs tests/cli/plugin-launcher.test.ts tests/cli/plugin-sandbox.test.ts tests/cli/plugin-runtime.test.ts tests/cli/plugin-launcher-docker.test.ts tests/plugins/launcher-support.ts` | exit 0; 13 code files checked, 0 errors / 0 warnings. |
| `npx vitest run tests/cli/plugin-launcher.test.ts tests/cli/plugin-sandbox.test.ts tests/cli/plugin-runtime.test.ts tests/cli/plugin-launcher-docker.test.ts tests/plugins/manifest.test.ts --no-file-parallelism --maxWorkers=2` (after TLS/CA boundary fixes) | exit 0; 84 passed / 0 failed / 3 skipped; 4 suites passed / 1 Docker suite skipped. |
| `npx eslint src/cli/plugins/launcher.ts deploy/plugin-sandbox/gateway.mjs deploy/plugin-sandbox/runner.mjs tests/cli/plugin-launcher.test.ts` | exit 0; 4 files checked, 0 errors / 0 warnings. |
| `npx tsc --noEmit -p .` (attempt 1) | exit 1; 2 new fixture diagnostics: generic Node Buffer not assignable to DOM Response BodyInit. Fixed by copying bytes into Uint8Array; no assertion changed. |
| `npx --no-install tsx src/cli/plugins/bin.ts --help` | exit 0; executable help 1 passed / 0 failed / 0 skipped. |
| `git diff --check` | exit 0; whitespace check 1 passed / 0 failed / 0 skipped. |
| Ledger JSON/HEAD comparison, exact PowerShell in command journal V7 | exit 0; scope check 1 passed / 0 failed / 0 skipped, only UX-03 changed; state remains in_progress. |
| `npx eslint tests/cli/plugin-launcher.test.ts` (after Buffer conversion) | exit 0; 1 file checked, 0 errors / 0 warnings. |
| `npx vitest run tests/cli/plugin-launcher.test.ts --no-file-parallelism --maxWorkers=2` (after Buffer conversion) | exit 0; 33 passed / 0 failed / 0 skipped; 1 suite passed. |
| Full ledger/HEAD and allowed-file comparison, exact PowerShell in command journal V12 | exit 0; 2 scope checks passed / 0 failed / 0 skipped, 17 changed/added files; all other ledger content and release flags unchanged. |
| `npx tsc --noEmit -p .` (attempt 2, after fixes) | exit 0; 1 typecheck passed / 0 failed / 0 skipped, 0 diagnostics. Final source, including TLS/CA changes and all new tests, typechecks. |

Exact inspection/check commands, including the failed initial
transform and typecheck attempts, are in [the command journal](PROD-UX-03-commands.md).
No Docker, real PostgreSQL, Temporal, kind, browser or live cloud
acceptance was run here. No npm install/ci, package edit or git mutation was run.

Suggested ledger status: `implementation_complete_verification_pending`, with
the scoped child/authority and main CLI join caveats retained. Suggested commit:
`feat(plugins): add digest-pinned container launcher and revocation supervision`.

Final handoff: 17 files changed/added, all uncommitted; no existing test
expectation, assertion or gate changed. No handoff override was violated.
The authority and main CLI joins are explicitly deferred to their owners under
the handoff's interface/join allowance. Actual Docker and operated acceptance
remain unverified; three runtime cases are gated and skipped locally.
