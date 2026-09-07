# Provisional hosted requirements inventory

## Revision 3 reconciliation — 2026-09-07 (W11, docs)

Prepared against `ffb2753` on branch `zenith/hosted-r3`. This pass adds
traceability only. **No row's status changed**, and none may be changed here:
the integrator moves a status after an acceptance run records evidence against
[the acceptance record template](evidence/acceptance-record-template.md).

Each row below and in [requirements.json](requirements.json) now carries:

| Field | Meaning |
| --- | --- |
| `gap` | the G01–G45 rows of the 2026-09-07 gap register this requirement contributes to; an empty list means a scope/retention or deliberate-exclusion instruction with no register counterpart, not an unassessed requirement |
| `gap_pdf_pages` | the PDF pages the gap analysis records for each of those G rows |
| `revision3_workstream` | the W0–W11 workstream that owns it in [PLAN-R3](PLAN-R3.md) §2 |
| `revision3_plan` | what PLAN-R3 §1 says closes the mapped G rows in this wave |

**Page-reference provenance.** The 47-page YC W27 execution plan (SHA-256
`00f43faa7c7fccfcf1caf29d8bb5fc4859b1be61020e2d46d9686c5d347c8159`) was read
by the Codex session of 2026-09-07 that produced the gap analysis. It was
**not** supplied to the Claude session that wrote these fields — the PDF
attached to that session was an unrelated file — so every page number here is
*inherited from the gap analysis, not re-read*. Treat a page reference as a
pointer into that analysis, not as an independent citation.

Coverage is incomplete. The supplied implementation instructions were read in full; the separately referenced Revision 2 report/PDF is absent. This inventory cannot establish coverage of report sections 01–25, tables, P1–P10 workstreams, A01–A09 decisions, D01–D09 diagrams or the page-47 security addendum. Every requirement's PDF and report mapping is explicitly `null` in [requirements.json](requirements.json). Page 47 is the instruction's reference, not a verified citation.

Prepared 2026-09-07 from `pasted-text.txt`. There are **113 coherent verifiable groups**. IDs beginning `ATT-` belong to this extraction, not the report. Instruction section references below refer to the supplied text only.

The machine-readable inventory contains every requested row field: ID, unknown PDF section/page, requirement, classification, current evidence, proposed owner, dependencies, likely implementation files, acceptance tests, evidence locations and status. Candidate file groups and future evidence paths are proposals; they are not implemented modules, completed evidence or permission to edit. The scoped [ownership assignment](OWNERSHIP.md) remains authoritative.

Audited source baseline: `4231dda67fb5a0f57c4bd87117fa5af3c4c083de`. The instruction's `8a974387c14f3f400e20f067190d2ec2c614345f` and report's `7f63ae7747cf6dda90465ca79fc7ca137efa3540` are historical references, not reset targets. The ownership record names branch `codex/zenith-hosted-r2`. Fresh independent baseline execution is recorded in [BASELINE.md](../../.data-hosted-baseline-20260907/evidence/BASELINE.md). Later integrated counts and final runtime checks belong to the integrator's [CHECKPOINT.md](CHECKPOINT.md); this inventory does not duplicate provisional final totals.

Existing workspace-scoped action enforcement and session-refresh regression cases are baseline evidence to preserve. They do not fulfill the requested hosted system. **ATT-BASE-01 and ATT-BASE-04 are locally verified preparation requirements only:** checkout preservation and fresh baseline recording. No hosted capability is marked implemented or live verified. Broad rows remain not started or blocked until the entire requirement is fulfilled, even when bounded implementation/probe progress is recorded below. The requested exclusion group uses classification `explicitly deferred work` but is not marked `deferred-by-report`, because the report has not been read. Update actual implementation statuses only against acceptance evidence.

| Classification | Rows |
| --- | ---: |
| implementation | 99 |
| provider/configuration prerequisite | 6 |
| explicitly deferred work | 1 |
| operator/commercial obligation | 5 |
| experiment/target | 2 |

| Status | Rows |
| --- | ---: |
| not started | 103 |
| implemented | 0 |
| locally verified | 2 |
| live verified | 0 |
| blocked | 8 |
| deferred-by-report | 0 |

## Missing inputs

- **MISSING-REPORT:** Complete Revision 2 report/PDF including sections 01–25, P1–P10 mappings, A01–A09, D01–D09, tables and page-47 addendum. Blocks: Final requirement coverage, exact report mappings and report-dependent contracts.
  - *Revision 3, 2026-09-07 — narrowed, not resolved.* The PDF reached the Codex session that produced the gap analysis and register; page mappings above are inherited from it. `ATT-BASE-02` stays `blocked` because no session that edits this file has read the PDF itself.
- **MISSING-CONTRACTS:** Report-reconciled shared schema, API/error/event contracts, migration DAG and exact implementation ownership. Blocks: Broad implementation and critical authority migration.
- **MISSING-PROVIDERS:** Approved durable control host, Workers for Platforms/D1 access, isolated build provider decision, private artifact and encrypted recovery providers; current API/terms/cost validation. Blocks: Provider-specific live feasibility proof and final deployment.
- **MISSING-DOMAINS-IDENTITY:** Separate registrable control/app domains, exact callbacks, trusted proxy policy, Supabase deployed version/config/session-authority contract and confirmed-email behavior. Blocks: Verified cross-domain session exchange and authoritative hosted admission.
- **MISSING-OPERATIONS:** Approved email sender/provider, scoped secret references, key recovery, off-host revocation/audit retention, backup lifecycle and recovery procedure authorization. Blocks: Real invitation delivery, recovery/trust proof and safe reopening.
- **MISSING-APPROVALS-BUDGET:** Explicit bounded external-action approvals and confirmed cost envelope; $300 is unapproved planning input. Blocks: Billable provisioning, real emails, production changes, destructive restores and purchases.
- **MISSING-REPORT-SCHEMA:** Exact reviewed tracker fields, report event identifiers and diagram-specific broker/runtime constraints. Blocks: Final schema/events/diagram compliance; must not infer from this provisional grouping.
- **MISSING-EXTERNAL-EVIDENCE:** Actual interviews/pilots/payment evidence, approved legal/support commitments and independent external security assessment; target year/date context and current YC requirements when relevant. Blocks: Business attainment claims and broader commercial trust gate.

## Ownership and dependency interpretation

Owners A–H below are the implementation workstreams requested in instruction section 4; O is the accountable operator/commercial owner. These letters do not map to report A01–A09 decisions or P1–P10 workstreams. Assignments and dependency lists are provisional until the integrator reconciles the report and shared contracts. No migration, schema or shared contract is approved by this inventory.

| Owner | Proposed responsibility |
| --- | --- |
| A | A — Integrator / control-state owner |
| B | B — Identity / access |
| C | C — Gateway / runtime |
| D | D — Build / releases |
| E | E — Data broker / reference app |
| F | F — Product UX |
| G | G — Operations / evidence |
| H | H — Independent verification |
| O | Operator / commercial owner |

## Requirement groups

Every row below has the exact source anchor, dependencies, likely file groups and planned acceptance checks in the JSON. `not started` is a conservative inventory status, not a claim that existing related code is absent. `blocked` identifies an unavailable consequential external input. Acceptance evidence locations are populated only where a completed requirement has an actual record. Partial evidence is retained in each row's current evidence without upgrading the broad requirement.

### Supplied instruction section 1

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-BASE-01 | Verify actual branch, HEAD, working tree, diffs, open work, tools and scripts before edits; preserve tracked and untracked changes without reset, clean, stash, history rewrite or secret exposure.<br>**Verify:** Capture sanitized git status/diff and tool/script inventory; compare final changes against preserved baseline. | A | implementation | locally verified | G42 | W0 |
| ATT-BASE-02 | Obtain and read the complete Revision 2 report, sections 01–25, decisions A01–A09, diagrams D01–D09, tables and security addendum.<br>**Verify:** Attachment presence and complete extraction review; reconcile each report item to matrix. | A | provider/configuration prerequisite | blocked | G42, G44 | W0 |
| ATT-BASE-03 | Read repository instructions and relevant READMEs; inspect enumerated integration points before replacement; record substantive requirement/code/provider/instruction conflicts.<br>**Verify:** Code-linked baseline audit and decision review covering all named integration points. | A | implementation | not started | G42, G43, G44 | W0 |
| ATT-BASE-04 | Verify stated baseline behavior and run available baseline checks after script inspection; record actual commands/environment/results/blockers and preserve honest simulation labels.<br>**Verify:** Fresh isolated baseline results for providers, synthetic builds/health, retries, saves and workspace invitations; no historical test-count reuse. | H | implementation | locally verified | G32, G42 | W10 |

