# Hosted apps — Revision 3 acceptance record

Twelve gates, `PLAN-R3.md` §3, run against the real modules with no doubles for
success. One record per gate, in the format of
`docs/hosted/evidence/acceptance-record-template.md`.

**Tester:** W10 agent (verify workstream).
**Date:** 2026-09-07.
**Source SHA:** `c5adcf61b3d1a3842e388725532294273ee5cc53`, branch
`zenith/hosted-r3`, plus this workstream's own additions
(`tests/hosted/acceptance/**`, `scripts/hosted-acceptance.ts`,
`scripts/hosted-browser.ts`, the `hosted` CI job) uncommitted at run time.
**Environment:** Windows 11 Home 10.0.26200 (x64), Node v24.19.0, SQLite 3.53.3
through `node:sqlite`, vitest 3.2.7, Google Chrome 152.0.7977.82 driven by
`playwright-core` 1.56.
**Configuration in effect:** `ZENITH_BUILD_RUNNER=recipe-local`,
`ZENITH_RUNTIME=local`, `ZENITH_APP_DOMAIN=apps.localhost`,
`ZENITH_APP_SCHEME=http`, `ZENITH_CONTROL_ORIGIN=http://localhost:3400` (the
loopback runs override the port), `ZENITH_BACKUP_TARGET=filesystem`.
Secrets by presence only: `ZENITH_SECRET_KEY` set, `ZENITH_BACKUP_KEY` set,
`ZENITH_CF_API_TOKEN` absent, `E2B_API_KEY` absent, `ZENITH_SMTP_URL` absent.
Every suite runs in its own `mkdtemp` data directory; `.data` was never touched.

**Repeatability — the three commands this record is made of:**

```
npx vitest run tests/hosted/acceptance tests/ci   # 124 tests, 13 files
npx tsx scripts/hosted-acceptance.ts              # 22 checks, exit 0
npx tsx scripts/hosted-browser.ts                 # 24 steps, exit 0 (needs Chrome or Edge)
```

## Summary

| Gate | Name | Tests | Result | Artifact path |
| --- | --- | --- | --- | --- |
| 1 | Source → app; hostile inputs rejected | 13 | **pass** | `tests/hosted/acceptance/gate-01-source-to-app.test.ts` |
| 2 | Second identity, no workspace membership | 8 | **pass** | `tests/hosted/acceptance/gate-02-second-identity.test.ts` |
| 3 | Denial matrix | 14 | **pass** | `tests/hosted/acceptance/gate-03-denial-matrix.test.ts` |
| 4 | Broker roles, reserved routes, no data capability | 8 | **pass** | `tests/hosted/acceptance/gate-04-broker-roles.test.ts` |
| 5 | No secret in a build; CSP; CSRF; egress named | 13 | **pass** | `tests/hosted/acceptance/gate-05-boundaries.test.ts` |
| 6 | Quotas, body cap, single-flight, suspension | 8 | **pass** | `tests/hosted/acceptance/gate-06-quotas-and-limits.test.ts` |
| 7 | Durability across a reopen; no duplicate retries | 6 | **pass** | `tests/hosted/acceptance/gate-07-durability.test.ts` |
| 8 | Compatible update; stale write → 409 | 6 | **pass** | `tests/hosted/acceptance/gate-08-compatible-update.test.ts` |
| 9 | Failed candidate; rollback ≠ restore | 7 | **pass** | `tests/hosted/acceptance/gate-09-failed-candidate.test.ts` |
| 10 | Clean-directory restore with reconciliation | 8 | **pass** | `tests/hosted/acceptance/gate-10-restore.test.ts` |
| 11 | Real health and logs; simulated stays labelled | 8 | **pass** | `tests/hosted/acceptance/gate-11-health-and-logs.test.ts` |
| 12 | Fresh-browser recipient flow | 11 + 24 | **pass** | `tests/hosted/acceptance/gate-12-browser-flow.test.ts`, `scripts/hosted-browser.ts` |

110 acceptance tests, plus 14 in `tests/ci/release-gates.test.ts` covering the
new `hosted` CI job. Total wall time for the acceptance suite: ~14 s on this
machine (13 real `recipe-local` Vite builds, ~2.2 s each).

