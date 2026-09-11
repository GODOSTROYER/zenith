# Hosted threat model — page-47 families mapped to Revision 3

Prepared 2026-09-07 by W11 against `ffb2753` on `zenith/hosted-r3`.

The source is the commercial-security addendum on page 47 of the YC W27
execution plan, as read and summarised by the gap analysis of 2026-09-07. That
addendum describes **design risks, not confirmed exploitable vulnerabilities**
in the current application. Nothing below should be read as a report of a live
defect in Zenith today; the hosted surfaces these threats apply to do not yet
exist.

**Status of the "test that proves it" column.** At the time of writing, the
repository contains `src/lib/hosted/config.ts` and
`src/lib/hosted/contracts/**` and nothing else under `src/lib/hosted/`. Every
module path below is the **planned** location from
[PLAN-R3.md](PLAN-R3.md) §2 and [CONTRACTS-R3.md](CONTRACTS-R3.md), and every
test is a test that must exist and pass, not one that has. A control with a
planned test is an intention. Zero of the twelve acceptance gates in
[PLAN-R3.md](PLAN-R3.md) §3 have been demonstrated.

## 1. Access-boundary failure

An unauthorised, uninvited, revoked or wrong-app identity reaches a private
app's pages, assets or data.

| Threat | Control (planned module) | Test that would prove it | Residual risk |
| --- | --- | --- | --- |
| Unknown host reaches an app | Host → app resolution from the authority; middleware stamps `x-zenith-gateway`, an unstamped direct request is 404 (`src/lib/hosted/gateway/**`, `src/middleware.ts`) | `tests/hosted/gateway`: unknown host 404; direct-origin request without the stamp 404 | A reverse proxy that forwards a client-supplied stamp defeats it. The proxy requirement is documented ([RUNBOOK-DEPLOY.md](RUNBOOK-DEPLOY.md) §3), not enforced by code. |
| Signed-in stranger gets access | App grants are separate from workspace roles; `ensureMember` no longer re-grants from `app_metadata.role` in hosted mode (`src/lib/hosted/access/**`, `R3-02`) | `tests/hosted/access`: full owner/editor/viewer/uninvited matrix; a workspace admin gets no app data access | Workspace membership still lives in the legacy JSON store. The claim that there is one authority for *app access* rests on the hosted-mode rule holding on every path. |
| Revoked user keeps working | Revocation commits before acknowledgement and terminates the grant's app sessions in the same transaction; every protected request re-checks the live grant with no positive caching (`access/**`, `gateway/**`, `R3-10`) | `tests/hosted/access`: next new page/asset/API request denied after revoke; old session denied after sign-out | **Bytes already delivered cannot be recalled.** A page loaded one second before revocation keeps running in the browser until it makes its next request. The control authority and a per-app database are not one transaction, so there is a bounded in-flight window between revoke and the next write being refused. Both must be disclosed, not designed away. |
| Admission bypassed on assets, HEAD or ranges | Admission runs before any artifact read or broker call, including HEAD and Range (`gateway/**`, `R3-03`) | Invocation-sentinel tests: on denial, the artifact reader and broker are never called | A CDN or proxy cache in front of an app host serves private bytes without asking. No caching is a deployment requirement. |
| Cross-domain session theft | App hosts are a different registrable domain; platform cookies are never read there; the app session is an opaque `__Host-zenith_app` cookie; launch is a 60-second single-use exchange bound to app + subject + state (`access/**`, `R3-09`) | `tests/hosted/access`: state/origin/app-binding, replay, expiry, concurrent redemption | Depends on the two domains actually being separate registrable names in the deployment. Defaults (`localhost` / `apps.localhost`) do not satisfy that. |
| Sibling-app CSRF | Mutations require an exact `Origin`; wildcard credentialed CORS and GET/HEAD mutations are rejected (`gateway/**`, `data/**`) | Spoofed-context and sibling-app mutation tests | Same-origin scripts inside an app are inside the boundary by design — see §7. |
| Session survives sign-out | Grant-sensitive endpoints verify with `auth.getUser()`, a live round trip; platform sign-out terminates app sessions before responding (`R3-10`) | An integration test using a token issued **before** sign-out, against the deployed Auth version | Not yet run against any deployment. A method choice is not this test. |

## 2. Hostile code and dependencies

Submitted source, or a dependency of it, executes where it should not.