### Supplied instruction section 2

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-TRACE-01 | Maintain machine-readable and readable requirement inventories with every required field, classification/status vocabulary and final report workstream/addendum coverage.<br>**Verify:** Validate JSON schema, IDs, required fields and report traceability; fail final completeness when mappings are unavailable. | A | implementation | not started | G42, G44 | W11 |
| ATT-TRACE-02 | Treat interviews, customers, payments, independent review, legal approval and YC acceptance as manual evidence obligations; provide accountable supporting checklists without fabricated attainment.<br>**Verify:** Review scorecards/checklists for accountable owners and unknown values; distinguish implementation from business evidence. | G | implementation | not started | G35, G36, G37, G38, G39, G40, G41, G45 | W11 |
| ATT-TRACE-03 | Demonstrate private publish → separately authenticated invited non-workspace recipient → meaningful durable action → second authorized reader → unauthorized/revoked denial, concurrency safety, compatible data preservation, unhealthy-release rejection and safe recovery.<br>**Verify:** Cross-boundary end-to-end test with distinct identities, restart/redeploy/rollback and revoke checks. | H | implementation | not started | G30, G32 | W10 |

### Supplied instruction section 3

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-SCOPE-01 | Retain Next.js/TypeScript, Supabase, canonical manifest/typed actions, UI primitives, System Map, history, exports, secrets and optional Navigator/Gimbal; preserve recent visuals and auth fixes.<br>**Verify:** Existing behavior regression tests, no-WebGL/no-LLM operation and reviewed scope diff. | A | implementation | not started | none (scope/exclusion) | W0 |
| ATT-SCOPE-02 | Define one versioned hosted contract for reviewed React/Vite frontend, optional stateless Worker-compatible JS/TS, fixed tracker schema, email identity, private platform subdomain and owner/editor/viewer.<br>**Verify:** Contract fixtures accept supported app and reject unsupported versions, APIs, sources, dependencies and manifests. | A | implementation | not started | G01 | W0 |
| ATT-SCOPE-03 | Explicitly reject unsupported packages/APIs/manifests/sources; never infer container/Postgres compatibility with Workers/D1; preserve legacy exports with accurate runtime scope.<br>**Verify:** Unsupported-input cases and legacy export regression; new-runtime export claims require import proof. | A | implementation | not started | G01, G05 | W2 |
| ATT-SCOPE-04 | Exclude general AWS apply, Kubernetes, other clouds, arbitrary Docker/Python/full-Node, arbitrary SQL, destructive schema migrations, generic backend delegation, CRDT/source coediting, enterprise federation, marketplace and automated billing.<br>**Verify:** Scope review confirms exclusions and no unsupported production fallbacks. | A | explicitly deferred work | not started | none (scope/exclusion) | W0 |
| ATT-ARCH-01 | Use persistent singleton Next/Node control service and transactional SQLite as sole critical-control and permission-input authority; never use ephemeral storage or unrelated replica files; no singleton HA claim.<br>**Verify:** Deployment topology/storage validation; startup rejects incompatible configuration. | A | implementation | not started | G03, G33 | W1 |
| ATT-ARCH-02 | Select durable singleton hosting, or explicitly approve an ADR selecting shared transactional storage if singleton hosting is unacceptable.<br>**Verify:** Recorded host/storage decision, backup persistence evidence and operator approval. | Operator / commercial owner | provider/configuration prerequisite | blocked | G33, G34 | W11 |
| ATT-ARCH-03 | Validate conditional Workers for Platforms dispatch, isolated immutable releases/assets and per-app D1 through fixed trusted broker before relying on them.<br>**Verify:** Opt-in two-tenant live spike records capabilities, isolation and go/no-go decision. | C | provider/configuration prerequisite | blocked | G02, G16, G34 | W6 |
| ATT-ARCH-04 | Select disposable isolated customer build environment after validation; E2B is only a candidate; GitHub Actions remains Zenith CI rather than assumed customer-build service.<br>**Verify:** Hostile-build spike and provider decision with actual SDK/version evidence. | D | provider/configuration prerequisite | blocked | G06, G34 | W2 |
| ATT-ARCH-05 | Select private immutable artifact storage and encrypted off-host recovery provider with access boundaries, lifecycle and tested recovery.<br>**Verify:** Provider/access/lifecycle configuration review and recovery drill. | G | provider/configuration prerequisite | blocked | G07, G22, G34 | W8 |
| ATT-ARCH-06 | Build bounded feasibility harness using real reference app, two tenants and identities, actual packages, private asset/API routing, fixed bindings, isolated builds, egress restrictions and extraction; produce evidence and decision.<br>**Verify:** Executable local harness plus separately blocked opt-in live runs; no screenshot-only completion. | H | implementation | not started | G02, G32 | W10 |
| ATT-ARCH-07 | Document provider failure decision and any narrower reviewed-template/concierge or evidence-backed alternative without weakening isolation or authorization; disclose manual assistance.<br>**Verify:** ADR compares failed gates and proposed scope to actual report; manual assistance visible. | A | implementation | not started | G34 | W11 |
| ATT-ARCH-08 | Verify current official APIs, SDKs, compatibility, terms and costs before reliance; no invented endpoints or unapproved plan purchases.<br>**Verify:** Dated official-source references, pinned versions and approved cost prerequisites. | Operator / commercial owner | provider/configuration prerequisite | not started | G34, G40 | W11 |

### Supplied instruction section 4

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-TEAM-01 | Agree shared types, APIs/errors, authority boundaries, migration owner, event vocabulary, fixtures and dependency DAG before parallel implementation; one integrator owns shared spine/dependencies.<br>**Verify:** Reviewed contract set and exact per-worker path ownership/change queue. | A | implementation | not started | G01, G44 | W0 |
| ATT-TEAM-02 | Run independent workers with explicit IDs, exclusive paths, contracts/tests/evidence and isolated directories/ports/fixtures/namespaces; serialize shared migrations and lockfile changes.<br>**Verify:** Ownership collision audit and handoff review; record any unavailable agents/worktrees. | A | implementation | not started | G45 | W0 |
| ATT-TEAM-03 | Integrate small slices continuously, rerun affected checks and independently review security-sensitive work; agent review is not external certification.<br>**Verify:** Author-independent review artifacts and correction retests. | H | implementation | not started | G35, G45 | W0 |
| ATT-TEAM-04 | Execute contract/baseline/spike, foundations, full journey and recovery/evidence waves; follow setup with running vertical slice; test doubles never become production fallbacks.<br>**Verify:** Wave checkpoint and integrated slice evidence; production fallback scan. | A | implementation | not started | G32 | W0 |

