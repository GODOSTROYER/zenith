# Zenith hosted apps — Revision 3 implementation plan

Prepared 2026-09-07 by the integrator (Claude) against `ffb2753` on branch
`zenith/hosted-r3`. Input: the 45-row gap register in
`zenith-gap-register.{csv,json}` and the full gap analysis of the same date.
The 47-page YC W27 execution-plan PDF was **not** supplied to this session (the
attached PDF was an unrelated handwritten answer booklet, SHA-256 `aad69f82…`),
so every page mapping below is inherited from the gap analysis, not re-read.

**Objective.** Close every register row that code can close, on this machine,
with real behaviour and executable evidence — and turn every row that needs a
provider account, a customer or a founder decision into a gated, honest,
ready-to-flip path with a written checklist. No simulated success anywhere in
the hosted path.

## 0. Decisions taken by the integrator (state them, do not relitigate)

| # | Decision | Why | Register rows |
| --- | --- | --- | --- |
| R3-01 | **Control authority = SQLite through `node:sqlite`** (`DatabaseSync`), file `<ORRERY_DATA>/control.sqlite`, WAL + `synchronous=FULL` + foreign keys + `busy_timeout`. Minimum Node `>=22.16` (backup API). No native module. Verified today under Next 15.5 turbopack (`node:sqlite` loads; SQLite 3.53.3 on Node 24.19). | The feasibility probe already passed on Node 22 and 24; zero native-build risk on Windows; the same engine as D1, so per-app SQL is portable. | G03, G04, G22 |
| R3-02 | **Hosted app access lives only in SQLite.** App grants, invites, sessions, exchanges, jobs, releases, quotas, events. The legacy JSON store keeps the infrastructure product (workspaces, projects, deploys). Hosted publish additionally requires a workspace `editor`+ role read live through `workspaceRole()`; that read is never cached. In hosted mode (`ZENITH_HOSTED_MODE=1`) `ensureMember` no longer re-grants from `app_metadata.role` and never promotes a signed-in stranger. | A full workspace-membership migration touches every route of the existing product for no hosted benefit; the plan's actual requirement is that *app access* has one transactional authority and that claim-driven re-grant cannot undo a revoke. | G03, G10, G13 |
| R3-03 | **Two runtimes behind one `HostedRuntime` interface.** `local`: the control service itself serves immutable artifacts and runs the fixed broker against per-app SQLite files (real, single host, labelled). `cloudflare`: Workers for Platforms dispatch + D1 + fixed broker worker, real API calls, registered only when `ZENITH_CF_ACCOUNT_ID`/`ZENITH_CF_API_TOKEN`/`ZENITH_CF_NAMESPACE` exist, otherwise reported as *blocked* naming the missing input. Gateway admission logic is shared and runtime-agnostic. | No Cloudflare credentials exist on this machine. The full journey must still be provable end to end today with real durability, and the same policy code must run at the edge later. | G02, G14, G15, G16, G33, G34 |
| R3-04 | **Supported source contract v1: React + Vite frontend only, built by the platform's own pinned recipe** (`vite@7.3.6`, `@vitejs/plugin-react@5.1.4`, `react@19.1`). Submitted `vite.config.*`, `scripts`, extra dependencies and lockfiles are rejected as unsupported input, never executed. Optional editable backend handlers are deferred (month-one fallback scope). | Removes untrusted code execution from the build step entirely: the recipe runs esbuild/rollup transforms, never the app's code. That is what makes the same-host runner honest. | G01, G05, G06 |
| R3-05 | **Three build runners.** `recipe-local` (child process, clean env, timeout, memory cap; **same host** — allowed only with `ZENITH_BUILD_RUNNER=recipe-local`, labelled as not a hostile-code sandbox), `e2b` (real SDK, gated on `E2B_API_KEY`), `docker` (gated on daemon). Hosted mode refuses to build when no runner is configured. | G06 asks for isolation proof; without a provider account the honest answer is a real runner that names its boundary, plus real adapters for the isolated services. | G06, G25 |
| R3-06 | **Artifacts are content-addressed** (`sha256/<digest>`), immutable (create-only, overwrite refused), with a provenance manifest (source digest, recipe/toolchain versions, contract version, schema version, job id, builder). A separate publisher verification step recomputes the digest over bytes before any release may reference it. The Sandbox FNV display digest is untouched and stays labelled simulated. | G07 |
| R3-07 | **Release = immutable record + durable active pointer.** Publish is a durable job (UUID from client, intent SHA-256, phases persisted, lease + fence token). Candidate health probes run against a **separate test database**; production schema is checked read-only. Activation is a single compare-and-swap on the pointer with the fence token. Rollback selects a compatible release without touching data; destructive schema changes are rejected at intake. | G04, G08, G09, G24 |
| R3-08 | **Tracker data contract v1** (equipment requests) is frozen in `src/lib/hosted/contracts/tracker-v1.ts`: fields, limits, enums, list bounds, conflict payload, write-id retention (30 days). Records carry `version`; update requires `expectedVersion` and answers 409 with the current record. Write ids, intent hash and result are stored in the same transaction as the mutation. Logical byte quota (100 MB, disclosed as logical bytes of stored fields) is maintained in that transaction. | G01, G17, G18, G19 |
| R3-09 | **Domains.** Control origin `ZENITH_CONTROL_ORIGIN` (default `http://localhost:3400`); app hosts `<app-slug>.<ZENITH_APP_DOMAIN>` (default `apps.localhost`, which browsers resolve without DNS). App hosts never receive platform cookies; the app session is an opaque `__Host-zenith_app` cookie (Secure, HttpOnly, SameSite=Lax, Path=/). Launch from control creates a 60-second single-use exchange code bound to app + subject + state; redemption is atomic. | G12, G15 |
| R3-10 | **Identity-session authority.** Grant-sensitive control endpoints (launch, publish, grant management, invite acceptance) verify the caller with `auth.getUser()` (a live round trip to Supabase Auth, which rejects a terminated session) rather than `getClaims()` alone. Platform sign-out terminates the subject's app sessions in the authority **before** the sign-out response is sent. Revocation of a grant terminates its app sessions in the same transaction. | G13 |
| R3-11 | **Backups** are WAL-safe (`sqlite.backup`), AES-256-GCM encrypted under `ZENITH_BACKUP_KEY` (distinct from `ORRERY_SECRET_KEY`), written to a `BackupTarget` (`filesystem` dir or S3-compatible bucket; LocalStack S3 gives real off-host evidence locally). Every grant revocation also appends to an off-host **revocation ledger** on the same target, so a clean-host restore can reconcile newer revocations; grants it cannot confirm are marked `needs_reapproval` and the app reopens only after an operator check passes. | G21, G22, G23, G27 |
| R3-12 | **Quota semantics are application-enforced and disclosed as such.** Requests/day counts every request that resolves to a known app host (after unknown-host 404), whatever the outcome; reset 00:00 UTC; persisted; atomic. Body limit 1 MB checked by `Content-Length` and a streaming cap. Storage = logical bytes. Builds: 1 concurrent per app, 2 pilot-wide, 5-minute timeout. CPU 50 ms and 5 subrequests are **not enforced by the local runtime** and are shown as "provider limit (Cloudflare) — not enforced here". Suspension blocks admission and keeps data, grants and artifacts. | G19, G20 |
| R3-13 | **Analytics events** are a durable table with the p.36 envelope as far as the gap analysis describes it (event, ts, workspace, app, pseudonymous subject hash, release, outcome, logical operation id, assisted flag, actor class founder/test/external). The exact eleven event names could not be read from the PDF; the set defined in `contracts.ts` is marked provisional and must be reconciled when the PDF is available. | G31, G38 |
| R3-14 | **Founder/commercial rows (G26, G35–G41, G45) are not closable by code.** This wave ships the templates, ledgers and scorecard queries with every value `unknown`, so they can be filled honestly. | — |