**Defects found: none.** Every gate passed on the modules as they stand, and no
test in this suite is marked `// DEFECT:`. The adversarial probes that did *not*
find anything are listed at the end, because "we looked and found nothing" is
evidence and "we did not look" is not.

---

## Gate 1 — pinned source → real build → SHA-256 artifact → running app

| Field | Value |
| --- | --- |
| Requirement | PLAN-R3 §3.1; gap rows G01, G05, G06, G07 |
| Input | `fixtures/tracker-app`, published through `admitPublish` + `runJobOnce` with `ZENITH_BUILD_RUNNER=recipe-local`; then five hostile tarballs assembled in memory from the same tree |
| Expected | A real Vite build; one content-addressed artifact whose recomputed digest equals its key; an active release; `GET /` on `alpha.apps.localhost:3400` serving the built `index.html` with `x-zenith-release`; every hostile input failing at intake with its reason recorded and no release created; a tampered artifact byte failing both `verify()` and `appHealth` |
| Actual | All of it. The artifact recorded `recipe.id = vite-react-v1`, `builtBy = recipe-local`, `buildBoundary` containing "not a hostile-code sandbox", and a non-null `verifiedAt`. `store.verify()` answered `4 files, 226350 bytes, digest matches.` The digest observed for `fixtures/tracker-app` on this machine was `e91832eaceed3dc089cc8e5feb58320057ef52e9e2d68e71f7fb2845fdaa92c9`. The served HTML was byte-identical to the stored `index.html`. Hostile inputs: `../escaped.tsx` → `".." segment`; a symlink entry → `symbolic link is not accepted`; `vite.config.ts` → named in the reasons; `left-pad` in dependencies → named; a file one byte over `SOURCE_LIMITS.maxFileBytes` → `per-file limit is`. Each job ended `failed` in phase `intake`, the release count did not move, and the app kept serving release 1 at fence 1. Flipping one bit of the stored `index.html` made `verify()` answer `index.html has changed`, `appHealth().ok` false with `artifact_verified` red, and `/_zenith/health` report `artifact.verified: false` — and restoring the byte made all three green again |
| Pass / fail | **Pass** |
| Limitations | `recipe-local` is a child process on this host, not an isolated sandbox, and the artifact records that in `buildBoundary`. The hostile archives are the shapes this contract knows how to refuse; they are not an exhaustive corpus. Digest reproducibility was observed across runs on one machine and one Node line, not across platforms |

## Gate 2 — a second identity with no workspace membership

| Field | Value |
| --- | --- |
| Requirement | PLAN-R3 §3.2; gap rows G10, G11, G12 |
| Input | A subject in no `db().members` row and holding no grant, invited by email, accepting with a verified identity, launching through `createExchange` and redeeming on the app host |
| Expected | Invitation hashed and single-use; acceptance refused for a different address and for an unconfirmed one, in the same words; a `__Host-zenith_app` cookie (Secure, HttpOnly, SameSite=Lax, Path=/, no Domain) from the callback; `/_zenith/session` showing the granted role; the same identity and the same cookie useless on app B |
| Actual | The recipient started with no member row and no grant, and a cold request answered 401. `acceptInvite` refused `OUTSIDER`'s verified address and the recipient's unverified one with the identical message *This invitation was sent to a different address.*, then granted `editor` on the third call and refused the fourth (single use). The callback answered 303 to `/`, set the cookie with every attribute and no `Domain`, and set no `sb-*`/`zenith-*` cookie. A replayed callback bounced to `/_zenith/auth/signin?error=…` and set no cookie; that page contains "Open this app from Zenith", links to `http://localhost:3400/apps` and has no `<input>`. `/_zenith/session` answered `subject`, `role: editor`, and the serving release id. The recipient created a record attributed to their own address. On `beta.apps.localhost` the same cookie answered 401 with a body byte-identical to a stranger's, `artifactServed` and `brokerInvoked` both 0; `createExchange(beta.id, …)` refused with the same sentence an unknown app id produces. Exchange binding: a tampered `state` and a code presented on beta's host both bounced with `error=forbidden`, set no cookie, and consumed the code |
| Pass / fail | **Pass** |
| Limitations | The identity is verified by a `VerifiedIdentity` value, not by a live Supabase round trip — no identity provider is reachable from this machine. G13's live `getUser()` path is covered by W5's own suite with an injected authority, not here. The invitation is never delivered by email: no SMTP is configured, so `acceptUrl` is the only copy |

