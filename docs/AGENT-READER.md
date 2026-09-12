# Agent reader — development companion

This is the server-side counterpart of [Zenith-plugins PR #1](https://github.com/GODOSTROYER/Zenith-plugins/pull/1). It adds an opt-in, **read-only** endpoint on the inspected base `70d9c4a610b96f3d45bed0d85bd4155bbbf295f7`. It is not a completed remote MCP service, deployment integration or production release.

## Ownership and request flow

`src/lib/agent-access/security.ts` owns opaque reader-credential validation, private authority-file reads, explicit request selection and conservative redaction. `http.ts` owns the bounded stateless JSON-response protocol profile, credential scope filtering and metadata-only request diagnostics. `zenith-reader.ts` supplies the curated application reads using the existing store, permissions, action plans and provider adapters.

The exact `/api/agent/v1/mcp` route does not use the browser/demo `route()` identity wrapper. Middleware exempts only this exact path after the hosted-host rewrite. The endpoint imposes its own fail-closed credential and scope checks; browser cookies do not grant reader access. Other routes retain their existing authentication behavior.

The distribution process never opens Zenith storage. File-backed reads claim the existing application's data directory; Postgres reads use a request snapshot. Full application integration remains an acceptance gate, not a result inferred from these lower-level tests.

## Run on loopback only

An operator must configure all three variables:

```bash
export ZENITH_AGENT_READER=1
export ZENITH_AGENT_ORIGIN=http://127.0.0.1:3400
export ZENITH_AGENT_CREDENTIAL_FILE="$HOME/.config/zenith-reader/access.credentials.json"
npm run dev -- --hostname 127.0.0.1
```

The endpoint is otherwise disabled and also refuses on Vercel. **Host/Origin validation is not network isolation.** Bind the listener to loopback; do not expose this service through a public listener, proxy or tunnel. Remote OAuth is not implemented, and opaque operator tokens are not a substitute for OAuth compliance.

## Issue and revoke a credential

Use an owned private directory with mode 0700, outside the checkout. The operator utility writes mode-0600 files and never prints the token. Issuance does not create a user or membership: supply an actual non-demo user ID and authorized record IDs.

```bash
mkdir -p "$HOME/.config/zenith-reader"
chmod 700 "$HOME/.config/zenith-reader"
node scripts/agent-credential.mjs issue \
  --file "$HOME/.config/zenith-reader/access.credentials.json" \
  --subject USER_ID --workspace WORKSPACE_ID --projects PROJECT_ID \
  --token-out "$HOME/.config/zenith-reader/client.token"
```

The default is `read` scope and one day. Optional `--scopes read,plan,export`, `--environments ENVIRONMENT_ID`, and `--days 1` narrow or extend the explicitly issued permission set. Maximum lifetime is 30 days; the authority file permits at most 100 records. Store the printed credential identifier for revocation:

```bash
node scripts/agent-credential.mjs revoke \
  --file "$HOME/.config/zenith-reader/access.credentials.json" \
  --id CREDENTIAL_ID
```

The authority file stores token hashes and is reread on subsequent requests. Revocation does not recall data already read or guarantee cancellation of an in-flight read. Windows authority support is deliberately refused pending ACL validation. A stale utility lock requires operator investigation, not blind removal.

## Capability boundaries

The curated surface covers context/capabilities, projects/environments, redacted manifests, deployment metadata/non-log events, stored findings, provider drift, read-only deployment previews and redacted exports. Optional plan/export scopes are checked again on every call. Records are scoped to the credential and explicit selection, not to a browser's current workspace.

The deployment preview goes through `runAction` in **plan** mode and returns `executable: false` and `receipt: null`. No action execute path, trusted approval, write operation, rollback, upload, hosted publishing, membership change or raw secret API is exposed. Public/remote authentication remains unavailable.

Redaction removes common sensitive fields and patterns; it is not a universal detector for secrets in arbitrary prose. Free-form deployment log events are excluded. Exported definitions are redacted and need missing values supplied separately. Preserve provider simulation/estimate labels and refusal reasons.

## Verification evidence — September 12, 2026

```bash
node scripts/test-agent-reader.mjs
```

**14 passed, 0 failed, 0 skipped** on Linux / Node 22.16.0. The script strictly compiles `security.ts` and `http.ts`, then tests credentials, expiry/revocation, scope-header narrowing, private files, redaction, catalog filtering, write refusal, origin/disabled-state checks, body bounds and unsupported methods. It uses private temporary files and an injected application-scope fixture.

This does **not** compile or exercise `zenith-reader.ts`, the Next.js route, middleware integration, file/Postgres adapters, provider calls or the operator utility end to end. The full Zenith typecheck/lint/test/build and native-client journeys have not run here. The local test run used preinstalled compiler/type definitions because shell registry access was unavailable. Do not treat 14 isolated tests as application acceptance.

## Required before release

Review the middleware exception and module initialization; centralize validated configuration; add body-read deadlines and production-quality rate controls; verify environment-scoped findings and all cross-tenant lookups against real stores; test operator issuance races and directory protection; review arbitrary text/export redaction; replace the handwritten protocol profile with a maintained SDK and add remote OAuth; implement authoritative durable receipts, approvals, idempotency and operations before adding writes.

No automatic merge, package publication, public exposure or production deployment is authorized by this draft.
