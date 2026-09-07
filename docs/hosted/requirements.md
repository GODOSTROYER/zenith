# Provisional hosted requirements inventory

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

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-BASE-01 | Verify actual branch, HEAD, working tree, diffs, open work, tools and scripts before edits; preserve tracked and untracked changes without reset, clean, stash, history rewrite or secret exposure.<br>**Verify:** Capture sanitized git status/diff and tool/script inventory; compare final changes against preserved baseline. | A | implementation | locally verified |
| ATT-BASE-02 | Obtain and read the complete Revision 2 report, sections 01–25, decisions A01–A09, diagrams D01–D09, tables and security addendum.<br>**Verify:** Attachment presence and complete extraction review; reconcile each report item to matrix. | A | provider/configuration prerequisite | blocked |
| ATT-BASE-03 | Read repository instructions and relevant READMEs; inspect enumerated integration points before replacement; record substantive requirement/code/provider/instruction conflicts.<br>**Verify:** Code-linked baseline audit and decision review covering all named integration points. | A | implementation | not started |
| ATT-BASE-04 | Verify stated baseline behavior and run available baseline checks after script inspection; record actual commands/environment/results/blockers and preserve honest simulation labels.<br>**Verify:** Fresh isolated baseline results for providers, synthetic builds/health, retries, saves and workspace invitations; no historical test-count reuse. | H | implementation | locally verified |

### Supplied instruction section 2

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-TRACE-01 | Maintain machine-readable and readable requirement inventories with every required field, classification/status vocabulary and final report workstream/addendum coverage.<br>**Verify:** Validate JSON schema, IDs, required fields and report traceability; fail final completeness when mappings are unavailable. | A | implementation | not started |
| ATT-TRACE-02 | Treat interviews, customers, payments, independent review, legal approval and YC acceptance as manual evidence obligations; provide accountable supporting checklists without fabricated attainment.<br>**Verify:** Review scorecards/checklists for accountable owners and unknown values; distinguish implementation from business evidence. | G | implementation | not started |
| ATT-TRACE-03 | Demonstrate private publish → separately authenticated invited non-workspace recipient → meaningful durable action → second authorized reader → unauthorized/revoked denial, concurrency safety, compatible data preservation, unhealthy-release rejection and safe recovery.<br>**Verify:** Cross-boundary end-to-end test with distinct identities, restart/redeploy/rollback and revoke checks. | H | implementation | not started |