## 1. Gap register → workstream map

| Gap | Owner | What closes it in this wave | Evidence |
| --- | --- | --- | --- |
| G01 | W0 | `contracts/tracker-v1.ts`, `contracts/source-v1.ts`, fixture `fixtures/tracker-app` | contract tests accept the fixture, reject unsupported inputs |
| G02 | W6 | `runtime/local` (real), `runtime/cloudflare` (real API, gated) | two apps served on distinct hosts locally; CF adapter blocked-with-reason |
| G03 | W1 | SQLite authority, commit-before-ACK transaction helper | crash/lost-ACK tests, busy writer test, reopen test |
| G04 | W1+W7 | `hosted_jobs` + outbox + leases + reconciliation | restart-and-retry same intent → one effect; changed intent → 409 |
| G05 | W2 | tar intake with traversal/symlink/size/bomb/unsupported checks; pinned source digest | hostile fixture suite |
| G06 | W2 | `recipe-local`/`e2b`/`docker` runners, no submitted script execution | runner boundary tests; e2b adapter contract test with injected SDK double |
| G07 | W2 | content-addressed immutable artifact store + publisher verification | tamper and overwrite rejected |
| G08 | W7 | single-flight per app, fence token, CAS activation | concurrent publish race test; stale worker cannot activate |
| G09 | W7 | candidate probes on separate test DB; read-only prod schema check | unhealthy candidate never active |
| G10 | W5 | app grants owner/editor/viewer, last-owner protection, publish needs workspace role | full role matrix |
| G11 | W5 | hashed 48 h single-use tokens, resend invalidation, encrypted delivery payload, transactional outbox | replay/expiry/resend tests; SMTP sent vs delivered distinction |
| G12 | W5+W6 | exchange + `__Host-` app session, atomic redemption | state/origin/app binding tests; concurrent redemption |
| G13 | W5 | `getUser()` session authority, sign-out terminates app sessions | old session denied after termination/revoke |
| G14 | W6 | gateway admission before any artifact/broker invocation, incl. HEAD/range/assets | invocation sentinel tests |
| G15 | W6 | credential stripping, response guard, CSRF/Origin, CSP, egress policy doc | spoofed context/sibling app tests |
| G16 | W3+W6 | fixed per-app broker, per-app DB, reserved `/_zenith/data/*` | broker A cannot open DB B |
| G17 | W3 | tracker CRUD, validation, bounded reads, durable SQLite | restart persistence test |
| G18 | W3 | record versions, 409 conflict payload, in-transaction write ids | two-editor conflict, lost-ACK replay |
| G19 | W8 | quota counters, body cap, storage bytes, suspension | boundary and race tests |
| G20 | W8 | usage ledger, 50/75/90 % alerts, build pause | threshold tests |
| G21 | W8 | app export/import bundle, restore with counts/content checks | round-trip test |
| G22 | W8 | encrypted WAL-safe backup, key recovery doc, restore script | backup under concurrent writes |
| G23 | W8 | revocation ledger + reconciliation on restore | restored older snapshot keeps revoked user denied |
| G24 | W7 | rollback distinct from restore; schema compatibility check | failed candidate keeps old release |
| G25 | W2+W6 | scoped tokens per role (publisher/build/runtime), no platform secrets in builds | build env inspection test |
| G26 | W11 | operator access policy + drill checklist (template) | manual |
| G27 | W8 | export/import + data lifecycle doc | import into clean data dir |
| G28 | W8 | real health/log probes with release attribution; synthetic stays labelled | health route tests |
| G29 | W9 | publish UX: source → build → private URL, actionable failures, timings | screen tests |
| G30 | W4+W6 | recipient journey: sign in on app host, save, reload, conflict, denied | acceptance journey |
| G31 | W8 | events table, dedupe, cohorts, scorecard excluding founder/test | fixture cohort tests |
| G32 | W10 | twelve-gate local acceptance suite + adversarial suites + CI job | `tests/hosted/acceptance/**` |
| G33 | W11 | deployment runbook (compose + persistent volume, fail-closed) | manual until a host exists |
| G34 | W11 | provider configuration decision record + env matrix | manual |
| G35–G41 | W11 | evidence templates, claim ledger, scorecard with unknowns | manual |
| G42–G44 | W11+W0 | reconcile CHECKPOINT/DECISIONS/requirements; wording fixes | docs |
| G45 | W11 | branch-protection checklist + release evidence template | manual |