| Threat | Control (planned module) | Test that would prove it | Residual risk |
| --- | --- | --- | --- |
| Submitted build script runs on the control host | Source contract v1 accepts a React + Vite frontend only and builds it with the **platform's** pinned recipe; submitted `vite.config.*`, `scripts`, extra dependencies and lockfiles are rejected at intake, never executed (`source/**`, `build/**`, `R3-04`) | Runner-boundary tests; hostile fixture suite | The recipe still processes attacker-influenced *source text* through esbuild/rollup. A parser or plugin vulnerability is a real, unmitigated path. |
| Archive traversal, symlinks, zip bombs, oversize input | Tar intake with traversal/symlink/size/decompression checks and a pinned source digest (`source/**`) | Hostile fixture suite: each rejection is a named error | Unknown-unknowns in archive handling. Fixtures cover what was thought of. |
| Build reads platform secrets | Clean environment per build; scoped tokens per role (publisher / build / runtime); no platform secret in the build environment or the artifact (`build/**`, `R3-05`; register row G25) | Build-environment inspection test: the child process environment contains no `ZENITH_*`/`ZENITH_*` secret | `recipe-local` runs on the control host. Process isolation is not VM isolation, and the runner is labelled *not a hostile-code sandbox*. Do not select it for a deployment serving anyone but the founder. |
| Build reaches the network | Bounded network and time in the runner (`build/**`) | Egress tests where the runner can enforce them | The local runner cannot enforce egress on this host. E2B's default network access is **open**, and its allowlisting has documented shared-hosting and protocol caveats. Both remain live gates. |
| A tampered artifact is served | Content-addressed store (`sha256/<digest>`), create-only, overwrite refused, provenance manifest, separate publisher verification recomputing the digest over bytes (`artifacts/**`, `R3-06`) | Tamper and overwrite rejected; stale publisher cannot activate | **A digest proves byte identity, not safety.** A faithfully reproduced malicious bundle has a perfect digest. Provider-side overwrite protection depends on the Cloudflare gates in [PROVIDERS.md](PROVIDERS.md) §1. |
| The simulated digest is mistaken for integrity | The Sandbox FNV display value keeps its `simulated` label and never becomes release evidence (`R3-06`) | Existing provider labelling tests | Only as strong as the labelling discipline in the UI. |
| Editable code reaches a database | The fixed per-app broker owns the per-app database; editable code receives no database, dispatch, service or admin binding; `/_zenith/data/*` is reserved (`data/**`, `gateway/**`, `R3-03`) | Broker A cannot open database B; editable path holds no data capability | On Cloudflare this depends on binding readback, which is an open gate. |

## 3. Privileged compromise

An operator credential, or the platform itself, is misused.

| Threat | Control (planned) | Test that would prove it | Residual risk |
| --- | --- | --- | --- |
| Operator account takeover | MFA, least privilege, scoped credentials per role, support-access logging, compromise drill — [OPERATOR-ACCESS.md](OPERATOR-ACCESS.md) | **None.** This is a policy and process control with `unknown` owners; no code proves it. | Entirely unmitigated today. G26 is `Unverified` and stays that way until the checklist is filled in and drilled. |
| One key opens everything | `ZENITH_BACKUP_KEY` is distinct from `ZENITH_SECRET_KEY` (`R3-11`) | Backup/restore tests using a key that cannot decrypt the secret store | Custody for both is `unknown`. The existing secret store has no rotation tooling and no re-wrap command: values written under an old key cannot be read back. |
| Audit trail edited on the host | Off-host revocation ledger appended on every revocation (`backup/**`, `R3-11`) | Restore reconciliation test | An append-only file **on the same host is not tamper-resistant** and must never be described as such. Off-host tamper-resistant audit (`ATT-TRUST-02`) is `not started`. |
| Support access to customer data | Logged, minimised, disclosed — [OPERATOR-ACCESS.md](OPERATOR-ACCESS.md), [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) | None yet | A privileged operator has legitimate plaintext access. See §7. |

## 4. Loss and unsafe restore

