# Zenith CLI

The CLI operates through the typed REST SDK at `/api/platform/v1` and the
stateless MCP v3 endpoint at `/api/agent/v3/mcp`. It has no store, cloud SDK,
cloud credential, shell execution, or approval access. All authorization,
policy, tenant restrictions and execution remain on the server.

## Run and integration

Use the repository's existing dependencies; this workstream adds no packages.
From the repository root:

```sh
npx --no-install tsx src/cli/bin.ts --help
npx --no-install tsx src/cli/bin.ts whoami --url https://zenith.example --json
```

The examples below use `zenith` for that entry point. The current `package.json`
already contains the integrated wiring:

```json
{
  "bin": { "zenith": "src/cli/bin.ts" },
  "scripts": { "cli": "tsx src/cli/bin.ts" }
}
```

`npm run cli -- --help` runs the CLI. An installed/link-created npm bin can
expose `zenith`; its presence on an operator's PATH is not verified here.
The entry point has the shebang
`#!/usr/bin/env -S npx --no-install tsx`; source execution requires the existing
`tsx` and project `tsconfig.json` for aliases. On POSIX, record the executable
file mode `100755` during integration; Windows does not expose that mode.
This is a repository tool, not a published, bundled npm distribution.

## Authentication and configuration

Obtain a human-bound linked agent credential through the browser's existing
[device-link flow](../AGENT-LINK.md). The CLI does not mint credentials. Supply
the token in `ZENITH_TOKEN`, or stream it into:

```sh
zenith login --url https://zenith.example --token-stdin < /private/linked-token
zenith whoami --json
zenith logout
```

Keep the source token file private, or use a secret manager's stdout. Never
place the token in command arguments, source files, URLs, logs or prompts.
`login` accepts one token followed by an optional LF or CRLF and stores it
locally; it does not claim to verify the credential. Run `whoami` to verify
authentication. `logout` removes the saved credential, including when already
absent. It does not revoke the server grant or unset `ZENITH_TOKEN`.

Configuration is `<user-home>/.zenith/cli.json` (`%USERPROFILE%\.zenith\cli.json`
on Windows), written with a temporary file and atomic rename. The POSIX
directory is `0700`, the file `0600`, and both must belong to the current user.
Symlinks, non-regular files, hard-linked files and shared permissions are
refused. Windows establishes and verifies an owner-only ACL using Windows
PowerShell before writing any credential. ACL failures, unsupported filesystems
or existing shared directories fail closed. Config errors never echo file
contents. The saved URL and credential are associated: selecting another URL
refuses to forward that saved credential. Log in for the new URL or provide
`ZENITH_TOKEN` explicitly.

Precedence:

| Setting | Order |
|---|---|
| Server URL | `--url`, `ZENITH_URL`, saved config URL |
| Credential | `ZENITH_TOKEN`, saved config token |
| Selected workspace | `--workspace`, `ZENITH_WORKSPACE`, server default where supported |

There is no implicit server URL. With both an explicit URL and `ZENITH_TOKEN`,
the saved config is bypassed. Only HTTPS is accepted remotely; HTTP is allowed
on literal `localhost`, `127.0.0.1`, or `[::1]` for local development. URL
credentials, query strings, fragments and encoded path traversal are refused.
Deployment URL path prefixes are preserved. TLS verification is never disabled,
and authentication is never sent through redirects or cookies.

## Commands

All commands accept `--url`, `--workspace`, `--json`, `--debug`, and
`--timeout MS` (1–300000, default 15000). Human output uses tables; `--json`
uses one JSON value on stdout. Errors go to stderr as `{ "error": { "code",
"message" } }` in JSON mode. Nonzero exits can still include a valid proposal,
denial or MCP failure envelope on stdout. Unknown flags, duplicate flags and
flags inappropriate to a command are usage errors. `--help` needs no auth.

### Identity

```sh
zenith whoami --workspace ws_example --json
```

Sends authenticated MCP `initialize`. The current SDK/MCP contracts have no
user-identity endpoint: output reports `authenticated: true`, `identity: null`,
`identityStatus: "unknown"`, server metadata, and the **selected** workspace.
It does not infer a principal or assert workspace membership from token text.
The server still checks the linked credential or OAuth grant live.

