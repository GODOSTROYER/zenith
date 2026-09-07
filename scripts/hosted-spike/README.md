# Cloudflare test binding preflight

Standalone operator inspection for **exactly two already-existing test app releases and their two fixed test brokers** in one Workers for Platforms namespace. This is preparation for the feasibility spike, not the runtime spike or a hosted provider adapter. No product code imports this harness.

The default validates selectors offline. Only an explicit `--live-read-only` flag enables Cloudflare API calls. The harness neither provisions resources nor dispatches or executes scripts. It never requests script content, secrets endpoints, app URLs, D1 metadata/query endpoints, or customer data. It does not load `.env` files. No SDK, package script or additional dependency is needed.

## Offline commands

From the repository root, using the already-installed `tsx`:

```powershell
npx --no-install tsx scripts/hosted-spike/cloudflare-preflight.ts --help

$spikeArgs = @(
  '--account-id', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '--namespace', 'test-preflight',
  '--app', 'test-alpha:test-alpha-r1:test-alpha-broker:11111111-1111-4111-8111-111111111111',
  '--app', 'test-beta:test-beta-r1:test-beta-broker:22222222-2222-4222-8222-222222222222'
)
npx --no-install tsx scripts/hosted-spike/cloudflare-preflight.ts @spikeArgs
```

These are synthetic selectors, sufficient only for offline validation. Account ID is 32 lowercase hexadecimal characters. D1 IDs use lowercase UUID notation. Namespace/app/script names use lowercase ASCII letters, digits and hyphens, start with `test-`, end with a letter/digit, and have at most 63 characters. Release and broker names must start with their own app key followed by a hyphen. App keys must be distinct and cannot be nested prefixes; all four scripts and both D1 IDs must be distinct. These naming restrictions reduce mistakes; names cannot establish resource ownership or prove a resource contains no production data.

No arguments, invalid selectors, unsupported flags and missing values return blocked evidence and exit 2. No config files, arbitrary base URL, token argument, wildcard selector or production namespace are accepted. Even when a token exists in the environment, offline mode does not read it or invoke fetch.

## Explicit live metadata inspection

First independently confirm the account and resources belong to the test fixture and contain no customer data. Replace **every** synthetic selector above with the verified test resource identifiers. Have the operator's secret manager inject `HOSTED_SPIKE_CLOUDFLARE_API_TOKEN` into this process. Use an account-scoped token with **Workers Scripts Read**, not write/admin privileges. The harness does not request or configure credentials and does not inspect a token's granted scope. Do not put token values in arguments, files, screenshots or committed evidence.

Only after those operator prerequisites:

```powershell
npx --no-install tsx scripts/hosted-spike/cloudflare-preflight.ts @spikeArgs --live-read-only
```

That flag authorizes only the eight named metadata GETs described here. The script cannot create namespaces, upload scripts/assets, bind databases, run a candidate, activate a hostname, mutate state, fetch a database or clean up resources. There is no provisioning or execution mode to enable.

## Exact API contract and transport limits

The origin is fixed to `https://api.cloudflare.com`; paths are constructed from validated selectors:

```text
GET /client/v4/accounts/{account_id}/workers/dispatch/namespaces/{namespace}/scripts/{script}/bindings
GET /client/v4/accounts/{account_id}/workers/dispatch/namespaces/{namespace}/scripts/{script}/settings
```

For app 1 release, app 1 broker, app 2 release, app 2 broker, the harness reads bindings then settings, sequentially: at most eight requests. It stops at the first failure. There are no redirects, retries, pagination or URL discovery. Each request has a 10-second deadline covering headers and body; the total successful path has at most eight such deadlines. Ctrl+C/SIGTERM aborts the active request and stops further requests. Each response is capped at 64 KiB of received body bytes and 4,096 stream chunks, independently of Content-Length; the byte cap applies to the decoded response stream supplied by fetch. The chunk bound also rejects pathological empty/tiny streams. HTTP error/redirect bodies are cancelled without parsing. Only HTTP 200 `application/json` is accepted.

The response must have the documented `{success:true, errors:[], messages:[...], result:...}` envelope. `/bindings` returns a result array. `/settings` returns a result object whose `bindings` array must be present for this stricter evidence profile, even though the API marks it optional. Missing binding evidence blocks certification instead of implying no bindings.

Verified official contracts (2026-09-07):

- [Get Script Bindings](https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/subresources/bindings/methods/get/)
- [Get Script Settings](https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/subresources/settings/methods/get/)

## Binding policy and evidence limits