| Threat | Control (planned module) | Test that would prove it | Residual risk |
| --- | --- | --- | --- |
| Host loss destroys everything | WAL-safe `sqlite.backup`, AES-256-GCM, off-host target (`backup/**`, `scripts/hosted/backup.ts`, `R3-11`) | Backup taken under concurrent writes, restored and verified | No off-host target is configured. LocalStack is on this machine. No backup has ever been restored. |
| Restore resurrects a revoked grant | Off-host revocation ledger reconciled on restore; grants that cannot be confirmed become `needs_reapproval` and the app stays closed (`backup/**`, `R3-11`) | Restore an older snapshot; the revoked user is still denied | Depends on the ledger reaching the off-host target at revocation time. A revocation that failed to append must be surfaced, or reconciliation silently under-reports. |
| Rollback rewinds customer data | Rollback selects a compatible release without touching data; destructive schema changes rejected at intake (`release/**`, `R3-07`) | Failed candidate keeps the old release; code rollback retains records | Schema compatibility is checked against reviewed additive changes only; anything else is refused rather than migrated. |
| Recovery targets unmet | Procedure in [RUNBOOK-DEPLOY.md](RUNBOOK-DEPLOY.md) §6 | A timed drill on a clean host | RPO and RTO are **`unknown until drilled`**. The plan's <=24 h / <=4 h are proposals. Do not quote them. |
| Key lost | Independent custody | Key-recovery rehearsal | Custody `unknown`, rehearsal never done. Losing `ZENITH_BACKUP_KEY` makes every backup unreadable, permanently. |

## 5. Outage and resource abuse

| Threat | Control (planned module) | Test that would prove it | Residual risk |
| --- | --- | --- | --- |
| One app exhausts the host | Requests/day counter (every request resolving to a known app host, 00:00 UTC reset, persisted, atomic), 1 MB body cap, logical storage bytes, 1 build per app / 2 pilot-wide, 5-minute build timeout, suspension that preserves data (`quota/**`, `R3-12`) | Boundary and race tests; suspension keeps data, grants and artifacts | **CPU (50 ms) and subrequest (5) limits are not enforced by the local runtime** and are shown as provider limits. Storage is *logical bytes*, not physical database size. Both are disclosed contracts, not silent substitutions. |
| Spend runs away | Usage ledger, 50/75/90 % alerts against `ZENITH_SPEND_ENVELOPE_USD`, new builds paused at the threshold while running apps keep serving (`usage/**`, `R3-12`) | Threshold tests | **Provider invoices lag.** Correct application quotas do not promise a bill ceiling, and the $300 envelope is unapproved. |
| Single host falls over | None. One process, one volume, by design. | — | **There is no high availability and none is claimed.** A host failure is an outage until the restore in [RUNBOOK-DEPLOY.md](RUNBOOK-DEPLOY.md) §6 completes. |
| Identity provider outage opens the door | Fail-closed: grant-sensitive endpoints answer 503 rather than falling back (`R3-10`, runbook §4) | Outage-behaviour tests with the identity service unavailable | Existing app sessions continue to be served during an Auth outage — a deliberate asymmetry that must be stated, not marketed as availability. |
| Health looks real when it is synthetic | Real probes with release attribution; the existing simulated health keeps `simulated: true` (`health/**`; register row G28) | Health route tests; mixed-provider labelling tests | Labelling discipline, again, is a convention enforced by tests rather than by types. |

## 6. Data lifecycle and exit

| Threat | Control (planned module) | Test that would prove it | Residual risk |
| --- | --- | --- | --- |
| Customer cannot leave | Export bundle: source, artifacts, schema, records and access manifest, with a documented import (`export/**`; register rows G21, G27) | Round-trip: import into a clean data directory, counts and content checked | A Worker/D1 exit package is unproven; **CSV alone is not portability**. |
| Deletion is claimed but incomplete | Deletion of primary records, logs, exports and backup expiry defined as a separate lifecycle — [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) | None yet | Retention windows are `unknown`. **Backups retain deleted data for their retention window**; that window must be disclosed rather than described as immediate erasure. |
| Region and subprocessors unknown to the customer | Provider/region/exposure map — [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) | None | Control host region is `unknown`. Supabase Auth is recorded as `ap-south-1` from the project's own notes, **not re-verified from the dashboard in this session**. |

## 7. Residual trust that survives every control above

Carried from the gap analysis §8, because implementing all of the above does
not remove it:

- **Authorised frontend code can misuse the data it is allowed to read.** The
  broker enforces who may read what; it cannot enforce what already-authorised
  code does with the answer.
- **HttpOnly protects cookie *readability*, not every same-origin action.** A
  script running on the app host acts as the signed-in user within the
  boundary the session already grants.
- **A digest proves byte identity, not safety.** Reproducibility is not
  review.
- **Encryption at rest is not end-to-end encryption.** It protects the disk,
  not access by the running service.
- **A privileged operator, and the hosting provider, can legitimately reach
  plaintext.** A customer who requires that Zenith *cannot* read their data
  needs a different encryption and key-ownership design, not a stronger
  sentence on a page.

Two further limits on this document itself: independent agent review of a
patch is useful engineering evidence but is **not** the independent commercial
security assessment page 47 asks for (G35, `Unverified`), and a provider's
certifications do not transfer to Zenith.
