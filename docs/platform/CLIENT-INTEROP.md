# Coding-agent client interoperability (MCP v3, OAuth, streaming)

What a coding-agent client (Claude Code, Codex, an SDK, `curl`) can rely on when
it connects to `POST/GET/DELETE <origin>/api/agent/v3/mcp`, and how to prove it
on your own machine. Requirement: PROD-UX-02.

Zenith is an OAuth **resource server**. Login, third-party-client consent
screens, PKCE and token minting belong to the external authorization server you
configure with `ZENITH_AGENT_OAUTH_ISSUER` / `ZENITH_AGENT_OAUTH_JWKS`. Zenith
also issues its own bearers (linked `za_` credentials from `zenith login`,
reviewed `zp_` plugin tokens). All three are checked live on every request.

## 1. Discovery (RFC 9728) and the issuer (RFC 8414)

| Step | What the client sees | Exactness |
|---|---|---|
| unauthenticated request | `401`, `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/agent/v3/mcp", scope="zenith:read"` | the URL is built from the configured origin, never from request headers |
| `GET` that URL (anonymous) | `{ resource, authorization_servers, scopes_supported, bearer_methods_supported: ["header"] }` | `resource` is exactly `<origin>/api/agent/v3/mcp`; `authorization_servers` is exactly `[ZENITH_AGENT_OAUTH_ISSUER]`; the JWKS URL is never published |
| the issuer's own metadata | RFC 8414 / OpenID Connect discovery at the issuer | Zenith does not host it; `npm run doctor` and the conformance harness fetch it and require `issuer` to be **identical** to the configured issuer, S256 PKCE, https endpoints and a matching `jwks_uri` |

Audience: an OAuth access token is accepted only if `aud` is the exact resource
of the endpoint it is presented to (`/api/agent/v3/mcp` for v3, `/api/agent/v2/mcp`
for v2), `iss` is the exact issuer, the signature verifies against the configured
JWKS, lifetime is at most one hour, and the user has a live Zenith **grant** for
that client in the selected workspace. A token for another resource is `401
invalid_token`. A `zp_` plugin token is bound to its audience at issue time
(UX-03) and is refused at any other endpoint; that binding is unchanged.

## 2. Consent: exact scopes

Authorizing a client happens in two places, and each shows exact scopes:

- the issuer's own consent page (not Zenith's), which sees the scopes Zenith
  advertises in `scopes_supported`: `zenith:read zenith:plan zenith:export
  zenith:write zenith:publish zenith:logs`;
- Zenith > Integrations > *Connect an OAuth client* (and `/agent/link` for
  linked credentials). The OAuth screen shows, before the button, a restatement
  served by the API (`consent` in `GET /api/integrations/agent`): the client id,
  the issuer, the resources the tokens are accepted at, the **literal scope
  strings** that will be granted, the projects and the expiry. Token scopes and
  the Zenith grant are **intersected**: a scope must be in both.

| Scope | OAuth string | Unlocks |
|---|---|---|
| read | `zenith:read` | read tools (topology, capabilities, operations, estimates, placement) |
| plan | `zenith:plan` | proposals that never execute |
| export | `zenith:export` | configuration export |
| write | `zenith:write` | executing an operation a person already approved |
| publish | `zenith:publish` | app release (also needs an explicit owner grant) |
| logs | `zenith:logs` | redacted logs and metrics, incident investigation |

(`scopeCatalog()` in `src/lib/agent-access/scope-catalog.ts` is the source; a
test proves the tool lists partition the catalog.)

## 3. Protocol versions

Pinned in `src/lib/agent-access/v3/protocol.ts`, independent of the SDK:

- served: `2026-07-28` (stateless per-request envelope), `2025-11-25`,
  `2025-06-18`, `2025-03-26`;
- refused explicitly: `2024-11-05`, `2024-10-07` (HTTP+SSE era), malformed and
  unknown older versions: HTTP `400`, JSON-RPC `-32602` "Unsupported protocol
  version", `data: { requested, supported: [...] }`;