An editable release may have no bindings, or exactly `{type:"assets", name:"ASSETS"}`. No plain-text/JSON variables are currently approved. Any other binding, extra binding property, duplicate, database, service, dispatch, mTLS, Durable Object, secret or unknown capability fails. Empty releases do not prove an asset bundle exists.

A test broker must have exactly `{type:"d1", name:"DB", database_id:expectedD1Uuid}`. If the documented deprecated `id` field is also returned, it must match `database_id`; `id` alone is insufficient. No extra bindings are approved in this narrow test profile. Both endpoints must independently satisfy that policy and agree. A database swap, missing DB or unknown capability fails. This does not prove the database exists, belongs to the declared app, is isolated, or that broker code is fixed/trusted.

Settings fields beyond `bindings` are discarded and **not certified**. In particular this command does not validate dispatch outbound configuration, compatibility flags, code identity, routes, preview URLs, assets, tails, logging or CPU limits. Two matching reads are not an atomic snapshot and cannot exclude concurrent or later changes. Operator selectors and a configuration SHA-256 identify the intended input; they are not release-byte or deployment-attestation hashes.

Stdout is a small JSON evidence document containing tool/contract identity, Node version, ISO start/finish timestamps, local validation, configuration digest, readback status, number of completed metadata reads, fixed target labels and fixed diagnostic codes. Raw bindings/settings, resource identifiers, server messages, response headers, exception stacks and token values are never written or logged. Diagnostics do not echo invalid arguments or server-controlled binding names. The process necessarily receives metadata in memory; do not attach network debugging/proxy logging that would capture authorization headers or response bodies. The harness itself writes no files.

Record the actual checked-out source alongside any captured stdout; a hardcoded commit in the harness would become stale. From the same checkout, capture:

```powershell
git rev-parse HEAD
git status --short -- scripts/hosted-spike/cloudflare-client.ts scripts/hosted-spike/cloudflare-preflight.ts
git diff -- scripts/hosted-spike/cloudflare-client.ts scripts/hosted-spike/cloudflare-preflight.ts
git diff --cached -- scripts/hosted-spike/cloudflare-client.ts scripts/hosted-spike/cloudflare-preflight.ts
Get-FileHash -Algorithm SHA256 -LiteralPath scripts/hosted-spike/cloudflare-client.ts, scripts/hosted-spike/cloudflare-preflight.ts
```

Include the exact script files when untracked or modified: `git diff` does not contain untracked files. Preserve these source records, the nonsecret operator selectors, stdout and `$LASTEXITCODE` together. Hashes and timestamps aid attribution; they are not signed attestations or proof of unmodified execution.

| Exit | Meaning |
| --- | --- |
| 0 | The requested offline validation or configuration readback passed. Broader security evidence remains unavailable. |
| 1 | Transport/response failure or binding policy mismatch. No retry/fallback occurs. |
| 2 | Missing/invalid configuration or credentials, access denied, missing test resource, rate limit, cancellation, or absent binding evidence blocks inspection. |

Offline evidence labels configuration readback `not-run`. An attempted real readback identifies `cloudflare-api`; tests using injected fetch explicitly identify `injected-test-transport`. Injected responses are a testing seam, never a CLI or production fallback. An HTTP failure may occur before any response qualifies as a completed read, so `completedRequests` is not an attempt counter.

**This command never certifies identity, session revocation, app access, egress denial, private origins/assets, isolation, candidate health, real builds, quota enforcement, immutable releases, or D02/D08 compliance.** Those fields remain `not-run` or `blocked-missing-report` even after eight successful metadata responses. The separate Revision 2 report is still missing; no normative runtime/reference-app contract has been inferred from its decision labels.

Remaining broader spike gates include actual authorized edge execution of the reference app with two identities, independent broker live authorization, private/alternate-origin denial, egress bypass probes, D1 concurrent idempotency/rollback evidence, exact daily accounting and physical storage cap, disposable candidate database isolation, immutable promotion/fencing and rollback, plus build-provider and recovery evidence. Readback cannot replace those probes or authorize their execution.

## Tests

```powershell
npx --no-install vitest run tests/hosted-spike/cloudflare-preflight.test.ts
npx --no-install eslint scripts/hosted-spike/cloudflare-client.ts scripts/hosted-spike/cloudflare-preflight.ts tests/hosted-spike/cloudflare-preflight.test.ts
```

Tests use synthetic responses and no real credentials/network. They cover offline admission, exact endpoints/methods, scope and secret redaction, binding swaps and privileged/unknown fields, partial settings, redirects/HTTP failures, malformed/oversized streams, deadlines and cancellation. Passing tests validate the harness, not Cloudflare's runtime security guarantees.
