# Hosted Revision 2 — integration decisions and unresolved gates

Prepared 2026-09-07 against `4231dda67fb5a0f57c4bd87117fa5af3c4c083de`. These are local audit records, **not** the missing report's A01–A09 decisions. No report decision or diagram has been reconstructed from its name.

## Evidence and scope

The supplied implementation instructions are available as `pasted-text.txt` in the user attachment. The separately referenced Revision 2 report, sections 01–25, P1–P10, A01–A09, D01–D09 and page-47 addendum, is absent from the attachment and checkout. Its location has been requested. The provisional inventory records attachment requirements with null report mappings; it cannot certify report coverage.

The completed application and landing identity remain the starting point. No new provider is registered, no hosted availability is advertised, and no permission-store migration has run. Existing Sandbox, LocalStack and AWS Preview capabilities retain their current labels. Historical architecture prose is not accepted as proof of current behavior.

## Local decisions

| ID | Decision | Reason and boundary |
| --- | --- | --- |
| PREP-01 | Work from the actual completed UI commit on `codex/zenith-hosted-r2`. | The report's older hashes are reference points, not reset targets. No push, merge or deployment. |
| PREP-02 | Make existing release checks blocking and exclude local state from the Docker context. | Implemented and locally checked, including pinned workflow-syntax validation and correction of an invalid job-level runner context. A passing local build is not a passing CI or Docker run. |
| PREP-03 | Correct the existing Navigator workspace admission and execution permission gap with focused regression tests. | Preserve current APIs and storage. This does not introduce app-recipient permissions or solve the hosted session/authority requirements. |
| PREP-04 | Do not cut over a permission authority or freeze report-dependent interfaces before reading the missing report. | D02/D08 and the addendum are explicitly normative. Guessing their contents would risk an incompatible security boundary. Read-only discovery and independent corrections continue. |

## Control authority: required cutover boundary

Current evidence: `src/lib/db/store.ts` keeps mutable in-process JSON state and debounces ordinary `save()` calls by 50 ms. `src/lib/actions/core.ts` has an in-process idempotency window. These do not provide the requested transaction-before-acknowledgement guarantee.

Permission-relevant migration includes more than new app grants: workspace members, workspace invitations, project/workspace relationships, connection ownership, environment/project/connection relationships, policy inputs and the parent ownership of revisions, deployments and Navigator runs. Audit every reader and writer of these inputs together. Legacy history payloads may remain outside SQLite only with an explicit failure contract and authoritative parent scope.

`src/lib/server/context.ts:172` currently resolves membership by subject or email, applies `app_metadata.role` to stored membership, supports implicit invitation/first-member bootstrap and can re-create membership from claims. These are existing local/workspace behaviors; they cannot serve as hosted revocation authority. Hosted migration must remove claim-driven re-grant and implicit read-side membership creation from its admission paths. Merely copying members into SQL while retaining these readers would leave two authorities.

`q.project()` accepts either global ID or slug. New security boundaries need canonical IDs or a workspace-scoped reference lookup. Do not reuse a global alias lookup as proof of ownership.

Migration must read the quiescent legacy files directly, pre-back them up, validate references/duplicates and commit a versioned import marker with the authority. Missing/corrupt existing authority must fail closed rather than create an empty store. No migration is implemented or executed in this wave.

### Driver and runtime gate

The host is Node 24.19.0; CI and Docker declare Node 22. No SQLite driver has been added. Node's built-in SQLite APIs differ across these lines: the Node 22 API documents later additions such as backup and busy timeout. Before choosing it, pin and test the exact runtime minimum across CI, container, setup checks and dependencies. A maintained external driver remains an alternative, not a silently selected dependency. See [Node 22 SQLite](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html), [Node 24 SQLite](https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html) and [better-sqlite3](https://github.com/WiseLibs/better-sqlite3).