## 2. Workstreams, exclusive paths, waves

Every agent writes **only** inside its paths. Shared files (`package.json`,
`src/lib/env.ts`, `src/middleware.ts`, `src/lib/server/boot.ts`,
`src/lib/actions/defs/index.ts`, navigation, `docs/hosted/*.md` outside W11's
list) are integrator-only; agents list needed edits in their final report.

| WS | Agent | Exclusive paths | Wave |
| --- | --- | --- | --- |
| W0 | integrator | `docs/hosted/PLAN-R3.md`, `docs/hosted/CONTRACTS-R3.md`, `src/lib/hosted/contracts/**`, `src/lib/hosted/index.ts`, env/boot/middleware/nav wiring, `package.json` | 0 |
| W1 | authority | `src/lib/hosted/authority/**`, `tests/hosted/authority/**` | 1 |
| W2 | build | `src/lib/hosted/source/**`, `src/lib/hosted/build/**`, `src/lib/hosted/artifacts/**`, `fixtures/hosted/**`, `tests/hosted/{source,build,artifacts}/**` | 1 |
| W3 | broker | `src/lib/hosted/data/**`, `tests/hosted/data/**` | 1 |
| W4 | tracker-app | `fixtures/tracker-app/**`, `tests/hosted/tracker-app/**` | 1 |
| W11 | docs | `docs/hosted/{RUNBOOK-DEPLOY,PROVIDERS,THREAT-MODEL,DATA-LIFECYCLE,OPERATOR-ACCESS}.md`, `docs/hosted/evidence/**`, `docs/hosted/requirements.md` + `.json`, `docs/hosted/CHECKPOINT.md`, `docs/hosted/DECISIONS.md`, `src/lib/importers/dockerfile.ts` wording only | 1 |
| W5 | access | `src/lib/hosted/access/**`, `src/app/api/hosted/apps/[appId]/{grants,invites,launch}/**`, `src/app/api/hosted/invites/**`, `src/app/api/hosted/session/**`, `tests/hosted/access/**` | 2 |
| W6 | gateway | `src/lib/hosted/gateway/**`, `src/lib/hosted/runtime/**`, `src/app/hosted-gateway/**`, `workers/**`, `tests/hosted/{gateway,runtime}/**` | 2 |
| W7 | release | `src/lib/hosted/release/**`, `src/lib/actions/defs/hosted.ts`, `src/app/api/hosted/apps/route.ts`, `src/app/api/hosted/apps/[appId]/route.ts`, `src/app/api/hosted/apps/[appId]/{releases,jobs,publish,rollback,suspend}/**`, `tests/hosted/release/**`, `tests/actions/hosted.test.ts` | 2 |
| W8 | ops | `src/lib/hosted/{backup,export,quota,usage,events,health}/**`, `scripts/hosted/**`, `src/app/api/hosted/apps/[appId]/{export,health,usage,events}/**`, `src/app/api/hosted/ops/**`, `tests/hosted/{backup,export,quota,usage,events,health}/**` | 2 |
| W9 | ux | `src/app/(product)/apps/**`, `src/components/apps/**`, `src/lib/client/hosted.ts`, `tests/screens/apps/**` | 2 |
| W10 | verify | `tests/hosted/acceptance/**`, `scripts/hosted-acceptance.ts`, `scripts/hosted-browser.ts`, `docs/hosted/ACCEPTANCE-R3.md`, `.github/workflows/ci.yml` (add job only), `tests/ci/release-gates.test.ts` | 3 |