### Supplied instruction section 3

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-SCOPE-01 | Retain Next.js/TypeScript, Supabase, canonical manifest/typed actions, UI primitives, System Map, history, exports, secrets and optional Navigator/Gimbal; preserve recent visuals and auth fixes.<br>**Verify:** Existing behavior regression tests, no-WebGL/no-LLM operation and reviewed scope diff. | A | implementation | not started |
| ATT-SCOPE-02 | Define one versioned hosted contract for reviewed React/Vite frontend, optional stateless Worker-compatible JS/TS, fixed tracker schema, email identity, private platform subdomain and owner/editor/viewer.<br>**Verify:** Contract fixtures accept supported app and reject unsupported versions, APIs, sources, dependencies and manifests. | A | implementation | not started |
| ATT-SCOPE-03 | Explicitly reject unsupported packages/APIs/manifests/sources; never infer container/Postgres compatibility with Workers/D1; preserve legacy exports with accurate runtime scope.<br>**Verify:** Unsupported-input cases and legacy export regression; new-runtime export claims require import proof. | A | implementation | not started |
| ATT-SCOPE-04 | Exclude general AWS apply, Kubernetes, other clouds, arbitrary Docker/Python/full-Node, arbitrary SQL, destructive schema migrations, generic backend delegation, CRDT/source coediting, enterprise federation, marketplace and automated billing.<br>**Verify:** Scope review confirms exclusions and no unsupported production fallbacks. | A | explicitly deferred work | not started |
| ATT-ARCH-01 | Use persistent singleton Next/Node control service and transactional SQLite as sole critical-control and permission-input authority; never use ephemeral storage or unrelated replica files; no singleton HA claim.<br>**Verify:** Deployment topology/storage validation; startup rejects incompatible configuration. | A | implementation | not started |
| ATT-ARCH-02 | Select durable singleton hosting, or explicitly approve an ADR selecting shared transactional storage if singleton hosting is unacceptable.<br>**Verify:** Recorded host/storage decision, backup persistence evidence and operator approval. | Operator / commercial owner | provider/configuration prerequisite | blocked |
| ATT-ARCH-03 | Validate conditional Workers for Platforms dispatch, isolated immutable releases/assets and per-app D1 through fixed trusted broker before relying on them.<br>**Verify:** Opt-in two-tenant live spike records capabilities, isolation and go/no-go decision. | C | provider/configuration prerequisite | blocked |
| ATT-ARCH-04 | Select disposable isolated customer build environment after validation; E2B is only a candidate; GitHub Actions remains Zenith CI rather than assumed customer-build service.<br>**Verify:** Hostile-build spike and provider decision with actual SDK/version evidence. | D | provider/configuration prerequisite | blocked |
| ATT-ARCH-05 | Select private immutable artifact storage and encrypted off-host recovery provider with access boundaries, lifecycle and tested recovery.<br>**Verify:** Provider/access/lifecycle configuration review and recovery drill. | G | provider/configuration prerequisite | blocked |
| ATT-ARCH-06 | Build bounded feasibility harness using real reference app, two tenants and identities, actual packages, private asset/API routing, fixed bindings, isolated builds, egress restrictions and extraction; produce evidence and decision.<br>**Verify:** Executable local harness plus separately blocked opt-in live runs; no screenshot-only completion. | H | implementation | not started |
| ATT-ARCH-07 | Document provider failure decision and any narrower reviewed-template/concierge or evidence-backed alternative without weakening isolation or authorization; disclose manual assistance.<br>**Verify:** ADR compares failed gates and proposed scope to actual report; manual assistance visible. | A | implementation | not started |
| ATT-ARCH-08 | Verify current official APIs, SDKs, compatibility, terms and costs before reliance; no invented endpoints or unapproved plan purchases.<br>**Verify:** Dated official-source references, pinned versions and approved cost prerequisites. | Operator / commercial owner | provider/configuration prerequisite | not started |

### Supplied instruction section 4

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-TEAM-01 | Agree shared types, APIs/errors, authority boundaries, migration owner, event vocabulary, fixtures and dependency DAG before parallel implementation; one integrator owns shared spine/dependencies.<br>**Verify:** Reviewed contract set and exact per-worker path ownership/change queue. | A | implementation | not started |
| ATT-TEAM-02 | Run independent workers with explicit IDs, exclusive paths, contracts/tests/evidence and isolated directories/ports/fixtures/namespaces; serialize shared migrations and lockfile changes.<br>**Verify:** Ownership collision audit and handoff review; record any unavailable agents/worktrees. | A | implementation | not started |
| ATT-TEAM-03 | Integrate small slices continuously, rerun affected checks and independently review security-sensitive work; agent review is not external certification.<br>**Verify:** Author-independent review artifacts and correction retests. | H | implementation | not started |
| ATT-TEAM-04 | Execute contract/baseline/spike, foundations, full journey and recovery/evidence waves; follow setup with running vertical slice; test doubles never become production fallbacks.<br>**Verify:** Wave checkpoint and integrated slice evidence; production fallback scan. | A | implementation | not started |