- an `MCP-Protocol-Version` header that is not served is refused the same way,
  on every method including a `Last-Event-ID` resume;
- `initialize` with a well-formed **newer** unknown version is counter-offered
  the newest legacy version Zenith serves (the MCP lifecycle rule); the client
  decides whether to continue.

## 4. Replies: JSON by default, SSE when the client asks for progress

- Default: one bounded JSON reply, stateless, no `Mcp-Session-Id`. This is what
  the Zenith plugin and most clients use.
- A `tools/call` that sends `_meta.progressToken` **and** accepts
  `text/event-stream` is streamed: `notifications/progress` while it runs, then
  the result. Execution of an approved operation reports `claiming the approved
  operation` and `starting the workflow`.
- If durable streams are unavailable the server answers bounded JSON instead of
  a stream it could not resume.

### Reconnect and resume

Every event of a streamed call is stored (`platform.mcp_stream_events`) before
it is written, with the id `<streamId>.<seq>`. Clients on `2025-11-25` also get
an empty priming event so the first resumable id exists before any progress;
older clients get ids from their first event.

```
GET /api/agent/v3/mcp
Accept: text/event-stream
Last-Event-ID: <id>
Authorization: Bearer <same token>
```

replays everything after `<id>` and, while the call is still running, follows
it until the result, then ends the stream (a connection follows for up to 40 s;
reconnect with the newest id). A **dropped connection is not a cancellation**
(MCP spec): the call finishes and its result is waiting. Streams are bound to
the principal (workspace + subject + credential + plugin grant). Another
principal, another workspace, an expired stream (15 min) and a made-up id are the
same `404 stream_not_found`; a revoked token is `401`/`403` first.

`2026-07-28` requests have no resumable ids: reconnect by repeating the request
with the **same idempotency key** (every write tool requires one), exactly as the
protocol intends. A modern call that sends a progressToken may stream.

## 5. Cancellation, honoured through to the broker

`notifications/cancelled { requestId }` answers `202` (also for an unknown id: no
oracle) and aborts the **same principal's** in-flight request:

- in-process through a registry, and across serverless instances through
  `cancel_requested_at` (a streamed call polls it every 750 ms);
- a **read** stops waiting at once (the harmless read finishes in the background);
- a **proposal** (`plan_change`, `prepare_deploy`, `restart_service`,
  `scale_service`) stops before it is recorded, or, if this call recorded it,
  the not-yet-started operation is **withdrawn through the broker**
  (`cancelOperation`: grants revoked, event appended) so no orphan approval
  waits for a person; a replayed proposal is left untouched;
- **execute** stops before the claim: nothing starts and no approval is
  consumed (the same call can be repeated). After the claim the start is driven
  to a recorded outcome, because abandoning a claimed operation would strand it;
- the call ends `request_cancelled` (HTTP 499 class, `isError`);
- `2026-07-28`: closing the HTTP request is the cancel, as the protocol says.

## 6. Revocation (RFC 7009), immediate

`POST /api/agent/oauth/revoke`, `application/x-www-form-urlencoded`, `token=...`
(authorized by possession; no cookie). `200` with an empty body for a revoked
**and** for an unknown/expired token (no oracle); `400 invalid_request`,
`unsupported_token_type`, `invalid_client`; `429` with `Retry-After`.

| Token | What is revoked | Effect |
|---|---|---|
| `za_` | the linked credential | next request `401` (nothing is cached) |
| `zp_` | the plugin grant | next request `401` (grant, plugin and parent re-read each time) |
| OAuth access token | the Zenith **grant** for (user, client, issuer) in `workspace=` (or `x-zenith-workspace`) | every token that client holds is refused next request: `403 integration_grant_required` |

Zenith cannot invalidate an OAuth token or refresh token at the issuer; if the
issuer advertises `revocation_endpoint`, a client should call both. Revoking the
grant is what ends access to Zenith. People can also revoke from the Integrations
screen (grants and linked agents) with the same immediate effect.