## Gate 3 — the denial matrix

| Field | Value |
| --- | --- |
| Requirement | PLAN-R3 §3.3; gap rows G13, G14 |
| Input | Six callers — never invited, fabricated cookie, revoked grant, expired invitation, app A's cookie on app B, a session ended by platform sign-out, and a suspended app — each on five request shapes: HTML `/`, `/assets/<hashed>.js`, `/_zenith/data/v1/requests`, `HEAD /`, and a `Range` |
| Expected | 401 for a program and 303 to the sign-in page for a navigation on every access denial; 423 on every shape for a suspended app; the invocation sentinel at zero for every cell; 404 with no release stamp for a request carrying the control origin's Host |
| Actual | Exactly that. An admitted owner first produced 200/200/200/200/206 with `artifactServed > 0`, so the matrix measures denial and not absence. Every denied cell answered `{html: 303, asset: 401, api: 401, head: 401, range: 401}` with `artifactServed === 0` and `brokerInvoked === 0`; the suspended app answered 423 on all five, with the operator's reason repeated in the message and a fix naming "data, grants and releases", while `GET /_zenith/auth/signin` still rendered. `If-None-Match: *` from a stranger answered 401, not 304. Signing out of alpha left beta's session working; `terminateAppSessionsForSubject` then ended it. `Host: localhost:3400`, a Host/parameter mismatch, and an unknown slug all answered 404 with no `x-zenith-release`, and none of them moved alpha's quota counter. Refusals carried the full security header set and no `set-cookie`. Every denial was recorded as an `access.denied` event, and the day's counter exceeded the denial count — R3-12's "every request that reached a known app host counts" |
| Pass / fail | **Pass** |
| Limitations | The expired invitation is expired by moving its `expires_at` into the past, not by waiting 48 hours. "Suspended" is produced by the real suspend job, but the app was suspended by a test rather than by an operator through the UI |

## Gate 4 — broker roles, reserved routes, no data capability in app code

| Field | Value |
| --- | --- |
| Requirement | PLAN-R3 §3.4; gap rows G16, G17 |
| Input | Owner, editor and viewer sessions on one app; a published source that deliberately carries `public/_zenith/session.json`; verb-override attempts; a second app with its own data |
| Expected | Owner and editor create and update; viewer reads but cannot write, and the refusal happens before the store is opened; `X-HTTP-Method-Override`, `X-Method-Override` and `?_method=` all ignored; reserved routes win over any published file; app A's cookie cannot reach app B's data; no artifact response carries a cookie |
| Actual | Owner created, editor created and updated (version 1 → 2, attributed to the editor). The viewer's `GET` reached the broker; their `POST` and `PATCH` answered 403 naming their role, and `brokerInvoked` did not move for either — the record stayed at version 2 with its previous title. All three override forms answered 200 with a list and created nothing; `POST` to an item answered 405 with `allow: GET, PATCH` even carrying an override header. `_zenith/session.json` was verified present in the artifact's file table and answered 404 (`reserved paths`) with `artifactServed === 0`, while `/_zenith/session` answered the platform's own `SessionInfo`; a source with `public/_zenith/session` (no extension) was refused at intake. `/ASSETS/INDEX-….JS` answered 404 while `/assets/index-….js` answered 200, so a case-folding filesystem is not a way past the exact-path match. Alpha's cookie on beta's data answered 401 with beta's store never opened; beta's list contained only beta's row; the two databases are different files. A served artifact carried no `set-cookie` and no `location`, and `applyResponseGuard` stripped a forged `set-cookie`, `location` and `access-control-allow-origin` from a response it did not build |
| Pass / fail | **Pass** |
| Limitations | "The editable code path holds no data capability" is established by the shape of the system — the app is static files and the broker is the platform's — rather than by attempting to escape from inside app JavaScript. The reserved-prefix collision is the closest an app can get under source contract v1; a future contract that allowed extensionless public files would need this re-run |

## Gate 5 — no platform secret in a build or an artifact; headers; CSRF; egress