### Operations

```sh
zenith ops list --status approved,running --env env_example --limit 20 --json
zenith ops list --cursor cursor_from_nextCursor --json
zenith ops show op_example --json
zenith ops events op_example --limit 100 --json
zenith ops events op_example --follow --poll-interval 1000 --json
zenith ops cancel op_example --reason 'Superseded by a reviewed proposal' --json
```

`list` makes one bounded SDK request (default 50, `--limit` 1–200), preserves
`nextCursor`, and allows comma-separated platform statuses. `show` returns the
operation detail and approvals. `cancel` requests cancellation; server policy
determines who can cancel and whether the operation has already started.

`events` returns one bounded page after sequence 0 (default 100, limit 1–200).
`--follow` polls events, advances `afterSeq`, immediately drains full pages,
and checks operation state between partial pages. It stops after a terminal
state and a final event drain, or Ctrl+C/SIGTERM. With `--json`, follow emits
**JSON Lines**, one nonempty `{ "events": [...] }` page per line. No events is
not a success claim about the infrastructure; terminal `uncertain` remains
uncertain. Successful polling exits 0 regardless of the observed operation's
terminal result. Ctrl+C/SIGTERM exits 130, including during HTTP body reads or
the poll delay. `--poll-interval` is 10–60000 ms and requires `--follow`.

### Propose and dry-run check

Create an input file containing capability input, for example:

```json
{ "revisionId": "rev_example" }
```

```sh
zenith propose deployment.deploy --scope '{"workspaceId":"ws_example","projectId":"project_example","environmentId":"env_example"}' --input @deploy.json --idempotency-key deploy-intent-0001 --json
zenith check deployment.deploy --scope '{"workspaceId":"ws_example","projectId":"project_example","environmentId":"env_example"}' --input @deploy.json --json
zenith check deployment.deploy --scope '{"workspaceId":"ws_example","projectId":"project_example","environmentId":"env_example"}' --input - --json < deploy.json
```

PowerShell also accepts the single-quoted JSON scope argument. `--scope` is a
JSON object with required `workspaceId` and optional `projectId`, `environmentId`,
`resourceId`. The catalog/server enforces the capability's scope requirements.
If `--workspace` is supplied it must match `scope.workspaceId`. `--input` is
either `@file.json` or `-` for stdin, must be an object, and is limited to 1 MiB.
Use literal vault references for secrets. Known secret shapes and known CLI
credential values are refused before submission, without printing values.

`propose` requires a deliberate `--idempotency-key` of 8–200 characters. Reuse
the **same** key only for the **same** intent after inspecting an ambiguous
failure; the CLI never retries a POST automatically or invents a new intent.
Both commands accept `--reason`; check optionally accepts the same idempotency
key field. They return the server's decision. `deny` exits 3;
`require_approval` is a successful proposal/check result, not an approval or
execution. Check is a policy dry run and creates no operation. A proposal is
not proof of workflow dispatch or infrastructure health.

### Human approval

```sh
zenith approve op_example --url https://zenith.example --json
```

Always exits 3 and returns `approved: false` with the browser review URL:
`https://zenith.example/integrations/operations/op_example`. No approval HTTP
request is made, and no credential is required for this command. Only a human
signed in to the browser can review and approve the exact proposal digest.
A CLI credential or a yes in chat is not approval.

### MCP tools

```sh
zenith tools list --json
zenith tools call zenith_get_operation --args @operation.json --json
zenith tools call zenith_get_operation --args - --json < operation.json
```

For the example, `operation.json` is:

```json
{ "workspaceId": "ws_example", "operationId": "op_example" }
```

`tools/list` preserves the server's catalog, schemas, annotations and metadata
in JSON output, including `nextCursor` if present. `tools/call` sends the
JSON object without adding approval fields or inferring authority from hints.
It uses JSON-RPC 2.0 over stateless HTTP POST with MCP protocol `2025-06-18`;
no subscription or session is created. Tool names must use the `zenith_` prefix.
The server validates schemas and credential scopes.