Use foreign keys, bounded busy handling, WAL and `synchronous=FULL` for the requested acknowledgement contract. Validate the actual persistent volume and single-host assumptions: [SQLite WAL](https://www.sqlite.org/wal.html) and [online backup](https://www.sqlite.org/backup.html). The current drive letter alone does not establish filesystem durability. Process-kill evidence is not power-loss evidence, and a singleton is not highly available.

The new standalone `scripts/hosted-spike/sqlite-feasibility.ts` verifies these primitives against real OS-temporary files on Node 24.19.0 / SQLite 3.53.3 and portable Node 22.23.2 / SQLite 3.51.3, including transaction rollback/visibility, busy handling, a fresh revoked-row read, online backup and reopen. Eight checks pass on each. It neither selects a production driver nor migrates the application, and does not test power loss, disk full, process kill, deployment volumes or off-host recovery. See `CHECKPOINT.md` for exact evidence.

## Identity and private app admission

`src/lib/auth/session.ts` currently verifies claims and returns identity fields without a `session_id`. `src/lib/supabase/env.ts` intentionally makes authentication optional for local demo mode. Neither is sufficient to advertise fail-closed private hosted app access.

App grants must be separate from workspace membership. The selected hosted flow still needs exact control/app registrable domains, exact callback/origin policy, verified-email invitation acceptance, a transactional encrypted delivery outbox, app-bound exchange state, opaque host-only sessions and an authoritative live identity-session check. Invitation token hashes alone are insufficient to retry an email containing the token; a recoverable delivery payload needs its own encryption and retention boundary.

Supabase logout and token validity are distinct. Current documentation discusses checking session state, and current server behavior must be verified against the deployed Auth version and an already-issued token after sign-out. Do not assert that a method rename closes this gate, or that signature/expiry alone detects termination. Sources: [sessions](https://supabase.com/docs/guides/auth/sessions), [sign-out](https://supabase.com/docs/reference/javascript/auth-signout), [server-side advanced guidance](https://supabase.com/docs/guides/auth/server-side/advanced-guide), [getUser](https://supabase.com/docs/reference/javascript/auth-getuser).

Every protected HTML, asset, API, HEAD/range and alternate-origin path needs fresh admission. Revocation acknowledgement follows the authority commit. The next newly admitted request must be denied; already downloaded bytes cannot be recalled, and SQLite grant revocation and D1 writes are not one distributed transaction.

## Cloudflare feasibility gates

Official APIs support dispatch namespaces, script uploads, asset upload sessions and per-database D1 bindings. This is API research, **not live isolation evidence**. No Cloudflare account resources were created or queried.

| Gate | Finding / required proof |
| --- | --- |
| Binding isolation | Editable releases must have a strict binding allowlist. The fixed trusted broker owns its one D1 binding; editable code gets no database, dispatch, service, mTLS or other privileged binding. Read back every deployed binding. |
| Outbound policy | Outbound Workers alone do not cover every binding path. Durable Object and mTLS paths require separate denial through binding policy. Inspect each actual destination; reject uncontrolled redirects and alternate protocols. |
| Private assets | Admit HTML and static assets before dispatch. Namespace-wide asset deduplication needs app/tenant-aware artifact identity. Test direct worker/preview URLs and read back their configuration. |
| Release immutability | Script upload can replace an existing name. Content-addressed names, durable ownership/fencing and readback are needed; an upload endpoint is not a create-only guarantee. |
| Data transactions | D1 prepared statements/batches provide useful primitives, but zero affected rows do not throw automatically. Version, idempotency, quota and result conditions must be enforced inside the transaction and tested against actual D1. |
| Request quotas | Native rate limiting is eventually consistent and is not an exact daily accounting ledger. The requested daily cap needs atomic admission and reset semantics. |
| Storage quota | A strict 100 MB physical database cap has not been demonstrated. Provider physical limits and post-write size reporting do not establish pre-write enforcement. A logical-byte quota would be a different contract that must be disclosed and agreed. |

Primary sources checked in the audit: [static assets](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/), [outbound Workers](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/), [custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/), [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/).

The complete spike must use two owned test apps, separate identities, the real reference package, isolated test brokers/databases, denied requests and package execution. Local mocks or documentation cannot close these live gates. A preliminary **GET-only binding inspection harness** is implemented under `scripts/hosted-spike/`, with offline validation, fixed endpoints, strict binding policy, bounded/redacted transport and 84 passing synthetic tests. No Cloudflare requests were made. It is not the complete spike: normative topology, reference-app execution and live security proof remain pending.

## Builds, artifacts and activation

The current Sandbox build uses labeled synthetic logs and an FNV-derived digest. Keep that simulation intact; it is not artifact SHA-256 or a real customer build. The current engine's step completion and revision promotion are not evidence of a private candidate being checked against a separate test database. Navigator verification is a separate path.

The hosted build must execute only in a disposable isolated service, separate from the developer, control service, CI management runner and trusted publisher. The publisher independently checks bytes, SHA-256, source/job/lock/toolchain/schema/secret-version provenance and release approval. Successful bundle compilation alone cannot activate a candidate. Never run a submitted install, Vite configuration or build script on this host as a shortcut.

E2B remains a candidate. Its SDK provides execution, files, timeouts and teardown, but default network access is open. Domain allowlisting has shared-hosting and protocol caveats, and controller/public service access need explicit configuration and hostile-path tests. Provider teardown, artifact extraction and timeout behavior need live evidence. Sources: [SDK](https://docs.e2b.dev/sdk-reference/js-sdk/v2.38.2/sandbox), [network access](https://docs.e2b.dev/network/internet-access), [public access](https://docs.e2b.dev/network/restrict-public-access), [secured access](https://docs.e2b.dev/sandbox/secured-access), [template pinning](https://docs.e2b.dev/template/tags).

E2B's published [terms](https://e2b.dev/terms) require clarification of the intended customer-code/resale and adversarial-testing use before treating the service as approved. This is an unresolved provider approval gate, not a legal conclusion. No provider contact or purchase was made. [Pricing](https://e2b.dev/pricing) must be rechecked when a budget is approved; the report's $300 envelope is not authorization to spend.

## Recovery and release assessment

Artifact storage and encrypted off-host recovery storage providers are not selected. No off-host backup, clean-host restore, key recovery, newer-revocation reconciliation or export/import exit test has been demonstrated. A rollback pointer preserves data only after compatibility checks; restoring old data and permissions is a different, explicitly authorized operation.

Without newer revocation evidence, restored grants must remain invalid pending owner reapproval. Clearing sessions alone would leave stale grants. RPO ≤24 hours and RTO ≤4 hours remain targets pending a measured drill.

**Private real-data pilot: no-go. Broader commercial rollout: no-go.** The hosted core journey, authority migration, isolation, quotas, export/recovery and external trust evidence are incomplete. This assessment does not retract the existing local application or its explicitly simulated/provider-preview behavior.