| Field | Value |
| --- | --- |
| Requirement | PLAN-R3 §3.5; gap rows G15, G25 |
| Input | Six decoy variables (`ZENITH_DECOY_SECRET`, `SUPABASE_DECOY_SERVICE_ROLE`, `ZENITH_DECOY_TOKEN`, `E2B_DECOY_API_KEY`, `AWS_DECOY_SECRET_ACCESS_KEY`, `NEXT_PUBLIC_DECOY`) with values that appear nowhere else, planted in the process environment before the build; then a real `recipe-local` build of `fixtures/tracker-app` |
| Expected | No decoy value and no decoy name anywhere in the artifact; the build child's environment holding only `PATH` and an emptied `NODE_OPTIONS`; the security header set on every response type; a write refused unless it carries this app's own origin; the limits the local runtime does not enforce named as such |
| Actual | Every stored file of the artifact was read and searched: no decoy value, no decoy name, and no occurrence of `ZENITH_SECRET_KEY`'s value. `buildChildEnv()` returned exactly `{ NODE_OPTIONS: "", PATH }` and `secretEnvKeys` of its keys was empty. Nine response shapes — HTML, hashed asset, reserved JSON, 206, 416, 401, two 404s and 405 — all carried the six headers of `GATEWAY_SECURITY_HEADERS` verbatim. Cache policy: `private, no-store` for HTML and for the unhashed `favicon.svg`, `private, max-age=300, immutable` only for the hashed asset. CSRF: no `Origin`, a foreign origin, a sibling app's origin, the control origin, the right host on `https`, and the right origin with `Sec-Fetch-Site: cross-site` were all 403 `csrf_rejected` with `brokerInvoked === 0`; the same request from the app's own page answered 201. Sign-out needed the same proof, and a refused sign-out left the session working. A request carrying only `sb-*`/`zenith-*` cookies answered 401. `enforcementFor("local")` reports `requestCpuMs` and `outboundSubrequests` as `not_enforced` with the label *Not enforced by this runtime — shown because it applies on Cloudflare.*, and the runtime's own label says "single host" |
| Pass / fail | **Pass** |
| Limitations | **There is no runtime egress control here, and this gate does not claim one.** The local runtime serves static files and runs the fixed broker inside the control process; it has no network namespace, no outbound proxy and no subrequest accounting. What is enforced is a CSP that stops a *page* from reaching another origin, and a build step that runs no submitted code. Egress enforcement is a Cloudflare property and is untested until an account exists. The secret scan proves those six variables did not travel; it cannot prove that no variable ever could |

## Gate 6 — quotas, the body cap, single-flight, suspension

| Field | Value |
| --- | --- |
| Requirement | PLAN-R3 §3.6; gap rows G19, G20 |
| Input | `admitRequest` driven directly with `limit: 3`; the real counter row moved to `DEFAULT_LIMITS.requestsPerDay` through the authority and then a real gateway request; a 1 MB+ body sent both with `Content-Length` and as a chunked stream; three apps queueing publishes; a real suspend/resume job pair |
| Expected | The request numbered exactly `limit` admitted and the next one counted *and* denied; a 429 with `retry-after` on the app host once the row is at the ceiling; 413 for both oversize shapes; one running job per app and two install-wide; suspension keeping data, grants, releases and artifacts, and resume serving again |
| Actual | `admitRequest` answered `[true, true, true, false]` with counters `[1,2,3,4]` and `denied: 1`, committed in SQLite. With the row pre-filled to 10 000, the gateway answered 429 `quota_exceeded` naming the ceiling and the 00:00 UTC reset, with a finite positive `retry-after` ≤ 86 400, `artifactServed` and `brokerInvoked` both 0, and the refused request itself counted (`requests = 10 001`, `denied = 1`); clearing the day made the same request answer 200. A 1 048 649-byte body with `Content-Length` answered 413 `body_too_large`, and the same payload streamed with no `Content-Length` also answered 413 — the streaming cap, which a `Content-Length` check alone would miss. Storage is reported in logical bytes with the disclosure that says so, the limit equals `DEFAULT_LIMITS.storageBytes`, and one record moved it by under 2 kB. Build slots: the second job for one app was not claimed and the authority itself refused it (`Another job is already running for this app`); two apps ran concurrently; the third was refused with `2 at a time`, stayed queued through a tick, and moved the moment a slot freed. Suspension: 423 for everybody including the owner, and after resume the record fingerprints, the grant rows, the release rows, the artifact verification and the logical byte count were all identical to before, on the same release. Sessions ended with reason `operator`. A publish for a suspended app was refused at admission with `suspended` |
| Pass / fail | **Pass** |
| Limitations | The 429 is produced by pre-filling the counter, not by making ten thousand requests. Build-slot concurrency is exercised by claiming jobs rather than by two processes racing; W7's own suite covers the fence and lease paths. CPU-millisecond and subrequest ceilings are not enforced here at all — see gate 5 |