### Supplied instruction section 5.A

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-STATE-01 | Transactional sole authority for apps, grants, invitations, sessions/exchanges, jobs/idempotency, selected releases, outboxes and workspace/ownership authorization inputs.<br>**Verify:** Transaction, uniqueness, foreign-key and crash tests; no alternate permission writes. | A | implementation | not started |
| ATT-STATE-02 | Migrate permission readers and writers together, including context and action roles; prohibit competing JSON authority and stale claims restoring revocation; retain legacy projections only under explicit failure contracts.<br>**Verify:** Audit all authorization call sites; revoke then retry through legacy and hosted paths. | A | implementation | not started |
| ATT-STATE-03 | Versioned repeatable migration with pre-backup, integrity/constraint checks, interruption recovery and safe cutover; unreadable existing data never initializes empty authority.<br>**Verify:** Migration replay/interruption/corruption/disk-error fixtures and rollback rehearsal. | A | implementation | not started |
| ATT-STATE-04 | Select maintained driver for pinned Node; verify foreign keys, locking/busy handling, WAL and durability normally synchronous=FULL; distinguish process-kill from power-loss claims.<br>**Verify:** Driver/version compatibility and durability-setting tests plus accurately scoped fault evidence. | A | implementation | not started |
| ATT-STATE-05 | Commit critical mutations, operation state and outbox intent before acknowledgement.<br>**Verify:** Interrupt before/after commit and acknowledgement; verify no acknowledged lost operation. | A | implementation | not started |
| ATT-STATE-06 | Persist UUID idempotency scoped to actor/workspace/app and SHA-256 canonical full intent including artifact/config/schema/secret-version references; same intent resumes, changed intent conflicts, replay reauthorizes.<br>**Verify:** Concurrent identical keys, changed intent, process restart, replay after revoke. | A | implementation | not started |
| ATT-STATE-07 | Durable single-flight admission, fenced deployment ownership and persisted phases/resource IDs/outcomes; jobs continue without requests and resume after restart.<br>**Verify:** Concurrent publish, stale lease/callback, disconnected browser and restart phase tests. | D | implementation | not started |
| ATT-STATE-08 | Reconcile cloud success/lost acknowledgement without blind duplicate effects or exactly-once external claims; retry/cancel/cleanup preserve active release and app data.<br>**Verify:** Inject ACK loss at each provider effect and verify reconciliation/cleanup fences. | D | implementation | not started |
| ATT-STATE-09 | Hosted management uses typed authorization/plan/audit extensions; recipient CRUD is independent of workspace wrappers; async accepted jobs are not reported live.<br>**Verify:** Non-workspace recipient CRUD plus management permission/plan/audit tests and status presentation. | A | implementation | not started |

### Supplied instruction section 5.B

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-ACCESS-01 | Separate app-use grants from workspace roles: owner/editor/viewer read, owner/editor create/update, viewer no mutations, owners alone manage grants/publish, publishing also requires workspace action permission.<br>**Verify:** Two-app/two-workspace role matrix; recipient lacks workspace; app-owner without publish permission denied. | B | implementation | not started |
| ATT-ACCESS-02 | Workspace admin never implicitly grants app data access; define explicit initial app owner and transactional last-owner protection; unnecessary transfer UI remains outside scope.<br>**Verify:** No-grant admin denial, initial owner approval, concurrent last-owner removal tests. | B | implementation | not started |
| ATT-ACCESS-03 | Durable app/email-bound random invitation tokens hashed at rest, single use, 48-hour expiry, atomic acceptance and resend invalidation; match currently verified authenticated email.<br>**Verify:** Wrong/forwarded email, expiry boundary, replay and concurrent send/accept/revoke/resend tests. | B | implementation | not started |
| ATT-ACCESS-04 | Transactional invitation delivery outbox with bounded retries and visible failures; distinguish SMTP sent from delivered; external email tests require authorization.<br>**Verify:** Crash/ACK-loss/retry tests and UI delivery-state assertions; separately authorized live delivery. | B | implementation | not started |
| ATT-ACCESS-05 | Separate control/app registrable domains and exact callback allowlists; app-bound short-lived single-use exchange bound to validated browser state and redirect after server identity verification.<br>**Verify:** Wrong origin/state/app/callback, malformed redirects and exchange replay tests. | B | implementation | not started |
| ATT-ACCESS-06 | Atomically consume exchange into opaque app session with host-only Secure/HttpOnly cookie, preferably compliant __Host- prefix; no refresh token or platform credential exposure to editable app code/storage.<br>**Verify:** Cookie attributes, session fixation, cross-app replay, browser storage and forwarded credential inspection. | B | implementation | not started |
| ATT-ACCESS-07 | Define identity-session termination independently of grant revocation; verify issued-token-after-signout behavior against current Supabase docs and implement required authoritative session check; getClaims/getUser naming alone is insufficient.<br>**Verify:** Old JWT after signout, missing/mismatched session ID, timeout/deleted session and policy-service outage; opt-in actual provider flow. | B | implementation | not started |
| ATT-ACCESS-08 | Preserve refreshed cookies and no-cache headers through redirects/errors.<br>**Verify:** Retain existing multi-batch refresh/deletion/outage tests and add cache-header propagation. | B | implementation | not started |
| ATT-ACCESS-09 | Every new protected page/asset/API admission checks live grant and valid session without positive permission caching; revoke commits before ACK and next request denial; document bounded in-flight/download limits and no SQLite/D1 distributed atomicity claim.<br>**Verify:** Revoke then page/asset/API/HEAD/range requests, multihost checks and concurrent in-flight write behavior. | B | implementation | not started |
| ATT-ACCESS-10 | Cookie mutations require exact Origin and CSRF, including sibling-app attacks; GET/HEAD mutations and wildcard credentialed CORS are rejected.<br>**Verify:** Missing/null/forged/sibling Origin, CSRF mismatch, method override and CORS matrix. | B | implementation | not started |
| ATT-ACCESS-11 | Hosted mode fails closed on missing/partial auth; no inherited no-key demo admin or empty-workspace promotion; explicitly separate local demo.<br>**Verify:** Missing URL/key/policy configuration and empty-membership hosted denial; explicit local demo regression. | B | implementation | not started |