### Supplied instruction section 5.A

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-STATE-01 | Transactional sole authority for apps, grants, invitations, sessions/exchanges, jobs/idempotency, selected releases, outboxes and workspace/ownership authorization inputs.<br>**Verify:** Transaction, uniqueness, foreign-key and crash tests; no alternate permission writes. | A | implementation | not started | G03, G04, G08 | W1 |
| ATT-STATE-02 | Migrate permission readers and writers together, including context and action roles; prohibit competing JSON authority and stale claims restoring revocation; retain legacy projections only under explicit failure contracts.<br>**Verify:** Audit all authorization call sites; revoke then retry through legacy and hosted paths. | A | implementation | not started | G03, G13 | W1 |
| ATT-STATE-03 | Versioned repeatable migration with pre-backup, integrity/constraint checks, interruption recovery and safe cutover; unreadable existing data never initializes empty authority.<br>**Verify:** Migration replay/interruption/corruption/disk-error fixtures and rollback rehearsal. | A | implementation | not started | G03, G22 | W1 |
| ATT-STATE-04 | Select maintained driver for pinned Node; verify foreign keys, locking/busy handling, WAL and durability normally synchronous=FULL; distinguish process-kill from power-loss claims.<br>**Verify:** Driver/version compatibility and durability-setting tests plus accurately scoped fault evidence. | A | implementation | not started | G03, G33 | W1 |
| ATT-STATE-05 | Commit critical mutations, operation state and outbox intent before acknowledgement.<br>**Verify:** Interrupt before/after commit and acknowledgement; verify no acknowledged lost operation. | A | implementation | not started | G03, G04 | W1 |
| ATT-STATE-06 | Persist UUID idempotency scoped to actor/workspace/app and SHA-256 canonical full intent including artifact/config/schema/secret-version references; same intent resumes, changed intent conflicts, replay reauthorizes.<br>**Verify:** Concurrent identical keys, changed intent, process restart, replay after revoke. | A | implementation | not started | G04 | W1 |
| ATT-STATE-07 | Durable single-flight admission, fenced deployment ownership and persisted phases/resource IDs/outcomes; jobs continue without requests and resume after restart.<br>**Verify:** Concurrent publish, stale lease/callback, disconnected browser and restart phase tests. | D | implementation | not started | G04, G08 | W7 |
| ATT-STATE-08 | Reconcile cloud success/lost acknowledgement without blind duplicate effects or exactly-once external claims; retry/cancel/cleanup preserve active release and app data.<br>**Verify:** Inject ACK loss at each provider effect and verify reconciliation/cleanup fences. | D | implementation | not started | G04, G08, G24 | W7 |
| ATT-STATE-09 | Hosted management uses typed authorization/plan/audit extensions; recipient CRUD is independent of workspace wrappers; async accepted jobs are not reported live.<br>**Verify:** Non-workspace recipient CRUD plus management permission/plan/audit tests and status presentation. | A | implementation | not started | G03, G04, G10 | W7 |

### Supplied instruction section 5.B

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-ACCESS-01 | Separate app-use grants from workspace roles: owner/editor/viewer read, owner/editor create/update, viewer no mutations, owners alone manage grants/publish, publishing also requires workspace action permission.<br>**Verify:** Two-app/two-workspace role matrix; recipient lacks workspace; app-owner without publish permission denied. | B | implementation | not started | G10 | W5 |
| ATT-ACCESS-02 | Workspace admin never implicitly grants app data access; define explicit initial app owner and transactional last-owner protection; unnecessary transfer UI remains outside scope.<br>**Verify:** No-grant admin denial, initial owner approval, concurrent last-owner removal tests. | B | implementation | not started | G10 | W5 |
| ATT-ACCESS-03 | Durable app/email-bound random invitation tokens hashed at rest, single use, 48-hour expiry, atomic acceptance and resend invalidation; match currently verified authenticated email.<br>**Verify:** Wrong/forwarded email, expiry boundary, replay and concurrent send/accept/revoke/resend tests. | B | implementation | not started | G11 | W5 |
| ATT-ACCESS-04 | Transactional invitation delivery outbox with bounded retries and visible failures; distinguish SMTP sent from delivered; external email tests require authorization.<br>**Verify:** Crash/ACK-loss/retry tests and UI delivery-state assertions; separately authorized live delivery. | B | implementation | not started | G11 | W5 |
| ATT-ACCESS-05 | Separate control/app registrable domains and exact callback allowlists; app-bound short-lived single-use exchange bound to validated browser state and redirect after server identity verification.<br>**Verify:** Wrong origin/state/app/callback, malformed redirects and exchange replay tests. | B | implementation | not started | G12, G34 | W5 |
| ATT-ACCESS-06 | Atomically consume exchange into opaque app session with host-only Secure/HttpOnly cookie, preferably compliant __Host- prefix; no refresh token or platform credential exposure to editable app code/storage.<br>**Verify:** Cookie attributes, session fixation, cross-app replay, browser storage and forwarded credential inspection. | B | implementation | not started | G12 | W5 |
| ATT-ACCESS-07 | Define identity-session termination independently of grant revocation; verify issued-token-after-signout behavior against current Supabase docs and implement required authoritative session check; getClaims/getUser naming alone is insufficient.<br>**Verify:** Old JWT after signout, missing/mismatched session ID, timeout/deleted session and policy-service outage; opt-in actual provider flow. | B | implementation | not started | G13 | W5 |
| ATT-ACCESS-08 | Preserve refreshed cookies and no-cache headers through redirects/errors.<br>**Verify:** Retain existing multi-batch refresh/deletion/outage tests and add cache-header propagation. | B | implementation | not started | G12, G15 | W6 |
| ATT-ACCESS-09 | Every new protected page/asset/API admission checks live grant and valid session without positive permission caching; revoke commits before ACK and next request denial; document bounded in-flight/download limits and no SQLite/D1 distributed atomicity claim.<br>**Verify:** Revoke then page/asset/API/HEAD/range requests, multihost checks and concurrent in-flight write behavior. | B | implementation | not started | G13, G14 | W6 |
| ATT-ACCESS-10 | Cookie mutations require exact Origin and CSRF, including sibling-app attacks; GET/HEAD mutations and wildcard credentialed CORS are rejected.<br>**Verify:** Missing/null/forged/sibling Origin, CSRF mismatch, method override and CORS matrix. | B | implementation | not started | G15 | W6 |
| ATT-ACCESS-11 | Hosted mode fails closed on missing/partial auth; no inherited no-key demo admin or empty-workspace promotion; explicitly separate local demo.<br>**Verify:** Missing URL/key/policy configuration and empty-membership hosted denial; explicit local demo regression. | B | implementation | not started | G13, G14 | W5 |