## Gate 7 — acknowledged work survives a reopen; retries do not duplicate

| Field | Value |
| --- | --- |
| Requirement | PLAN-R3 §3.7; gap rows G03, G04, G18 |
| Input | Records created through the real gateway and broker; four grants (direct, invited, and one revoked); then `closeAllAppData()` + `closeAuthority()` and `openAuthority()` again; then a write id retried before and after that reopen |
| Expected | Apps, grants (including the revocation), releases, records, quota counters and events all present after the reopen; a retried write id answering with the record it already made and marking itself a replay; the same behaviour across the reopen; the same write id with different content refused |
| Actual | Two records and four grants were acknowledged and were on disk. A retry of a write id answered 201 with `x-zenith-replayed: true`, the same record id, version 1, and no new row. After closing both connections — `authorityOpen()` confirmed false — and reopening, every list matched byte for byte: app ids, `id:role:state` for all four grants, `id:status` for the release, the day's request counter, the event count, the `id:title:version` of every record, and the logical byte total; the app still pointed at the release it was serving, the same cookie still served 200, and the artifact still verified. The lost-ACK case — a write committed, then the connections closed and reopened, then the same write id retried — answered 201 `x-zenith-replayed: true` with the same record id and one row, and exactly one `writes` ledger row for that id. The same write id with different content answered 409 `idempotency_conflict` |
| Pass / fail | **Pass** |
| Limitations | **Closing a database is not a crash, and a crash is not power loss.** This gate establishes that the durable state is in the files and is read back correctly; it says nothing about `fsync` behaviour under a host that loses power, and nothing about a torn write. `synchronous=FULL` and WAL are asserted at open time by the authority itself (W1), not measured here |

## Gate 8 — a compatible update leaves the data alone; stale writes are explicit

| Field | Value |
| --- | --- |
| Requirement | PLAN-R3 §3.8; gap rows G18, G24 |
| Input | Three real publishes of `fixtures/tracker-app`: the fixture itself, then a tarball with one trailing newline added to `README.md`, then a tarball with a `<meta>` added to `index.html`. Records written under release 1, one of them already at version 2 |
| Expected | Release 2 from changed source with a different source digest; because `README.md` is not emitted, the same artifact, joined rather than created, and re-verified; release 3 with a genuinely different artifact; every record unchanged across both updates; a stale write answered 409 carrying the current record |
| Actual | Release 2's source digest differed from release 1's while its artifact digest was identical, `artifactReused` was true, and the job log contains "re-verified"; the app moved to fence 2 and release 1 became `superseded` with a `supersededAt`. Release 3's artifact digest differed, `artifactReused` was false, both artifacts verified, and the served HTML contained the new `<meta>`. The record fingerprint — `id|title|vN|updatedAt` for all three records, including the one at version 2 — was identical before release 2, after release 2 and after release 3. Every release was built for schema 1 and the app's data stayed at `LATEST_TRACKER_SCHEMA_VERSION`. The conflict: the owner moved the record to version 3, the editor's write against version 2 answered 409 `stale_version` with `details.expectedVersion: 2`, `details.current.version: 3`, `details.current.quantity: 4` and `updatedByEmail` naming the owner; the refused patch was not applied and its write id was not reserved, so the rebase at version 3 succeeded to version 4; a `record.conflict` event was recorded |
| Pass / fail | **Pass** |
| Limitations | "Compatible" here means one data schema throughout — the tracker contract is frozen at v1, so a schema-changing update has nothing to test yet. The two editors are sequential calls in one process, not two browsers racing; the compare-and-swap under real concurrency is W3's `conflict.test.ts` |