### Supplied instruction section 5.C

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-GATE-01 | Trusted gateway reserves /_zenith/data/* for platform broker A statically bound to D1 A; other requests invoke selected immutable app worker only after admission; repeat complete isolation unit per app.<br>**Verify:** Reserved-route precedence, per-app binding audit and denial-before-customer-code counter. | C | implementation | not started |
| ATT-GATE-02 | Resolve exact host/app/active-release/broker using authoritative mappings; reject unknown hosts and request-controlled tenant/database/broker selectors.<br>**Verify:** Unknown/malformed host, spoofed forwarded headers and cross-app selector tests. | C | implementation | not started |
| ATT-GATE-03 | Trusted infrastructure sends audience/app/request-bound broker context; broker independently validates current grant and semantic operation instead of trusting browser role headers.<br>**Verify:** Forged/replayed/mismatched context and revoked grant at broker tests. | C | implementation | not started |
| ATT-GATE-04 | Editable backend receives no D1/admin/dispatch binding, platform session/JWT or delegated data capability; strip platform credentials and spoofable identity headers and audit deployed bindings.<br>**Verify:** Adversarial worker inspects env/headers and attempts direct broker/data access. | C | implementation | not started |
| ATT-GATE-05 | Gateway controls response headers/cookies/redirects/caching; customer code cannot replace security policy; authenticate assets and reject alternate-origin/preview/worker URL bypass.<br>**Verify:** Hostile Set-Cookie/location/cache/CORS/CSP responses and direct asset/origin access. | C | implementation | not started |
| ATT-GATE-06 | Audit existing public preview; preserve honest public simulation without private hosted deployment/metadata leakage and never use it as live auth boundary.<br>**Verify:** Legacy public simulation tests plus hosted IDs/metadata negative cases. | C | implementation | not started |
| ATT-GATE-07 | Default-deny server egress with explicit allowlists and bypass tests; treat bindings, network rules and browser CSP as distinct controls.<br>**Verify:** Redirect/DNS/address/protocol/subrequest bypass and binding-vs-network isolation tests. | C | implementation | not started |
| ATT-GATE-08 | Platform-owned restrictive script/connect/form/frame policy appropriate to reviewed frontend; service-worker/offline caching deferred; disclose malicious authorized frontend limitations.<br>**Verify:** Reviewed CSP browser tests, service worker denial and threat-model limitations. | C | implementation | not started |
| ATT-GATE-09 | Enforce unknown-host 404, controlled sign-in/401 for missing identity, grant denial 403, policy/identity unavailable 503, quota 429; no editable-code/data invocation on denial; sensitive responses no-store.<br>**Verify:** Status/error contract tests with customer invocation sentinel and cache inspection. | C | implementation | not started |

### Supplied instruction section 6

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-UX-01 | Wire source validation, audience/limits, real progress/fail/cancel, private URL, invite/resend/revoke/roles, releases/rollback, actual health/logs, export and recovery status to backend.<br>**Verify:** End-to-end each control reaches real operation; loading/empty/error tests and operator-status visibility. | F | implementation | not started |
| ATT-UX-02 | No dead controls, fake progress/success, mock counts or hidden founder repair; retain infrastructure views without requiring them for recipients.<br>**Verify:** Review labels with backend evidence; recipient journey never requires workspace infrastructure UI. | F | implementation | not started |
| ATT-UX-03 | Test fresh-browser/mobile/keyboard, loading/empty/errors, focus/readability/reduced-motion and no-WebGL/no-LLM; use existing tokens/components/import conventions.<br>**Verify:** Browser/device/keyboard/accessibility matrix and existing component/import checks. | F | implementation | not started |
| ATT-UX-04 | Reduce unnecessary waterfalls/heavy client code without weakening fresh authorization.<br>**Verify:** Measure representative load and verify each protected admission still checks authority. | F | implementation | not started |
| ATT-OPS-01 | Implement configurable initial build/runtime/request/data limits: one build/app, two pilot-wide, five-minute build, 50 ms CPU, five outbound subrequests, 1 MB body, 10,000 requests/app/day, 100 MB data.<br>**Verify:** Boundary/over-limit/reset/race/restart tests for every listed limit; compare actual provider capabilities. | C | implementation | not started |
| ATT-OPS-02 | Define measurement and atomic quota enforcement for storage/concurrent requests; label application limits rather than provider guarantees and disclose unsupported enforcement.<br>**Verify:** Atomic admission/storage races, bypass/reset/restart tests and UI enforcement-vs-display audit. | C | implementation | not started |
| ATT-OPS-03 | Per-app suspension/kill switch blocks service without deleting data.<br>**Verify:** Suspend/resume requests and verify preserved data, grants and artifacts. | C | implementation | not started |
| ATT-OPS-04 | Consistent encrypted off-host backups and immutable artifacts with key recovery; distinct code rollback, app-data restore and control-host recovery procedures; WAL-aware backup/checksums/metadata/retention.<br>**Verify:** Backup under concurrent writes, checksum/key corruption, retention/reference and restore validation. | G | implementation | not started |
| ATT-OPS-05 | Test clean-host recovery including recovered keys and provider reconciliation.<br>**Verify:** Isolated clean host restore drill with recorded source/target versions and timings. | G | implementation | not started |
| ATT-OPS-06 | Recovery pauses affected writes/sharing, preserves evidence/current exports, explains cutoff/lost writes, reconciles newer off-host revocations and requires access/data checks plus authorized reopening.<br>**Verify:** Restore older control/data snapshots after revoke; admission remains closed until reconciliation and approval. | G | implementation | not started |
| ATT-OPS-07 | Without current revocation evidence, invalidate restored grants and require owner reapproval; session clearing alone is insufficient.<br>**Verify:** Missing/corrupt/stale revocation evidence restore tests deny former recipients. | B | implementation | not started |
| ATT-METRIC-01 | Structured events use report identifiers/timestamps/outcomes, never customer content/credentials; deduplicate logical operations and retain failures.<br>**Verify:** Schema/privacy/redaction and logical-deduplication tests; final vocabulary reconciliation requires report. | G | implementation | not started |
| ATT-METRIC-02 | Track activation, sent-vs-delivered invitations, meaningful non-builder actions, days-7–13 matured return cohorts, assistance, release failures, denial, costs and support effort.<br>**Verify:** Synthetic privacy-safe cohort fixtures for maturity boundaries and correct event attribution. | G | implementation | not started |
| ATT-METRIC-03 | Exclude founder/test/demo accounts from aggregates; distinguish pilot acceptance, invoices and collected payment; empty evidence remains zero/unknown attainment.<br>**Verify:** Filtering/payment-state fixtures and empty-scorecard truthfulness tests. | G | implementation | not started |
| ATT-TRUST-01 | Prepare stage-appropriate privileged MFA/least privilege, scoped credential/rotation, monitored support access and compromise-response controls.<br>**Verify:** Configuration/runbook review, authorized privilege/rotation/support-audit tests; manual attestation separate. | G | implementation | not started |
| ATT-TRUST-02 | Implement tamper-resistant off-host audit evidence; never describe local append-only files as tamper-proof.<br>**Verify:** Local tamper/deletion detection and off-host retention/access-boundary tests. | G | implementation | not started |
| ATT-TRUST-03 | Maintain provider/region/data-exposure map, retention/deletion/backup-expiry policy, export/import proof, privacy/support/incident drafts and applicable ASVS checks.<br>**Verify:** Report/addendum checklist review and documented ASVS test evidence; legal approval remains manual. | G | implementation | not started |
| ATT-TRUST-04 | Authorized app/data deletion and backup expiry with audit/restore safeguards; disclose retained-backup windows rather than immediate universal erasure.<br>**Verify:** Permission/confirmation deletion tests, backup-expiry schedule and restore resurrection prevention. | G | implementation | not started |
| ATT-TRUST-05 | Disclose privileged plaintext access and absence of end-to-end encryption without invented legal commitments/compliance claims.<br>**Verify:** Data-flow/support-access disclosure review against actual deployed boundaries. | G | implementation | not started |
| ATT-BIZ-01 | Prepare discovery/onboarding logs, pilot/support terms for review, payment-state records, honest scorecards, reproducible demo and YC evidence checklist.<br>**Verify:** Template existence and empty-data honesty review; demo script reproducibility. | G | implementation | not started |
| ATT-BUDGET-01 | Track budget and 50/75/90% alerts; pause new builds at 90% of approved configured envelope without indiscriminately stopping useful running apps; disclose billing lag.<br>**Verify:** Threshold crossings, delayed costs, restart/concurrent admission and existing-app continuity tests. | G | implementation | not started |
| ATT-BUDGET-02 | Approve cost envelope and spending/provider choices; report's $300 envelope is unconfirmed and no absolute spend guarantee is possible with billing lag.<br>**Verify:** Dated operator approval and provider-cost review; never infer approval from presence of credentials. | Operator / commercial owner | operator/commercial obligation | blocked |
| ATT-OPS-08 | Measure proposed RPO ≤24 hours and RTO ≤4 hours using actual recovery drill; never claim achieved from procedures alone.<br>**Verify:** Timed clean-host drill with measured recoverable cutoff and restoration completion. | G | experiment/target | not started |
| ATT-OPS-09 | Obtain explicit approval for in-place data restore and authorized confirmation before reopening recovered service.<br>**Verify:** Recorded bounded restore authorization and post-check reopening confirmation. | Operator / commercial owner | operator/commercial obligation | blocked |
| ATT-BIZ-02 | Collect actual interviews/customer/revenue/testimonial/founder/review evidence without fabrication; record dates and verify current submission rules when relevant.<br>**Verify:** Evidence provenance and permission audit; unknown facts stay unknown. | Operator / commercial owner | operator/commercial obligation | not started |
| ATT-BIZ-03 | Treat five activations/two paid-pilot acceptances by October 6 and three eligible returning teams by October 11 as unachieved targets, not YC requirements; confirm applicable target year/date context.<br>**Verify:** Dated cohort/payment evidence evaluated only when eligible; target calendar verified with report. | Operator / commercial owner | experiment/target | not started |

### Supplied instruction section 5.D

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-BUILD-01 | Implement pinned-source bounded-intake isolated-build immutable-artifact private-candidate authenticated-verification durable-activation pipeline to stable URL.<br>**Verify:** End-to-end actual package build and private release activation; doubles separately labeled. | D | implementation | not started |
| ATT-BUILD-02 | Validate source identity/contract, archive paths/sizes/symlinks/decompression limits and remote-fetch boundaries.<br>**Verify:** Traversal, symlink, archive-bomb, oversized source, remote SSRF and wrong commit tests. | D | implementation | not started |
| ATT-BUILD-03 | Never execute submitted install/build code on developer/control/publisher/CI management hosts; isolated environment has no platform/admin/runtime credentials, DB, shared Docker socket or cross-tenant cache.<br>**Verify:** Hostile build probes permissions/files/secrets/socket/cache; verify isolated process boundary. | D | implementation | not started |
| ATT-BUILD-04 | Fixed approved recipe/toolchain and lockfile with bounded network/resources/time, scoped source/artifact access, bounded redacted logs, cancellation and verified teardown; submitted repo cannot replace workflow.<br>**Verify:** Recipe override, exhaustion/timeout/cancel, log secret/size, teardown and egress tests. | D | implementation | not started |
| ATT-BUILD-05 | Trusted publisher separated by process/permissions independently checks artifact digest and source/job identity; record commit, lock fingerprint, contract/toolchain, asset manifest and SHA-256.<br>**Verify:** Tamper/provenance mismatch and confused-job extraction tests; immutable manifest verification. | D | implementation | not started |
| ATT-BUILD-06 | Treat FNV as non-integrity and digest identity as non-safety; enforce required source/release approval.<br>**Verify:** Unapproved correctly hashed artifact cannot activate; approval tied to immutable intent. | D | implementation | not started |
| ATT-BUILD-07 | Immutable release IDs and durable selected pointer; real endpoint/package/create/read probes use separate test broker/DB; production schema/bindings read-only; unhealthy/partial candidates remain inactive.<br>**Verify:** Probe failure/partial resource refusal, test-data isolation and live binding read-only evidence. | D | implementation | not started |
| ATT-BUILD-08 | Updates preserve stable URL/data and recorded compatibility/schema versions; only reviewed additive/backward-compatible changes; rollback selects compatible code without rewinding data.<br>**Verify:** Compatible redeploy/rollback preserves records; destructive/incompatible schema rejected. | D | implementation | not started |
| ATT-BUILD-09 | Cleanup preserves resources referenced by active release, rollback, backups and retention.<br>**Verify:** Concurrent cleanup/activation/rollback and retained-reference tests. | D | implementation | not started |

### Supplied instruction section 5.E

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-DATA-01 | Implement fixed reviewed request/equipment tracker with bounded list/read/create/update, validated fields, parameterized SQL, pagination, semantic role checks and app isolation; reject arbitrary SQL/privileged operations/destructive schema.<br>**Verify:** Real fixture CRUD, field/query limits, SQL injection, pagination and two-app role matrix. | E | implementation | not started |
| ATT-DATA-02 | Atomic optimistic record-version concurrency returns 409 on stale update, with no read/write race or silent last-writer-wins.<br>**Verify:** Simultaneous expected-version updates yield one success and one conflict. | E | implementation | not started |
| ATT-DATA-03 | Persist write ID/full intent/result in same data transaction; retry lost ACK without duplicate creation and reauthorize before returning cached results.<br>**Verify:** Duplicate/concurrent write IDs, changed intent, lost ACK and retry after grant revoke. | E | implementation | not started |
| ATT-DATA-04 | Show Saved only after durable ACK; preserve proposed edits on conflicts/recoverable errors and offer explicit reload/retry.<br>**Verify:** Slow/error/409 UI tests preserve unsaved input and prevent premature Saved state. | F | implementation | not started |
| ATT-DATA-05 | Verify second permitted identity sees persisted action across refresh, runtime/control restart, compatible redeploy and rollback.<br>**Verify:** Separate browser contexts and persistence/restart/release matrix. | H | implementation | not started |
| ATT-DATA-06 | Provide supported browser data interface and working fixture; optional editable handlers remain stateless without delegated DB access.<br>**Verify:** SDK contract and fixture integration tests; handler capability negative tests. | E | implementation | not started |
| ATT-DATA-07 | Export source, appropriate artifacts, schema, records and access manifest with documented import/exit test; CSV alone is not universal portability.<br>**Verify:** Round-trip import into clean target and verify records/access metadata/limitations. | G | implementation | not started |

### Supplied instruction section 6/7

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-TRUST-06 | Obtain stage-appropriate independent external security assessment, legal/terms review and required trust attestations; agent review is not external certification.<br>**Verify:** Named independent reviewer, dated findings/disposition and approved legal/trust records. | Operator / commercial owner | operator/commercial obligation | blocked |

### Supplied instruction section 7

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-VERIFY-01 | Executable unit/contract/integration/browser and opt-in live-cloud suites; mocks never establish live isolation/delivery/recovery; unavailable environments are blocked.<br>**Verify:** Test inventory maps all boundary rows and labels actual execution environments. | H | implementation | not started |
| ATT-VERIFY-02 | Adversarial app/workspace role, non-member recipient, dual publish permission and hosted fail-closed matrix across two tenants.<br>**Verify:** Executable cross-tenant/access integration suite. | H | implementation | not started |
| ATT-VERIFY-03 | Attack email/token invite lifecycle, resend races, callback/state/origin, exchange replay/app mismatch, issued token after signout, grant revoke and restored older permissions.<br>**Verify:** Independent invite/session/recovery adversarial suite plus authorized opt-in provider test. | H | implementation | not started |
| ATT-VERIFY-04 | Attack direct page/asset/API/origin, unknown host, forged context, cross-app bindings, sibling CSRF, method/CORS and credential/cache leakage; denial must not invoke editable code.<br>**Verify:** Independent gateway/broker browser and contract tests with invocation sentinels. | H | implementation | not started |
| ATT-VERIFY-05 | Attack viewer methods, malformed/oversized data, version races, duplicate/changed write IDs, lost ACK and retry after revoke.<br>**Verify:** Independent transactional CRUD race/fault suite. | H | implementation | not started |
| ATT-VERIFY-06 | Attack hostile install/build, archive traversal/bombs, platform secrets, egress restrictions, exhaustion/timeouts/cancel, extraction/provenance and cleanup isolation.<br>**Verify:** Hostile isolated build fixtures with measured limits and teardown evidence. | H | implementation | not started |
| ATT-VERIFY-07 | Test concurrent publishes, interruption every external phase, cancel/stale callbacks, lost cloud ACK, immutability, isolated probes, unhealthy rejection and data-preserving rollback.<br>**Verify:** Independent release state-machine/crash/reconciliation suite. | H | implementation | not started |
| ATT-VERIFY-08 | Fault-test migration/corruption, SIGKILL, disk-full/write failures, backup/key failure, clean-host restore/stale grants, quota races/reset/restart, suspension retention and dependency outages.<br>**Verify:** Isolated state/recovery/quota fault suites; no developer/customer data. | H | implementation | not started |
| ATT-VERIFY-09 | Run actual separate-browser builder → recipient → persist → update → revoke, keyboard/mobile and honest real/simulated presentation plus privacy-safe cohort tests.<br>**Verify:** Browser recordings/assertions and sanitized metrics fixtures tied to source SHA. | H | implementation | not started |
| ATT-VERIFY-11 | Never weaken/delete tests, hide failures, blanket-suppress or silently skip suites; investigate actual workflow failures rather than trusting hosting status.<br>**Verify:** Review CI/test diff and enumerate executed/blocked suites with exit statuses. | H | implementation | not started |
| ATT-VERIFY-12 | Separate unprivileged PR tests from approved live-cloud jobs; protect credentials from untrusted code, pin/review dependencies/actions, bound live costs and clean only test-owned resources.<br>**Verify:** Workflow syntax/permissions/pin review; resource prefix and budget cleanup tests. | H | implementation | not started |
| ATT-VERIFY-13 | Acceptance records include requirement/date/source+build SHA/environment+provider versions/tester/input/expected+actual/sanitized artifact; independently review high-risk diffs, retest corrections and uncovered requirements.<br>**Verify:** Schema validation and requirement-to-evidence audit with independent review provenance. | H | implementation | not started |
| ATT-VERIFY-14 | Separate local, supervised low-criticality real-data pilot and broader commercial gates; pilot requires access/isolation/roles/revoke/durability/quotas/export/recovery; broader rollout needs external trust evidence and resolved blockers.<br>**Verify:** Release gate checklist refuses promotion when required evidence absent or mocked. | H | implementation | not started |

### Supplied instruction section 1/7

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-VERIFY-10 | Inspect and run typecheck/lint/tests/smoke/Gimbal/production Next/Docker where supported; add hosted security/integration/browser and workflow-syntax gates; all required release checks block CI.<br>**Verify:** Exact command/result artifacts and CI regression tests against continue-on-error/missing gates. | H | implementation | not started |

### Supplied instruction section 8

| ID | Requirement / acceptance scope | Owner | Classification | Status |
| --- | --- | --- | --- | --- |
| ATT-HANDOFF-01 | Continue authorized reversible work despite live blockers; finish adapters/config validation/opt-in tests/operator instructions; no fake-success production stubs; ask only consequential missing inputs.<br>**Verify:** Production path review, explicit missing-input inventory and executable opt-in harness. | A | implementation | not started |
| ATT-HANDOFF-02 | Explicit approval required for billable provisioning, production DNS/data changes, customer messages, destructive restores, subscriptions/charges and YC submission; secrets stay out of committed files/logs.<br>**Verify:** Scoped approval records before consequential external action; sanitized logs/config references. | Operator / commercial owner | operator/commercial obligation | not started |
| ATT-HANDOFF-03 | Use reviewable feature branch without unrequested push/merge/force-push; maintain wave/context checkpoint including integrated work, owners/contracts/next steps/tests/blockers/changed files.<br>**Verify:** Git and checkpoint review; another session can resume without overwriting ownership. | A | implementation | not started |
| ATT-HANDOFF-04 | Final report includes implemented paths, baseline/final SHAs/diff, requirement/exclusion/manual coverage, exact local/mock/live results, demonstrated journey, threats/recovery risks, deployment/rollback instructions, prioritized blockers and pilot/commercial go/no-go.<br>**Verify:** Evidence-linked release review; reject completion based only on screens/compile/upload/happy path. | A | implementation | not started |

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