Dependency DAG: W0 → {W1, W2, W3, W4, W11} → {W5, W6, W7, W8, W9} → W10 →
integration (W0). W5–W9 import W1's authority and W2/W3's modules through the
interfaces in `contracts.ts`; nothing imports across sibling workstreams
except through those interfaces.

## 3. Acceptance (the twelve gates, run locally by W10)

1. Pinned source → real Vite build → SHA-256 artifact → running app on its own
   host; hostile inputs rejected.
2. Second identity (no workspace membership) signs in on the app host through
   the exchange.
3. Uninvited, revoked and wrong-app identities denied on HTML, assets, API,
   HEAD and range, and on the control origin's direct paths.
4. Broker roles enforced independently of HTTP verb; reserved routes win;
   editable code path holds no data capability.
5. No platform secret reaches a build or an artifact; CSP present; egress
   policy documented and tested where the runtime can enforce it.
6. Quotas, timeouts, single-flight and suspension.
7. Acknowledged records and grants survive an authority reopen; retried
   writes do not duplicate.
8. Data survives a compatible update; stale write → explicit 409.
9. Failed candidate cannot replace a healthy release; rollback ≠ restore.
10. Clean-directory restore with revocation reconciliation; revoked user stays
    denied.
11. Real health and logs carry release ids; synthetic results stay labelled.
12. Fresh-browser recipient flow, keyboard and mobile widths, no console errors.

Each record: date, source SHA, environment, tester (agent id), input, expected,
actual, artifact path, limitations.

## 4. What stays blocked after this wave (honest list)

Live Cloudflare/D1 execution, E2B or Docker isolated builds, external email
delivery, a real control host with a persistent volume, off-host S3 outside
LocalStack, customer discovery, activation, payment, independent security
assessment, legal commitments and the YC packet. Each has a real code path or
a filled-in template whose only missing input is named in
`docs/hosted/PROVIDERS.md` and `docs/hosted/evidence/`.