## Gate 9 — a failed candidate cannot replace a healthy release; rollback ≠ restore

| Field | Value |
| --- | --- |
| Requirement | PLAN-R3 §3.9; gap rows G08, G09, G24 |
| Input | Two releases with records written under each; a third publish run with `setReleaseDepsForTests({ runtime })` wrapping the **real** `LocalRuntime` and returning `ok: false` from `probeCandidate` only; then a rollback to release 1 and a roll forward to release 2 |
| Expected | The failed candidate never activated, the pointer and fence unmoved, the previous release still serving its own bytes; the failed release not a rollback target; a rollback keeping every record, including those written after release 2 went live |
| Actual | The injected probe failure produced a job `failed` in phase `probe`, whose error names `index_fetch` and says the app is "still serving its previous release". The candidate took release number 3, is `failed`, carries `probe.ok: false` and has no `activatedAt`. The app's `activeReleaseId` and `activeFence` were unchanged, and `GET /` still returned release 2's bytes (`content="r2"`). `admitRollback` to that failed release was refused synchronously with *only a release that passed its health probe*. After two more records were written under release 2, the rollback to release 1 succeeded: the pointer moved to release 1 at fence 3, release 2 became `rolled_back` (not `superseded`), `GET /` returned `content="r1"`, and all four records — the two written before release 2 and the two written after it — were present with their versions unchanged. Rolling forward to release 2 succeeded and the four records were still there |
| Pass / fail | **Pass** |
| Limitations | The probe failure is injected; a candidate that is genuinely broken in a way the real probe catches was not built, because the source contract's build step cannot produce one on demand. The wrapper delegates staging, activation, cleanup and `readBindings` to the real runtime, so only the probe's verdict is synthetic. Rollback was exercised on one host with one runtime |

## Gate 10 — clean-directory restore with revocation reconciliation

| Field | Value |
| --- | --- |
| Requirement | PLAN-R3 §3.10; gap rows G21, G22, G23, G27 |
| Input | A published app with owner, editor and viewer grants, live sessions and three records; one revocation before the snapshot and one after it, both carried off-host by the real `revocation_ledger` outbox handler; `createBackup()` to a `FilesystemTarget`; two restores into empty directories, one with the ledger and one against an empty target |
| Expected | An encrypted bundle without artifact bytes; a restore that re-applies the revocation the snapshot predates and keeps the revoked subject denied through `resolveAppSession` and the gateway; with no ledger, every grant `needs_reapproval`, the app `recovering`, the gateway 423 and `reopenApp` refusing until acknowledged |
| Actual | The bundle held `control.sqlite`, `apps/<id>/data.sqlite` and `artifacts.json`, with `includesBytes: false` and a note saying the bytes are *NOT in this bundle*; `revocationSeq` was 1 and `keyId` an 8-hex label. The off-host ledger held exactly two lines, the second naming the editor's grant. The restore reported `evidenceComplete: true`, `cutoffSeq: 1`, `ledgerMaxSeq: 2` and re-applied exactly the editor's grant; three records came back; every session was ended; the restored directory holds a report naming the backup and its limitations, and the restored control database has one `restore.completed` event. Reopening the authority in the restored directory: the editor's grant reads `revoked`, the owner's and viewer's read `active`, `resolveAppSession` on the editor's old cookie answered null, the gateway answered 401 with the sentinel at zero, and `createExchange` refused them. The owner launched afresh and was served release 1 with all three records. Against an empty target: `ledgerAvailable: false`, `evidenceComplete: false`, three grants held, one app recovering, `grantsByState.active === 0`, records intact; the app read `recovering` with a reason naming the off-host ledger, the gateway answered 423 with a fix mentioning re-approval, and `createExchange` refused even the owner. `reopenApp` refused twice with `recovering` and listed the held grants by address; with `acknowledgeReapproval: true` every check passed and the app became `active` — while every grant stayed `needs_reapproval`, so the app then answered 401 for lack of a grant rather than 423 |
| Pass / fail | **Pass** |
| Limitations | **Artifact bytes are not in the bundle.** This run pins `ZENITH_ARTIFACT_DIR` to one directory both installs read, which models an operator restoring the control database next to object storage that survived. That arrangement is asserted to work; it is not proof that a restore onto a genuinely new host with a separately restored artifact store works, because no second host exists. The backup target is a local filesystem directory, not S3 or LocalStack. The "clean host" is a new directory in the same process on the same machine |