### Supplied instruction section 5.C

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-GATE-01 | Trusted gateway reserves /_zenith/data/* for platform broker A statically bound to D1 A; other requests invoke selected immutable app worker only after admission; repeat complete isolation unit per app.<br>**Verify:** Reserved-route precedence, per-app binding audit and denial-before-customer-code counter. | C | implementation | not started | G14, G16 | W6 |
| ATT-GATE-02 | Resolve exact host/app/active-release/broker using authoritative mappings; reject unknown hosts and request-controlled tenant/database/broker selectors.<br>**Verify:** Unknown/malformed host, spoofed forwarded headers and cross-app selector tests. | C | implementation | not started | G14, G16 | W6 |
| ATT-GATE-03 | Trusted infrastructure sends audience/app/request-bound broker context; broker independently validates current grant and semantic operation instead of trusting browser role headers.<br>**Verify:** Forged/replayed/mismatched context and revoked grant at broker tests. | C | implementation | not started | G16 | W6 |
| ATT-GATE-04 | Editable backend receives no D1/admin/dispatch binding, platform session/JWT or delegated data capability; strip platform credentials and spoofable identity headers and audit deployed bindings.<br>**Verify:** Adversarial worker inspects env/headers and attempts direct broker/data access. | C | implementation | not started | G15, G16, G25 | W6 |
| ATT-GATE-05 | Gateway controls response headers/cookies/redirects/caching; customer code cannot replace security policy; authenticate assets and reject alternate-origin/preview/worker URL bypass.<br>**Verify:** Hostile Set-Cookie/location/cache/CORS/CSP responses and direct asset/origin access. | C | implementation | not started | G15 | W6 |
| ATT-GATE-06 | Audit existing public preview; preserve honest public simulation without private hosted deployment/metadata leakage and never use it as live auth boundary.<br>**Verify:** Legacy public simulation tests plus hosted IDs/metadata negative cases. | C | implementation | not started | G14, G28 | W6 |
| ATT-GATE-07 | Default-deny server egress with explicit allowlists and bypass tests; treat bindings, network rules and browser CSP as distinct controls.<br>**Verify:** Redirect/DNS/address/protocol/subrequest bypass and binding-vs-network isolation tests. | C | implementation | not started | G15 | W6 |
| ATT-GATE-08 | Platform-owned restrictive script/connect/form/frame policy appropriate to reviewed frontend; service-worker/offline caching deferred; disclose malicious authorized frontend limitations.<br>**Verify:** Reviewed CSP browser tests, service worker denial and threat-model limitations. | C | implementation | not started | G15 | W6 |
| ATT-GATE-09 | Enforce unknown-host 404, controlled sign-in/401 for missing identity, grant denial 403, policy/identity unavailable 503, quota 429; no editable-code/data invocation on denial; sensitive responses no-store.<br>**Verify:** Status/error contract tests with customer invocation sentinel and cache inspection. | C | implementation | not started | G14, G19 | W6 |

### Supplied instruction section 6

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-UX-01 | Wire source validation, audience/limits, real progress/fail/cancel, private URL, invite/resend/revoke/roles, releases/rollback, actual health/logs, export and recovery status to backend.<br>**Verify:** End-to-end each control reaches real operation; loading/empty/error tests and operator-status visibility. | F | implementation | not started | G29 | W9 |
| ATT-UX-02 | No dead controls, fake progress/success, mock counts or hidden founder repair; retain infrastructure views without requiring them for recipients.<br>**Verify:** Review labels with backend evidence; recipient journey never requires workspace infrastructure UI. | F | implementation | not started | G28, G29 | W9 |
| ATT-UX-03 | Test fresh-browser/mobile/keyboard, loading/empty/errors, focus/readability/reduced-motion and no-WebGL/no-LLM; use existing tokens/components/import conventions.<br>**Verify:** Browser/device/keyboard/accessibility matrix and existing component/import checks. | F | implementation | not started | G30 | W9 |
| ATT-UX-04 | Reduce unnecessary waterfalls/heavy client code without weakening fresh authorization.<br>**Verify:** Measure representative load and verify each protected admission still checks authority. | F | implementation | not started | G29 | W9 |
| ATT-OPS-01 | Implement configurable initial build/runtime/request/data limits: one build/app, two pilot-wide, five-minute build, 50 ms CPU, five outbound subrequests, 1 MB body, 10,000 requests/app/day, 100 MB data.<br>**Verify:** Boundary/over-limit/reset/race/restart tests for every listed limit; compare actual provider capabilities. | C | implementation | not started | G19 | W8 |
| ATT-OPS-02 | Define measurement and atomic quota enforcement for storage/concurrent requests; label application limits rather than provider guarantees and disclose unsupported enforcement.<br>**Verify:** Atomic admission/storage races, bypass/reset/restart tests and UI enforcement-vs-display audit. | C | implementation | not started | G19 | W8 |
| ATT-OPS-03 | Per-app suspension/kill switch blocks service without deleting data.<br>**Verify:** Suspend/resume requests and verify preserved data, grants and artifacts. | C | implementation | not started | G19 | W8 |
| ATT-OPS-04 | Consistent encrypted off-host backups and immutable artifacts with key recovery; distinct code rollback, app-data restore and control-host recovery procedures; WAL-aware backup/checksums/metadata/retention.<br>**Verify:** Backup under concurrent writes, checksum/key corruption, retention/reference and restore validation. | G | implementation | not started | G21, G22, G24 | W8 |
| ATT-OPS-05 | Test clean-host recovery including recovered keys and provider reconciliation.<br>**Verify:** Isolated clean host restore drill with recorded source/target versions and timings. | G | implementation | not started | G22, G33 | W8 |
| ATT-OPS-06 | Recovery pauses affected writes/sharing, preserves evidence/current exports, explains cutoff/lost writes, reconciles newer off-host revocations and requires access/data checks plus authorized reopening.<br>**Verify:** Restore older control/data snapshots after revoke; admission remains closed until reconciliation and approval. | G | implementation | not started | G21, G23 | W8 |
| ATT-OPS-07 | Without current revocation evidence, invalidate restored grants and require owner reapproval; session clearing alone is insufficient.<br>**Verify:** Missing/corrupt/stale revocation evidence restore tests deny former recipients. | B | implementation | not started | G23 | W8 |
| ATT-METRIC-01 | Structured events use report identifiers/timestamps/outcomes, never customer content/credentials; deduplicate logical operations and retain failures.<br>**Verify:** Schema/privacy/redaction and logical-deduplication tests; final vocabulary reconciliation requires report. | G | implementation | not started | G31 | W8 |
| ATT-METRIC-02 | Track activation, sent-vs-delivered invitations, meaningful non-builder actions, days-7–13 matured return cohorts, assistance, release failures, denial, costs and support effort.<br>**Verify:** Synthetic privacy-safe cohort fixtures for maturity boundaries and correct event attribution. | G | implementation | not started | G31, G38 | W8 |
| ATT-METRIC-03 | Exclude founder/test/demo accounts from aggregates; distinguish pilot acceptance, invoices and collected payment; empty evidence remains zero/unknown attainment.<br>**Verify:** Filtering/payment-state fixtures and empty-scorecard truthfulness tests. | G | implementation | not started | G31, G38, G39 | W8 |
| ATT-TRUST-01 | Prepare stage-appropriate privileged MFA/least privilege, scoped credential/rotation, monitored support access and compromise-response controls.<br>**Verify:** Configuration/runbook review, authorized privilege/rotation/support-audit tests; manual attestation separate. | G | implementation | not started | G26 | W11 |
| ATT-TRUST-02 | Implement tamper-resistant off-host audit evidence; never describe local append-only files as tamper-proof.<br>**Verify:** Local tamper/deletion detection and off-host retention/access-boundary tests. | G | implementation | not started | G23, G26 | W11 |
| ATT-TRUST-03 | Maintain provider/region/data-exposure map, retention/deletion/backup-expiry policy, export/import proof, privacy/support/incident drafts and applicable ASVS checks.<br>**Verify:** Report/addendum checklist review and documented ASVS test evidence; legal approval remains manual. | G | implementation | not started | G27, G36 | W11 |
| ATT-TRUST-04 | Authorized app/data deletion and backup expiry with audit/restore safeguards; disclose retained-backup windows rather than immediate universal erasure.<br>**Verify:** Permission/confirmation deletion tests, backup-expiry schedule and restore resurrection prevention. | G | implementation | not started | G27, G36 | W11 |
| ATT-TRUST-05 | Disclose privileged plaintext access and absence of end-to-end encryption without invented legal commitments/compliance claims.<br>**Verify:** Data-flow/support-access disclosure review against actual deployed boundaries. | G | implementation | not started | G35, G36 | W11 |
| ATT-BIZ-01 | Prepare discovery/onboarding logs, pilot/support terms for review, payment-state records, honest scorecards, reproducible demo and YC evidence checklist.<br>**Verify:** Template existence and empty-data honesty review; demo script reproducibility. | G | implementation | not started | G37, G38, G39, G41 | W11 |
| ATT-BUDGET-01 | Track budget and 50/75/90% alerts; pause new builds at 90% of approved configured envelope without indiscriminately stopping useful running apps; disclose billing lag.<br>**Verify:** Threshold crossings, delayed costs, restart/concurrent admission and existing-app continuity tests. | G | implementation | not started | G20 | W8 |
| ATT-BUDGET-02 | Approve cost envelope and spending/provider choices; report's $300 envelope is unconfirmed and no absolute spend guarantee is possible with billing lag.<br>**Verify:** Dated operator approval and provider-cost review; never infer approval from presence of credentials. | Operator / commercial owner | operator/commercial obligation | blocked | G20, G40 | W11 |
| ATT-OPS-08 | Measure proposed RPO ≤24 hours and RTO ≤4 hours using actual recovery drill; never claim achieved from procedures alone.<br>**Verify:** Timed clean-host drill with measured recoverable cutoff and restoration completion. | G | experiment/target | not started | G22, G33 | W11 |
| ATT-OPS-09 | Obtain explicit approval for in-place data restore and authorized confirmation before reopening recovered service.<br>**Verify:** Recorded bounded restore authorization and post-check reopening confirmation. | Operator / commercial owner | operator/commercial obligation | blocked | G33 | W11 |
| ATT-BIZ-02 | Collect actual interviews/customer/revenue/testimonial/founder/review evidence without fabrication; record dates and verify current submission rules when relevant.<br>**Verify:** Evidence provenance and permission audit; unknown facts stay unknown. | Operator / commercial owner | operator/commercial obligation | not started | G37, G39, G41 | W11 |
| ATT-BIZ-03 | Treat five activations/two paid-pilot acceptances by October 6 and three eligible returning teams by October 11 as unachieved targets, not YC requirements; confirm applicable target year/date context.<br>**Verify:** Dated cohort/payment evidence evaluated only when eligible; target calendar verified with report. | Operator / commercial owner | experiment/target | not started | G38, G39 | W11 |

### Supplied instruction section 5.D

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-BUILD-01 | Implement pinned-source bounded-intake isolated-build immutable-artifact private-candidate authenticated-verification durable-activation pipeline to stable URL.<br>**Verify:** End-to-end actual package build and private release activation; doubles separately labeled. | D | implementation | not started | G05, G06, G07, G08, G09 | W2 |
| ATT-BUILD-02 | Validate source identity/contract, archive paths/sizes/symlinks/decompression limits and remote-fetch boundaries.<br>**Verify:** Traversal, symlink, archive-bomb, oversized source, remote SSRF and wrong commit tests. | D | implementation | not started | G05 | W2 |
| ATT-BUILD-03 | Never execute submitted install/build code on developer/control/publisher/CI management hosts; isolated environment has no platform/admin/runtime credentials, DB, shared Docker socket or cross-tenant cache.<br>**Verify:** Hostile build probes permissions/files/secrets/socket/cache; verify isolated process boundary. | D | implementation | not started | G06, G25 | W2 |
| ATT-BUILD-04 | Fixed approved recipe/toolchain and lockfile with bounded network/resources/time, scoped source/artifact access, bounded redacted logs, cancellation and verified teardown; submitted repo cannot replace workflow.<br>**Verify:** Recipe override, exhaustion/timeout/cancel, log secret/size, teardown and egress tests. | D | implementation | not started | G06, G25 | W2 |
| ATT-BUILD-05 | Trusted publisher separated by process/permissions independently checks artifact digest and source/job identity; record commit, lock fingerprint, contract/toolchain, asset manifest and SHA-256.<br>**Verify:** Tamper/provenance mismatch and confused-job extraction tests; immutable manifest verification. | D | implementation | not started | G07, G25 | W2 |
| ATT-BUILD-06 | Treat FNV as non-integrity and digest identity as non-safety; enforce required source/release approval.<br>**Verify:** Unapproved correctly hashed artifact cannot activate; approval tied to immutable intent. | D | implementation | not started | G07 | W2 |
| ATT-BUILD-07 | Immutable release IDs and durable selected pointer; real endpoint/package/create/read probes use separate test broker/DB; production schema/bindings read-only; unhealthy/partial candidates remain inactive.<br>**Verify:** Probe failure/partial resource refusal, test-data isolation and live binding read-only evidence. | D | implementation | not started | G08, G09 | W7 |
| ATT-BUILD-08 | Updates preserve stable URL/data and recorded compatibility/schema versions; only reviewed additive/backward-compatible changes; rollback selects compatible code without rewinding data.<br>**Verify:** Compatible redeploy/rollback preserves records; destructive/incompatible schema rejected. | D | implementation | not started | G24 | W7 |
| ATT-BUILD-09 | Cleanup preserves resources referenced by active release, rollback, backups and retention.<br>**Verify:** Concurrent cleanup/activation/rollback and retained-reference tests. | D | implementation | not started | G21, G24 | W7 |

### Supplied instruction section 5.E

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-DATA-01 | Implement fixed reviewed request/equipment tracker with bounded list/read/create/update, validated fields, parameterized SQL, pagination, semantic role checks and app isolation; reject arbitrary SQL/privileged operations/destructive schema.<br>**Verify:** Real fixture CRUD, field/query limits, SQL injection, pagination and two-app role matrix. | E | implementation | not started | G16, G17 | W3 |
| ATT-DATA-02 | Atomic optimistic record-version concurrency returns 409 on stale update, with no read/write race or silent last-writer-wins.<br>**Verify:** Simultaneous expected-version updates yield one success and one conflict. | E | implementation | not started | G18 | W3 |
| ATT-DATA-03 | Persist write ID/full intent/result in same data transaction; retry lost ACK without duplicate creation and reauthorize before returning cached results.<br>**Verify:** Duplicate/concurrent write IDs, changed intent, lost ACK and retry after grant revoke. | E | implementation | not started | G04, G18 | W3 |
| ATT-DATA-04 | Show Saved only after durable ACK; preserve proposed edits on conflicts/recoverable errors and offer explicit reload/retry.<br>**Verify:** Slow/error/409 UI tests preserve unsaved input and prevent premature Saved state. | F | implementation | not started | G18, G29 | W9 |
| ATT-DATA-05 | Verify second permitted identity sees persisted action across refresh, runtime/control restart, compatible redeploy and rollback.<br>**Verify:** Separate browser contexts and persistence/restart/release matrix. | H | implementation | not started | G17, G24, G30 | W10 |
| ATT-DATA-06 | Provide supported browser data interface and working fixture; optional editable handlers remain stateless without delegated DB access.<br>**Verify:** SDK contract and fixture integration tests; handler capability negative tests. | E | implementation | not started | G01, G16 | W4 |
| ATT-DATA-07 | Export source, appropriate artifacts, schema, records and access manifest with documented import/exit test; CSV alone is not universal portability.<br>**Verify:** Round-trip import into clean target and verify records/access metadata/limitations. | G | implementation | not started | G21, G27 | W8 |

### Supplied instruction section 6/7

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-TRUST-06 | Obtain stage-appropriate independent external security assessment, legal/terms review and required trust attestations; agent review is not external certification.<br>**Verify:** Named independent reviewer, dated findings/disposition and approved legal/trust records. | Operator / commercial owner | operator/commercial obligation | blocked | G35 | W11 |

### Supplied instruction section 7

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-VERIFY-01 | Executable unit/contract/integration/browser and opt-in live-cloud suites; mocks never establish live isolation/delivery/recovery; unavailable environments are blocked.<br>**Verify:** Test inventory maps all boundary rows and labels actual execution environments. | H | implementation | not started | G32 | W10 |
| ATT-VERIFY-02 | Adversarial app/workspace role, non-member recipient, dual publish permission and hosted fail-closed matrix across two tenants.<br>**Verify:** Executable cross-tenant/access integration suite. | H | implementation | not started | G10, G32 | W10 |
| ATT-VERIFY-03 | Attack email/token invite lifecycle, resend races, callback/state/origin, exchange replay/app mismatch, issued token after signout, grant revoke and restored older permissions.<br>**Verify:** Independent invite/session/recovery adversarial suite plus authorized opt-in provider test. | H | implementation | not started | G11, G12, G13, G32 | W10 |
| ATT-VERIFY-04 | Attack direct page/asset/API/origin, unknown host, forged context, cross-app bindings, sibling CSRF, method/CORS and credential/cache leakage; denial must not invoke editable code.<br>**Verify:** Independent gateway/broker browser and contract tests with invocation sentinels. | H | implementation | not started | G14, G15, G32 | W10 |
| ATT-VERIFY-05 | Attack viewer methods, malformed/oversized data, version races, duplicate/changed write IDs, lost ACK and retry after revoke.<br>**Verify:** Independent transactional CRUD race/fault suite. | H | implementation | not started | G17, G18, G32 | W10 |
| ATT-VERIFY-06 | Attack hostile install/build, archive traversal/bombs, platform secrets, egress restrictions, exhaustion/timeouts/cancel, extraction/provenance and cleanup isolation.<br>**Verify:** Hostile isolated build fixtures with measured limits and teardown evidence. | H | implementation | not started | G05, G06, G25, G32 | W10 |
| ATT-VERIFY-07 | Test concurrent publishes, interruption every external phase, cancel/stale callbacks, lost cloud ACK, immutability, isolated probes, unhealthy rejection and data-preserving rollback.<br>**Verify:** Independent release state-machine/crash/reconciliation suite. | H | implementation | not started | G07, G08, G09, G24, G32 | W10 |
| ATT-VERIFY-08 | Fault-test migration/corruption, SIGKILL, disk-full/write failures, backup/key failure, clean-host restore/stale grants, quota races/reset/restart, suspension retention and dependency outages.<br>**Verify:** Isolated state/recovery/quota fault suites; no developer/customer data. | H | implementation | not started | G03, G19, G22, G23, G32 | W10 |
| ATT-VERIFY-09 | Run actual separate-browser builder → recipient → persist → update → revoke, keyboard/mobile and honest real/simulated presentation plus privacy-safe cohort tests.<br>**Verify:** Browser recordings/assertions and sanitized metrics fixtures tied to source SHA. | H | implementation | not started | G29, G30, G32 | W10 |
| ATT-VERIFY-11 | Never weaken/delete tests, hide failures, blanket-suppress or silently skip suites; investigate actual workflow failures rather than trusting hosting status.<br>**Verify:** Review CI/test diff and enumerate executed/blocked suites with exit statuses. | H | implementation | not started | G32, G45 | W10 |
| ATT-VERIFY-12 | Separate unprivileged PR tests from approved live-cloud jobs; protect credentials from untrusted code, pin/review dependencies/actions, bound live costs and clean only test-owned resources.<br>**Verify:** Workflow syntax/permissions/pin review; resource prefix and budget cleanup tests. | H | implementation | not started | G25, G45 | W10 |
| ATT-VERIFY-13 | Acceptance records include requirement/date/source+build SHA/environment+provider versions/tester/input/expected+actual/sanitized artifact; independently review high-risk diffs, retest corrections and uncovered requirements.<br>**Verify:** Schema validation and requirement-to-evidence audit with independent review provenance. | H | implementation | not started | G32, G44 | W11 |
| ATT-VERIFY-14 | Separate local, supervised low-criticality real-data pilot and broader commercial gates; pilot requires access/isolation/roles/revoke/durability/quotas/export/recovery; broader rollout needs external trust evidence and resolved blockers.<br>**Verify:** Release gate checklist refuses promotion when required evidence absent or mocked. | H | implementation | not started | G32, G35 | W10 |

### Supplied instruction section 1/7

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-VERIFY-10 | Inspect and run typecheck/lint/tests/smoke/Gimbal/production Next/Docker where supported; add hosted security/integration/browser and workflow-syntax gates; all required release checks block CI.<br>**Verify:** Exact command/result artifacts and CI regression tests against continue-on-error/missing gates. | H | implementation | not started | G32, G45 | W10 |

### Supplied instruction section 8

| ID | Requirement / acceptance scope | Owner | Classification | Status | Gap (G) | R3 WS |
| --- | --- | --- | --- | --- | --- | --- |
| ATT-HANDOFF-01 | Continue authorized reversible work despite live blockers; finish adapters/config validation/opt-in tests/operator instructions; no fake-success production stubs; ask only consequential missing inputs.<br>**Verify:** Production path review, explicit missing-input inventory and executable opt-in harness. | A | implementation | not started | G33, G34 | W11 |
| ATT-HANDOFF-02 | Explicit approval required for billable provisioning, production DNS/data changes, customer messages, destructive restores, subscriptions/charges and YC submission; secrets stay out of committed files/logs.<br>**Verify:** Scoped approval records before consequential external action; sanitized logs/config references. | Operator / commercial owner | operator/commercial obligation | not started | G34, G40 | W11 |
| ATT-HANDOFF-03 | Use reviewable feature branch without unrequested push/merge/force-push; maintain wave/context checkpoint including integrated work, owners/contracts/next steps/tests/blockers/changed files.<br>**Verify:** Git and checkpoint review; another session can resume without overwriting ownership. | A | implementation | not started | G42, G45 | W11 |
| ATT-HANDOFF-04 | Final report includes implemented paths, baseline/final SHAs/diff, requirement/exclusion/manual coverage, exact local/mock/live results, demonstrated journey, threats/recovery risks, deployment/rollback instructions, prioritized blockers and pilot/commercial go/no-go.<br>**Verify:** Evidence-linked release review; reject completion based only on screens/compile/upload/happy path. | A | implementation | not started | G42, G44 | W11 |

## Revision 3 gap coverage (G42, G44)

Every one of the 45 gap-register rows has at least one requirement row mapped
to it; 111 of the 113 requirement rows carry
at least one G id and 2 carry none for the reason
above (`ATT-SCOPE-01` retention, `ATT-SCOPE-04` deliberate exclusions).
Counts describe mapping, **not** completion: the status table is unchanged.

| G | Priority | Gap (gap analysis §5) | PDF pages (inherited) | R3 workstream | Rows | Requirement rows |
| --- | --- | --- | --- | --- | ---: | --- |
| G01 | P0 | Freeze reviewed tracker source/API/schema contract | 6-8, 16, 32 | W0 | 4 | ATT-SCOPE-02, ATT-SCOPE-03, ATT-TEAM-01, ATT-DATA-06 |
| G02 | P0 | Real hosted adapter and runtime journey | 9, 17, 22-25 | W6 | 2 | ATT-ARCH-03, ATT-ARCH-06 |
| G03 | P0 | Transactional sole permission/control authority | 12, 17, 23 | W1 | 8 | ATT-ARCH-01, ATT-STATE-01, ATT-STATE-02, ATT-STATE-03, ATT-STATE-04, ATT-STATE-05, ATT-STATE-09, ATT-VERIFY-08 |
| G04 | P0 | Durable idempotency, job outbox and reconciliation | 12, 18, 26 | W1+W7 | 7 | ATT-STATE-01, ATT-STATE-05, ATT-STATE-06, ATT-STATE-07, ATT-STATE-08, ATT-STATE-09, ATT-DATA-03 |
| G05 | P0 | Safe pinned supported-source intake | 7, 13, 18 | W2 | 4 | ATT-SCOPE-03, ATT-BUILD-01, ATT-BUILD-02, ATT-VERIFY-06 |
| G06 | P0 | Isolated build service with bounded lifecycle | 13, 18, 20 | W2 | 5 | ATT-ARCH-04, ATT-BUILD-01, ATT-BUILD-03, ATT-BUILD-04, ATT-VERIFY-06 |
| G07 | P0 | Immutable artifacts and trusted byte/provenance verification | 18, 26 | W2 | 5 | ATT-ARCH-05, ATT-BUILD-01, ATT-BUILD-05, ATT-BUILD-06, ATT-VERIFY-07 |
| G08 | P0 | App release selection, single-flight and fencing | 18, 26, 34 | W7 | 6 | ATT-STATE-01, ATT-STATE-07, ATT-STATE-08, ATT-BUILD-01, ATT-BUILD-07, ATT-VERIFY-07 |
| G09 | P0 | Private candidate health/data verification | 18, 26, 34 | W7 | 3 | ATT-BUILD-01, ATT-BUILD-07, ATT-VERIFY-07 |
| G10 | P0 | App owner/editor/viewer grants separate from workspace roles | 19, 27 | W5 | 4 | ATT-STATE-09, ATT-ACCESS-01, ATT-ACCESS-02, ATT-VERIFY-02 |
| G11 | P0 | Expiring app invites, secure acceptance and delivery outbox | 19, 27, 33 | W5 | 3 | ATT-ACCESS-03, ATT-ACCESS-04, ATT-VERIFY-03 |
| G12 | P0 | Cross-domain app exchange and host-only sessions | 10, 17, 27 | W5+W6 | 4 | ATT-ACCESS-05, ATT-ACCESS-06, ATT-ACCESS-08, ATT-VERIFY-03 |
| G13 | P0 | Authoritative identity-session termination and fresh grants | 10, 19, 28 | W5 | 5 | ATT-STATE-02, ATT-ACCESS-07, ATT-ACCESS-09, ATT-ACCESS-11, ATT-VERIFY-03 |
| G14 | P0 | Gateway admission on pages/assets/API and alternate origins | 15, 20, 24 | W6 | 7 | ATT-ACCESS-09, ATT-ACCESS-11, ATT-GATE-01, ATT-GATE-02, ATT-GATE-06, ATT-GATE-09, ATT-VERIFY-04 |
| G15 | P0 | Credential stripping, response guard, CSRF, CSP and egress | 15, 17, 20, 47 | W6 | 7 | ATT-ACCESS-08, ATT-ACCESS-10, ATT-GATE-04, ATT-GATE-05, ATT-GATE-07, ATT-GATE-08, ATT-VERIFY-04 |
| G16 | P0 | Trusted fixed per-app broker and D1 binding | 11, 23-24, 29 | W3+W6 | 7 | ATT-ARCH-03, ATT-GATE-01, ATT-GATE-02, ATT-GATE-03, ATT-GATE-04, ATT-DATA-01, ATT-DATA-06 |
| G17 | P0 | Durable bounded tracker data/schema operations | 7, 11, 29 | W3 | 3 | ATT-DATA-01, ATT-DATA-05, ATT-VERIFY-05 |
| G18 | P0 | Record versions and idempotent concurrent writes | 6, 21, 29 | W3 | 4 | ATT-DATA-02, ATT-DATA-03, ATT-DATA-04, ATT-VERIFY-05 |
| G19 | P0 | Enforced CPU/build/request/body/storage limits and suspension | 20, 35 | W8 | 5 | ATT-GATE-09, ATT-OPS-01, ATT-OPS-02, ATT-OPS-03, ATT-VERIFY-08 |
| G20 | P1 | Real usage/spending alerts and new-build pause | 20, 38 | W8 | 2 | ATT-BUDGET-01, ATT-BUDGET-02 |
| G21 | P0 | App-data export and recovery | 21, 30, 33-34 | W8 | 4 | ATT-OPS-04, ATT-OPS-06, ATT-BUILD-09, ATT-DATA-07 |
| G22 | P0 | Encrypted off-host control backup and clean-host restore | 12, 21, 30, 47 | W8 | 6 | ATT-ARCH-05, ATT-STATE-03, ATT-OPS-04, ATT-OPS-05, ATT-OPS-08, ATT-VERIFY-08 |
| G23 | P0 | Restore without resurrecting revoked access | 21, 28, 30, 47 | W8 | 4 | ATT-OPS-06, ATT-OPS-07, ATT-TRUST-02, ATT-VERIFY-08 |
| G24 | P0 | Compatible release rollback distinct from data restore | 18, 21, 30 | W7 | 6 | ATT-STATE-08, ATT-OPS-04, ATT-BUILD-08, ATT-BUILD-09, ATT-DATA-05, ATT-VERIFY-07 |
| G25 | P0 | Hosted secret/publisher/build/recovery scopes | 15, 18, 21, 47 | W2+W6 | 6 | ATT-GATE-04, ATT-BUILD-03, ATT-BUILD-04, ATT-BUILD-05, ATT-VERIFY-06, ATT-VERIFY-12 |
| G26 | P2 | MFA, privileged support access and tamper-resistant audit | 47 | W11 | 2 | ATT-TRUST-01, ATT-TRUST-02 |
| G27 | P1 | Worker/D1 export/import and complete data lifecycle | 14, 21, 47 | W8 | 3 | ATT-TRUST-03, ATT-TRUST-04, ATT-DATA-07 |
| G28 | P1 | Real application health/logs and release attribution | 4, 34, 36 | W8 | 2 | ATT-GATE-06, ATT-UX-02 |
| G29 | P1 | Builder publish/release experience | 6-7, 18, 32 | W9 | 5 | ATT-UX-01, ATT-UX-02, ATT-UX-04, ATT-DATA-04, ATT-VERIFY-09 |
| G30 | P0 | Independent recipient useful-action experience | 6, 19, 33 | W4+W6 | 4 | ATT-TRACE-03, ATT-UX-03, ATT-DATA-05, ATT-VERIFY-09 |
| G31 | P1 | Activation/cohort/assistance event model and reporting | 36 | W8 | 3 | ATT-METRIC-01, ATT-METRIC-02, ATT-METRIC-03 |
| G32 | P0 | Hosted integration/adversarial acceptance suite | 20-21, 33, 42, 47 | W10 | 17 | ATT-BASE-04, ATT-TRACE-03, ATT-ARCH-06, ATT-TEAM-04, ATT-VERIFY-01, ATT-VERIFY-02, ATT-VERIFY-03, ATT-VERIFY-04, ATT-VERIFY-05, ATT-VERIFY-06, ATT-VERIFY-07, ATT-VERIFY-08, ATT-VERIFY-09, ATT-VERIFY-10, ATT-VERIFY-11, ATT-VERIFY-13, ATT-VERIFY-14 |
| G33 | P0 | Persistent hosted control deployment and operational recovery | 12, 17, 25 | W11 | 7 | ATT-ARCH-01, ATT-ARCH-02, ATT-STATE-04, ATT-OPS-05, ATT-OPS-08, ATT-OPS-09, ATT-HANDOFF-01 |
| G34 | P0 | Runtime/build/storage/domain/SMTP provider configuration | 10, 13, 16, 25 | W11 | 9 | ATT-ARCH-02, ATT-ARCH-03, ATT-ARCH-04, ATT-ARCH-05, ATT-ARCH-07, ATT-ARCH-08, ATT-ACCESS-05, ATT-HANDOFF-01, ATT-HANDOFF-02 |
| G35 | P2 | Independent commercial security and applicable ASVS verification | 47 | W11 | 5 | ATT-TRACE-02, ATT-TEAM-03, ATT-TRUST-05, ATT-TRUST-06, ATT-VERIFY-14 |
| G36 | P2 | Privacy, subprocessors, regions, deletion and incident commitments | 47 | W11 | 4 | ATT-TRACE-02, ATT-TRUST-03, ATT-TRUST-04, ATT-TRUST-05 |
| G37 | P0 | Specific buyer pain, qualified discovery and named pilot candidates | 5, 32, 37 | W11 | 3 | ATT-TRACE-02, ATT-BIZ-01, ATT-BIZ-02 |
| G38 | P1 | External activation and mature repeat-use evidence | 6, 35-37 | W11 | 5 | ATT-TRACE-02, ATT-METRIC-02, ATT-METRIC-03, ATT-BIZ-01, ATT-BIZ-03 |
| G39 | P1 | Paid-pilot acceptance, invoices and collected revenue | 35-38 | W11 | 5 | ATT-TRACE-02, ATT-METRIC-03, ATT-BIZ-01, ATT-BIZ-02, ATT-BIZ-03 |
| G40 | P1 | Actual capacity, operating budget and measured economics | 2, 14, 31, 38 | W11 | 4 | ATT-TRACE-02, ATT-ARCH-08, ATT-BUDGET-02, ATT-HANDOFF-02 |
| G41 | P2 | YC founder facts, evidence packet, demo/video and submission | 39-40, 42 | W11 | 3 | ATT-TRACE-02, ATT-BIZ-01, ATT-BIZ-02 |
| G42 | P1 | Stale preparation documentation | 43-46 plus newer source | W11+W0 | 7 | ATT-BASE-01, ATT-BASE-02, ATT-BASE-03, ATT-BASE-04, ATT-TRACE-01, ATT-HANDOFF-03, ATT-HANDOFF-04 |
| G43 | P1 | Build and durability wording overstates some behavior | 4, 12, 18 | W11+W0 | 1 | ATT-BASE-03 |
| G44 | P1 | PDF traceability in provisional 113-row inventory | Entire PDF | W11+W0 | 6 | ATT-BASE-02, ATT-BASE-03, ATT-TRACE-01, ATT-TEAM-01, ATT-VERIFY-13, ATT-HANDOFF-04 |
| G45 | P1 | Repository protection and hosted release governance | 32, 42, 47 | W11 | 7 | ATT-TRACE-02, ATT-TEAM-02, ATT-TEAM-03, ATT-VERIFY-10, ATT-VERIFY-11, ATT-VERIFY-12, ATT-HANDOFF-03 |

### Requirement rows per Revision 3 workstream

| Workstream | Rows |
| --- | ---: |
| W0 | 10 |
| W1 | 7 |
| W2 | 8 |
| W3 | 3 |
| W4 | 1 |
| W5 | 8 |
| W6 | 13 |
| W7 | 6 |
| W8 | 13 |
| W9 | 5 |
| W10 | 17 |
| W11 | 22 |

Workstream letters A–H used elsewhere in this file are the Revision 2
proposal; W0–W11 are the Revision 3 assignment in [PLAN-R3](PLAN-R3.md) §2 and
are the ones that govern who writes what now.

## Preparation evidence reconciliation

These bounded outcomes do not establish the hosted acceptance journey. Final test/build counts, later Node 22 verification and review dispositions are maintained in [CHECKPOINT.md](CHECKPOINT.md). Earlier blocked attempts and failed commands remain preserved in their original evidence records.

| Requirement | Current bounded evidence and remaining scope |
| --- | --- |
| ATT-BASE-01 | Preparation-only fulfillment: actual checkout, scripts/tools and pre-existing-change preservation were inspected and recorded. This status does not certify any hosted capability.<br>[docs/hosted/CHECKPOINT.md](../../docs/hosted/CHECKPOINT.md); [.data-hosted-baseline-20260907/evidence/BASELINE.md](../../.data-hosted-baseline-20260907/evidence/BASELINE.md) |
| ATT-BASE-04 | Preparation-only fulfillment: fresh available baseline checks and known limitations were recorded, including the failed archive fixture run and its verified resolution. Docker remains unavailable; no hosted/provider/browser acceptance follows.<br>[.data-hosted-baseline-20260907/evidence/BASELINE.md](../../.data-hosted-baseline-20260907/evidence/BASELINE.md); [docs/hosted/DECISIONS.md](../../docs/hosted/DECISIONS.md) |
| ATT-ARCH-06 | Bounded progress exists, but the complete required feasibility spike is not implemented or verified. A standalone GET-only binding/settings inspection harness is preparation, not actual package execution, private routing, isolation or build proof.<br>[scripts/hosted-spike/README.md](../../scripts/hosted-spike/README.md); [scripts/hosted-spike/cloudflare-preflight.ts](../../scripts/hosted-spike/cloudflare-preflight.ts); [docs/hosted/CHECKPOINT.md](../../docs/hosted/CHECKPOINT.md) |
| ATT-STATE-04 | Eight real SQLite primitive checks passed on Node 24.19.0; broad driver/runtime/deployment durability selection remains incomplete. Driver not selected, no permission migration, no production volume or power-loss proof. Node 22 evidence is pending integrator confirmation; the independent worker's earlier attempt was blocked.<br>[scripts/hosted-spike/sqlite-feasibility.ts](../../scripts/hosted-spike/sqlite-feasibility.ts); [.data-hosted-baseline-20260907/evidence/sqlite-feasibility.json](../../.data-hosted-baseline-20260907/evidence/sqlite-feasibility.json); [.data-hosted-baseline-20260907/evidence/SQLITE-REVIEW.md](../../.data-hosted-baseline-20260907/evidence/SQLITE-REVIEW.md); [docs/hosted/CHECKPOINT.md](../../docs/hosted/CHECKPOINT.md) |
| ATT-VERIFY-02 | Bounded existing Navigator workspace/permission corrections and regression cases are preparation progress only. The requested two-hosted-app grants, non-workspace recipient, dual publish permissions and hosted fail-closed suite remain unimplemented/unverified.<br>[tests/navigator/server-actions.test.ts](../../tests/navigator/server-actions.test.ts); [tests/navigator/executor.test.ts](../../tests/navigator/executor.test.ts); [docs/hosted/CHECKPOINT.md](../../docs/hosted/CHECKPOINT.md) |
| ATT-VERIFY-10 | Existing local baseline checks and CI source hardening are evidenced, but the complete combined requirement remains incomplete: actual GitHub workflow/Docker execution and hosted security/integration/browser gates are not verified. Final integrated local counts belong to CHECKPOINT.<br>[.data-hosted-baseline-20260907/evidence/BASELINE.md](../../.data-hosted-baseline-20260907/evidence/BASELINE.md); [.data-hosted-baseline-20260907/evidence/CI-HARDENING.md](../../.data-hosted-baseline-20260907/evidence/CI-HARDENING.md); [.github/workflows/ci.yml](../../.github/workflows/ci.yml); [docs/hosted/CHECKPOINT.md](../../docs/hosted/CHECKPOINT.md) |
| ATT-VERIFY-12 | Read-only CI token, disabled persisted checkout credentials, full action SHA pins and Docker context exclusions are implemented and locally policy-tested. Broader approved live-cloud job separation, all dependency pin/review obligations, bounded live costs and test-resource cleanup remain unverified; no actual GitHub or live job claimed.<br>[.data-hosted-baseline-20260907/evidence/CI-HARDENING.md](../../.data-hosted-baseline-20260907/evidence/CI-HARDENING.md); [.github/workflows/ci.yml](../../.github/workflows/ci.yml); [.dockerignore](../../.dockerignore); [docs/hosted/CHECKPOINT.md](../../docs/hosted/CHECKPOINT.md) |

The independent baseline passed 114 files / 1,080 tests under Windows Node 24.19.0 with existing dependencies and isolated data; typecheck, lint, simulated smoke, Gimbal and Next build also passed. Docker was blocked by its daemon, and the archive CRLF test failure/resolution is retained. SQLite's eight real primitive checks do not prove application migration, production-volume durability or power-loss recovery. Cloudflare metadata inspection does not prove runtime execution, authorization or isolation. CI policy-source checks are not an actual GitHub/Docker/live-cloud run.

## Baseline observations, not fulfillment

These original observations were read from the audited checkout. The preceding reconciliation separately links executed preparation evidence. No passing-test claim follows from a test file's existence.

| Requirement | Baseline evidence |
| --- | --- |
| ATT-SCOPE-01 | [src/lib/actions/core.ts:260](../../src/lib/actions/core.ts#L260): Workspace-scoped role enforcement exists and should be preserved. |
| ATT-SCOPE-01 | [tests/auth/session-middleware.test.ts:89](../../tests/auth/session-middleware.test.ts#L89): Current refresh regression cases exist; no execution claim made here. |
| ATT-STATE-01 | [src/lib/db/store.ts:340](../../src/lib/db/store.ts#L340): Existing JSON save is debounced; it is baseline evidence, not transactional hosted authority. |
| ATT-STATE-02 | [src/lib/server/context.ts:200](../../src/lib/server/context.ts#L200): Existing workspace roles may be overwritten from app_metadata.role. |
| ATT-STATE-02 | [src/lib/actions/core.ts:260](../../src/lib/actions/core.ts#L260): Current action enforcement already passes ctx.workspaceId to roleOf; preserve this fix. |
| ATT-ACCESS-01 | [src/lib/domain/types.ts:237](../../src/lib/domain/types.ts#L237): Existing Member models workspace roles; no evidence here of separate hosted app grants. |
| ATT-ACCESS-03 | [src/lib/domain/types.ts:250](../../src/lib/domain/types.ts#L250): Existing workspace invitation lacks hashed token/expiry fields. |
| ATT-ACCESS-03 | [src/lib/server/context.ts:227](../../src/lib/server/context.ts#L227): Existing invitation is accepted implicitly during workspace joining. |
| ATT-ACCESS-04 | [src/app/api/workspace/invites/route.ts:64](../../src/app/api/workspace/invites/route.ts#L64): Existing workspace invite writes settings and returns; this is not a hosted invitation delivery outbox. |
| ATT-ACCESS-07 | [src/lib/auth/session.ts:60](../../src/lib/auth/session.ts#L60): Existing identity uses getClaims and does not retain session_id or live-session proof. |
| ATT-ACCESS-07 | [src/lib/supabase/route.ts:12](../../src/lib/supabase/route.ts#L12): Existing route identity also uses getClaims. |
| ATT-ACCESS-08 | [tests/auth/session-middleware.test.ts:45](../../tests/auth/session-middleware.test.ts#L45): Existing regression cases cover refresh cookies, redirects, deletion batches and outage labels; this inventory does not claim a fresh test run. |
| ATT-ACCESS-09 | [src/middleware.ts:8](../../src/middleware.ts#L8): Current matcher excludes static/image resources; hosted protected asset admission is not established. |
| ATT-ACCESS-10 | [src/lib/server/context.ts:547](../../src/lib/server/context.ts#L547): Current shared route wrapper has no explicit Origin/CSRF gate. |
| ATT-ACCESS-11 | [src/lib/supabase/env.ts:16](../../src/lib/supabase/env.ts#L16): Current configuration predicate supports missing-key local demo behavior. |
| ATT-ACCESS-11 | [src/lib/actions/core.ts:122](../../src/lib/actions/core.ts#L122): Local/empty-member fallback grants admin; hosted separation is not established. |
| ATT-GATE-06 | [src/lib/supabase/env.ts:78](../../src/lib/supabase/env.ts#L78): Current public preview pattern is deliberately narrow; it is not hosted app authorization. |

## Evidence and release discipline

A future acceptance record must include requirement ID, execution date, source/build SHA, environment/provider versions, tester, input, expected/actual results and a sanitized artifact/log link. Provider mocks establish local contract behavior only. Unavailable live environments remain blocked. An agent review does not satisfy independent external security assessment.

The current inventory establishes no hosted end-to-end journey, pilot admission or commercial readiness. The integrator owns the release decision and checkpoint. Reconcile this inventory against the full report before claiming requirement completeness, finalizing diagram-sensitive contracts or translating these proposed groups into a final report matrix.

Validation of this inventory checks JSON parsing, required row fields, ID uniqueness, dependency references, exact source-anchor presence and null report mappings. It is documentation validation, not product acceptance.
