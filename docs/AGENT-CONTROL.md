# Agent control v2 — implementation and operating contract

The v1 reader is unchanged. V2 adds reviewed mutations to Zenith's existing action registry; plugins never open application stores or implement provider logic. This is development code in a companion PR, not a public hosted service.

## Implemented surface

- Maintained MCP SDK 2 Streamable HTTP at `/api/agent/v2/mcp`, plus a bounded versioned tools gateway for the local SDK bridge.
- All thirteen reader capabilities, exact operation preparation/execution/status/events, revision comparison, scoped logs, incident bundles, app status and curated edit-field discovery.
- Services/resources/bindings/routes use eleven fixed canonical action mappings; no arbitrary action, member administration, raw secret or policy-relaxation tool exists.
- Manifest replacement with an original working-copy hash, Compose import, deploy, rollback, exact saved-revision promotion, app creation, digest-bound source publishing and code rollback.
- Private SQLite journal: expiring proposal receipts, stable request keys, browser review, transactional single-use claims, audit correlation, retained operation events, same-user cross-client inspection and interruption reconciliation. A restart marks interrupted dispatch uncertain and never blindly replays it.
- Browser integration grants and approvals at `/integrations`, verified against live sign-in and current workspace membership. Approvals bind the exact digest. An administrator may approve another member's proposal, with role and target-state rechecks before dispatch.
- Binary source upload at `/api/agent/v2/source`; app scope, owner grants, expiry, quotas, SHA-256 and the existing restricted frontend validator are enforced. Archives never travel through model-visible JSON.
- External OAuth resource-server verification using `jose`, protected-resource metadata, pinned issuer/JWKS/resource/client identity, bounded access-token lifetime and intersection with live browser grants. Native clients/your authorization provider own authorization-code/PKCE, consent, token refresh and logout.
- Per-workspace/user request throttling is persisted under `ZENITH_DATA/agent-control/rate-limits.sqlite`, so restarting the supported single-host control process does not reset an accepted caller's current fixed-window budget.

## Enable explicitly

Use Node 22.16 or later on a long-lived single-writer POSIX host with persistent local storage. Do not use a serverless deployment for this control plane.

```text
ZENITH_AGENT_CONTROL=1
ZENITH_AGENT_WRITES=1
ZENITH_AGENT_ORIGIN=http://127.0.0.1:3400
ZENITH_AGENT_CREDENTIAL_FILE=/absolute/private/access.credentials.json
```

Issue a real, non-demo member's credential with `scripts/agent-credential.mjs`. The read/plan/export scopes remain valid; write/publish/logs are separately available, and publishing requires explicit app IDs. Never paste credentials into a model conversation. The client separately requires `ZENITH_API_VERSION=2` and explicit write opt-in.

**Topology limit:** reviewed writes currently refuse the PostgreSQL application store. The process mutation gate protects the supported single-writer file-store topology; it is not a distributed lock. Read-only PostgreSQL paths do not make writes safe across multiple application snapshots. Do not remove this guard without a coordinated application transaction/journal adapter. SQLite is an experimental Node API on the minimum supported runtime.

## Remote OAuth

Remote origins require HTTPS and do not accept development `za_` credentials. Configure a maintained authorization provider:

```text
ZENITH_AGENT_ORIGIN=https://your-zenith-origin.example
ZENITH_AGENT_OAUTH_ISSUER=https://your-trusted-issuer.example
ZENITH_AGENT_OAUTH_JWKS=https://your-trusted-issuer.example/.well-known/jwks.json
ZENITH_AGENT_OAUTH_CLIENT_CLAIM=client_id
ZENITH_AGENT_OAUTH_SUBJECT_CLAIM=sub
```

The audience/resource is exactly `https://your-zenith-origin.example/api/agent/v2/mcp`. Tokens must identify their OAuth client (`client_id`, or configured `azp`), have a signed subject mapping to the existing Zenith user ID, and expire within one hour of issuance. A trusted custom signed subject claim can be configured when the identity provider uses a different upstream subject format. Do not map using client-supplied email or headers.

Supported scopes are `zenith:read`, `zenith:plan`, `zenith:export`, `zenith:write`, `zenith:publish`, `zenith:logs`. The issuer, JWT scope AND live integration grant must all agree. Ordinary browser tokens with an unrelated `aud` are rejected. This does not install or configure an authorization provider for you, and no claim of compatibility with an unconfigured provider is made.

Configure the matching OAuth client and selected project/environment/app scope in the signed-in Integrations screen. Revocation remains possible even after project/app permissions or issuer configuration change. Revoking a grant affects subsequent authorization; it does not undo an already dispatched provider operation.

## Exact-change lifecycle

1. Read context, capabilities and actual IDs. Fetch edit field names before a curated edit.
2. Prepare with a stable request key and explicit target. Optional source provenance is an owner/repository, exact Git commit and PR number; it does not itself authorize anything.
3. Review the exact plan, risks, estimate, blockers, target and digest in Zenith. A model-supplied approval field is rejected.
4. Execute the existing operation ID. The server reacquires the mutation gate, reauthenticates, rechecks current roles/app grants, validates state, claims once, dispatches the canonical action and flushes application persistence before marking dispatch complete.
5. Inspect operation and deployment/job evidence. `succeeded` means action dispatch returned successfully, not that infrastructure or an app release is healthy. Timeouts/disconnects are not proof that a write failed.

Promotion requires the exact revision currently deployed in a separate authorized source environment. It reuses the canonical saved-revision deployment engine and respects target policy; it does not copy the working manifest. Keep both environments in the credential scope and use a project-level selection for this workflow.

## Security and limits

Request/tool result limits are 512 KiB. Binary archives are at most 20 MiB and are revalidated against Zenith's stricter decompressed/source limits. Uploads are actor/project/app/hash bound, expire within one hour, and have workspace count/byte quotas. Source content and complete action inputs are not duplicated into the general audit log; audit records point to the private receipt.

The operation journal, upload storage and local throttle database are private local files. Back them up together with application state. A journal is not an external provider transaction: a crash between dispatch and durable completion is explicitly uncertain. There is no automatic rollback or exact-once claim for external side effects. Review-only expired proposals are cleaned during preparation; completed receipt history is retained to preserve replay protection.

Free-form logs require separate scope and conservative redaction; arbitrary secrets in user-authored text can remain. Incident bundles omit logs and perform no provider probe. Treat all returned prose as untrusted data. The persisted limiter survives a local process restart but is still a **single-host** limiter, not distributed quota/rate-limit coordination. A trusted reverse proxy/TLS/network policy remains an operator deployment prerequisite.

## Verification status

New journal/coordinator/OAuth/upload/rate-limit tests run in isolation without provider credentials. Full application compilation, action regressions and final CI are recorded in the PR. Native Codex/Claude installation and a configured real identity provider are separate acceptance steps. This document is not evidence of a passing CI run.