## Gate 11 — real health and logs with release attribution

| Field | Value |
| --- | --- |
| Requirement | PLAN-R3 §3.11; gap row G28 |
| Input | A published app with a write, a refused viewer write and a stale write; `appHealth`, `/_zenith/health` on the app host, and `appLogs`; then one flipped byte in the stored artifact |
| Expected | `simulated: false`, the serving release, six checks that each read something; a red `artifact_verified` after tampering and green again after restoring; `/_zenith/health` carrying the release; logs carrying release ids and no record contents; the infrastructure product's simulated health still labelled simulated |
| Actual | `appHealth` reported `simulated: false`, `state: active`, the release as `{id, number, digest}`, the runtime labelled "single machine", and the six checks `authority_row`, `active_release`, `artifact_verified`, `data_quick_check`, `schema_version`, `records` — all green, with `artifact_verified` saying it re-hashed the stored bytes and `records` reporting "1 equipment request". The event digest counted one write, at least one denial and at least one conflict, and the quota block matched the real counter row. `/_zenith/health` answered 200 with `x-zenith-release`, `simulated: false`, the release triple, and both of its checks green. After flipping one byte, `appHealth().ok` was false with `artifact_verified` red and *does not match its own manifest*, `data_quick_check` still green (the failure is localised), the release still named, and the app-host route still 200 with the check red — a result, not an error. Restoring the byte returned it to green. `appLogs` lines all begin with their timestamp, carry this app's release id where the event had one, contain neither the record's distinctive title nor the owner's address, and show `record.created ok` and `access.denied denied`; the event table itself contains neither either. An app id that does not exist answered `ok: false` with `authority_row` red rather than throwing |
| Pass / fail | **Pass** |
| Limitations | The contrast with the infrastructure product's simulated health is asserted on source text — `src/app/api/health/[envId]/route.ts` declares `simulated: true`, and the two hosted modules declare `simulated: false` and never the opposite outside a comment. Calling that route needs a signed-in workspace request this suite does not build, so the label is verified, not the response. "Logs" are the app's own event rows, not the server's stdout; nothing here checks what the Node process writes to its own log |

## Gate 12 — the recipient's journey in a fresh browser

| Field | Value |
| --- | --- |
| Requirement | PLAN-R3 §3.12; gap rows G29, G30 |
| Input | `fixtures/tracker-app` published for real; a loopback `http.createServer` adapting Node requests into `NextRequest` and calling `handleGateway` with `Host: alpha.apps.localhost:<port>`; Google Chrome 152 driven by `playwright-core` at 1280×800 and 375×812 |
| Expected | The app renders; the `__Host-` cookie is accepted on `http://*.localhost`; a request created from the keyboard alone; the request surviving a reload; a conflict shown with the draft preserved when a second identity writes first; the next navigation refused after a revocation; zero console errors |
| Actual | `npx tsx scripts/hosted-browser.ts` exited 0 with 24 of 24 steps passing, 12 at each width. Chrome accepted the `Secure; HttpOnly; Path=/` `__Host-zenith_app` cookie on `http://alpha.apps.localhost:<port>` — recorded here because it is the one browser behaviour the design depends on and could not be assumed: `secure=true httpOnly=true path=/`. The heading read "Alpha equipment tracker" and the footer named the serving release. Tab reached the "New request" control within 40 stops, Enter opened the form, focus moved to `#new-title`, typing and Enter created the record, and it was still there after a reload. A second identity's PATCH through the broker answered 200; saving the open draft then showed `.conflict[role=alert]` reading "Someone changed this while you were editing … saved version 2", and `#edit-title` still held the unsaved edit. After `revokeGrant`, the next navigation landed on the sign-in page. Console errors: 0, page errors: 0, at both widths. The in-process half (`gate-12-browser-flow.test.ts`, 11 tests) walked the same journey over a real socket: 303 + host-locked cookie, the built page and its hashed asset byte-identical to the store with the right cache policy, a cross-origin write refused and a same-origin one accepted, a 409 carrying the current record, 303 to the sign-in page after a revocation, 404 for the control origin's Host, and the statuses observed by the adapter were exactly `{303, 200, 403, 201, 409, 401, 404}` with no 599 |
| Pass / fail | **Pass** |
| Limitations | One engine (Chromium, as Chrome 152) on one operating system. No Firefox, no Safari, no real mobile device — 375px is an emulated viewport, not a phone. Two console messages per run are the browser reporting the 401/403/409 statuses this journey deliberately provokes; they are counted and reported separately and are not treated as errors. The journey runs against a loopback server with a self-managed port, not against `next start` behind the middleware rewrite. No screen reader was used; keyboard reachability is not the same as accessibility |