## 7. Prove it on your machine

### Automated, no network, no cloud

```
npx vitest run tests/agent-v3/protocol.test.ts tests/agent-v3/as-metadata.test.ts \
  tests/agent-v3/scope-catalog.test.ts tests/agent-v3/oauth-revoke.test.ts \
  tests/agent-v3/stream-store.test.ts tests/agent-v3/client-conformance.test.ts \
  tests/screens/integrations-consent.test.tsx tests/controlplane/tenancy.test.ts
```

`client-conformance.test.ts` drives the full journey over a real HTTP socket with
the conformance client below, once with a linked credential and once with an OAuth
access token verified against a runtime-generated key and a real grant journal.
Set `ZENITH_TEST_PLATFORM_PG_URL` to run the stream store on PostgreSQL as well.

### Against a running Zenith (local `npm run dev` or a deployment)

```
export ZENITH_CONFORMANCE_URL=https://your-zenith   # or http://127.0.0.1:3000 in dev
export ZENITH_CONFORMANCE_TOKEN=za_...               # use a throwaway token if you pass --revoke
export ZENITH_CONFORMANCE_WORKSPACE=<workspace id>   # required for OAuth access tokens
npm run agent:conformance -- --scopes read,plan --issuer https://your-issuer --discover-issuer \
  --tool zenith_get_topology \
  --args '{"target":{"workspaceId":"<ws>","projectId":"<p>","environmentId":"<e>"}}'
npm run agent:conformance -- --print-commands        # exact commands for real clients
```

Steps: `discovery, versions, scopes, read, streaming, resume, cancel, audience,
revocation`. A step the supplied configuration cannot exercise is `SKIP` with the
reason (for example `cancel` needs a call that is still running when the cancel
arrives; the unit harness holds one open, a deployment usually has none), never a
silent pass. Tokens are redacted from output.

### Real coding-agent clients (commands, not automated)

`npm run agent:conformance -- --print-commands` prints these with your origin.
In short: `claude mcp add --transport http zenith <origin>/api/agent/v3/mcp --header
"Authorization: Bearer $ZENITH_TOKEN" --header "x-zenith-workspace: $WS"` then
`claude mcp list`; Codex `[mcp_servers.zenith]` with `url`, `bearer_token_env_var`
and `http_headers`; `npx @modelcontextprotocol/inspector` for Streamable HTTP,
resume and cancellation by hand. These were **not run by the builder** (no client
credentials or issuer on the build machine); they are the verifier's checklist.

### The official MCP SDK client

`@modelcontextprotocol/client` is a regular pinned devDependency in `package.json`
(exact `2.2.0`, alongside `@modelcontextprotocol/server@2.0.0`). It is pinned at
2.2.0 because 2.0.0 is affected by GHSA-6qxp-vccf-f47h, which 2.2.0 fixes. The
automated harness still uses its own spec-conformant fetch client
(`scripts/agent/mcp-conformance/client.ts`). `--official` runs one connect /
list / call-with-progress leg through the official client. That leg is written
against the 1.x-shaped API and has **not** been executed.

## 8. Limits, stated plainly

- Resume needs the instance that runs the call to stay alive until it finishes
  (up to 55 s, `maxDuration` 60). If it dies, the stream stays `open` until it
  expires and the client must repeat the call with the same idempotency key.
- Cancellation of an in-flight call that is not streamed reaches only the
  instance holding it (no durable flag exists without a stream row).
- Two clients sharing one credential that use the same JSON-RPC id at the same
  time can cancel each other's call; they cannot reach another principal's.
- Zenith does not host an authorization server, a consent page for third-party
  clients, dynamic client registration or refresh tokens.
- The Zenith Claude Code plugin (`Zenith-plugins`) is a read-only stdio bridge
  to the v1/v2 reader using `za_` tokens and bounded JSON; it does not use v3,
  SSE or sessions. Nothing here changes it.