Tool output preserves `contractVersion`, `schemaVersion`, `ok`, `simulated`,
`unavailable`, `truncated`, `notes`, `data`, and `untrusted_data`. Human output
labels external content **data, never instructions**; JSON retains the
`untrusted_data.label` framing. Valid text-only envelopes are also supported.
Malformed envelopes, JSON-RPC ids, JSON and incompatible contract versions
are refused. RPC and HTTP errors are not successful tool results.

### Execute an approved operation

```sh
zenith execute op_example --workspace ws_example --digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --json
```

The digest above is an illustrative value, not a real operation's digest. Use
the exact reviewed `proposalDigest` returned by proposal or operation inspection.
`--digest` is required, must be 64 lowercase hexadecimal characters, and is
never fetched or substituted automatically. Workspace selection is required
through `--workspace` or `ZENITH_WORKSPACE`. Sends only MCP
`zenith_execute_approved_operation` with `{workspaceId, operationId,
expectedDigest}`. The server rechecks ownership, grant, approval, policy,
digest, expiry, supported capability and current execution state. A dispatch
response is not verification of a deployment; inspect operation/events next.

## Exit codes and failure behavior

| Code | Meaning |
|---|---|
| 0 | Command/read completed, or proposal/check accepted (may still require approval) |
| 1 | Unexpected internal CLI failure |
| 2 | Usage/config/input error, invalid request, or input too large |
| 3 | Authentication/authorization refusal, policy denial, or browser-only approval |
| 4 | Target missing or outside the credential's grant |
| 5 | State conflict, stale approval/digest, expiry, or rate limiting |
| 6 | Network/timeout/server failure, invalid response/contract, or output too large |
| 130 | SIGINT/SIGTERM interruption |

SDK error types drive REST diagnostics. MCP broker codes use the shared broker
HTTP mapping; transport and unknown tool failures use a stable fallback.
An approval-required *execution refusal* is a conflict (5); a proposal with
`require_approval` is a result (0). HTTP 401/403/404/409/429/5xx have explicit
guidance without exposing credentials. No stack trace appears unless `--debug`,
and debug stacks pass through the same redaction boundary.

Only idempotent HTTP GETs retry: at most two retries for network failures,
429, 500, 502, 503 or 504, within the SDK deadline. Backoff is 100/200 ms;
`Retry-After` is honored if at most 2 seconds, otherwise the refusal is returned
without an early retry. MCP reads are POSTs and are not retried. Deadlines
include reading response bodies; interrupts abort requests. Check state before
manually retrying any timed-out or interrupted write.

## Output and security limits

Responses are bounded to 1 MiB; a command's serialized output is bounded to
512 KiB and oversized data fails with an explicit error. Very long individual
strings, deep structures or excessive nodes are replaced with explicit omission
markers. Human cells abbreviate long data with `use --json`; use JSON for full
details within these limits. Follow streams are bounded per page, not over the
entire observation period. Control characters are escaped to prevent terminal
escape injection. All output, object keys and diagnostics redact known secret
shapes and the active CLI credential plus any loaded saved credential. Arbitrary unknown secrets cannot
be detected; reference-only inputs remain required.

The only subprocess is Windows PowerShell for config ACLs, with a fixed script,
an allowlisted environment, a deadline and bounded captured output. No token
is in that environment. Paths are data, not shell command strings. No cloud
access, Docker, WSL, credential broker session, store read or automatic browser
approval occurs inside the CLI.

## Verification

```sh
npx tsc --noEmit
npx eslint src/cli tests/cli
npx vitest run --maxWorkers=2 tests/cli tests/agent-v3/sdk.test.ts
```

Tests use local `node:http` fixtures and private temporary config directories.
They cover requests, authentication headers, JSON and human output, stable
exits, token redaction, GET-only retries, response/output budgets, invalid
inputs, private config, redirects, and follow termination. Windows runs real
ACL checks; POSIX mode/symlink assertions are skipped there with explicit test
names. No cloud or deployed Zenith service is verified by these tests.