---

## What remains unproven

These are not gaps in the suite; they are the boundary of what this machine can
establish today. Each is a claim nobody should make on the strength of this
record.

**Providers.** Cloudflare Workers for Platforms, D1 and the edge broker were
never executed — no account, no `ZENITH_CF_API_TOKEN`. E2B and Docker builds
were never executed. No email was ever delivered: the invitation path was
exercised with no SMTP configured, so "sent" was never distinguishable from
"delivered" in a live run. The backup target was a local directory; S3 and
LocalStack were not used. Every gate above therefore describes the **local**
runtime and the **recipe-local** build runner, both of which name their own
boundaries in the artifacts they produce.

**Identity.** No recipient signed in through a real identity provider on the
control origin. `acceptInvite` and the launch path were driven with
`VerifiedIdentity` values, which is what `verifyRequestIdentity` would return
after a live `auth.getUser()` round trip — but the round trip itself, and the
behaviour of a terminated Supabase session, are untested here. Gate 2's "second
identity" is a real second subject with no membership and no grant; it is not a
real second person with a real account.

**Durability under failure.** A process kill is not power loss and closing a
connection is not a crash. Gate 7 proves the acknowledged state is in the files
and reads back; it does not prove behaviour across an unclean shutdown, a torn
write, a full disk or a filesystem that lies about `fsync`. No fault injection
at the storage layer was performed.

**Scale and tenancy.** One host, one process, one machine. Two apps on one
install is not two tenants on two hosts. Nothing here was run under concurrent
load; the quota boundary was exercised by pre-filling a counter, not by traffic.

**The browser.** One engine, one operating system, two emulated widths. No
assistive technology, no touch device, no slow network, no third-party cookie
policy other than Chrome's default.

**Restore onto a new host.** Gate 10 restores into an empty directory in the
same process, with the artifact store shared by configuration. An operator
restoring onto hardware that has never held this install would additionally have
to restore or re-point the artifact store, and that step is modelled here rather
than performed.

**Security.** This is an adversarial acceptance suite written by the same
project, not an independent security assessment. It encodes the attacks it
thought of.

## Adversarial probes that found nothing

Recorded because a negative result is only evidence if the attempt is written
down. Each of these was tried against the real modules and behaved correctly;
the ones worth keeping were folded into the gates above.

- A conditional request (`If-None-Match: *`) from an unadmitted caller: 401, not
  304, and no artifact read.
- Case-varied artifact paths (`/ASSETS/INDEX-….JS`): 404. `FsArtifactStore.open`
  matches the manifest exactly before it touches the filesystem, so a
  case-insensitive disk is not a way past the path table.
- A tampered `state` on the exchange callback, and a code minted for one app
  presented on another's host: both bounce to the sign-in page, set no cookie,
  and consume the code so it cannot be replayed at the right place.
- A body over the cap sent with no `Content-Length` (chunked): 413 from the
  streaming counter, not just from the header check.
- Requests to hosts that resolve to no app (unknown slug, the control origin, an
  unrelated hostname): 404, and none of them counted against any app's quota.
- `X-HTTP-Method-Override`, `X-Method-Override` and `?_method=`: all ignored;
  the request stayed a `GET` and nothing was created.
- Sign-out scope: signing out of app A did not end app B's session, while
  `terminateAppSessionsForSubject` ended both.
- A response arriving at the guard carrying `set-cookie`, `location` and
  `access-control-allow-origin`: all three stripped.
- `HEAD /_zenith/session` and `OPTIONS /`: 405 with an accurate `allow`, rather
  than a partial answer.
