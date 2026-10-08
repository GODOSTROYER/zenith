## Approval fixture diagnosis correction and mixed validation, 8 October 2026

The previous publication described six failures as missing approval-audit events after a successful approval. Inspection of the exact failure diffs disproved that description: both c7332a56 and diagnostic63a4192a fail the earlier approved_semantics row assertion before approval executes. Counts97/6/0 are unchanged; the reported stage was wrong. The native fixture inherited MemorySemanticsStore from its fake world while production composition supplies createPlatformSemanticsStore. The corrective fixture must wire the actual PostgreSQL semantics store, preserve preapproval durable binding, explicit human review, actual audit-write proof and all authority controls. No production audit failure has been demonstrated by these attempts.

Integrated dd1d4858 validates mixed run state before any durable create/save and checks environmentId/desiredDigest on read. Root owned serial run:12 passed /0 failed /0 skipped on native PostgreSQL16.15, PGlite and memory; parent exit0, PostgreSQL stop0 and data/socket removal. Compiler and touched-source lint passed. The migration41 nullable database constraint gap remains open and is not closed by application validation. No schema44 is included.

Fresh65b24ccc CI supply-chain failed for Next15.5.24, GHSA-4jqv-mc3x-m676 and GHSA-mcj8-r9mp-w47p. Official Next15.5.27 release fixes both. Latest user instruction to fix remaining failures authorizes this exact bounded security patch and mandatory version-coupled @next/env/SWC companions; no general upgrades or exceptions. Existing lint override, Sharp, React and unrelated dependencies must remain unchanged. Source-reviewed disposition found the advisories' specific Pages Router/root catch-all prerequisites absent from current App Router source; the mandatory security gate still blocks. Fresh install, full audit, compiler/lint, standalone build and package checks remain required before acceptance.

# Verification repair decisions, 8 October 2026

## Authority and scope

User authorized fixing every remaining test failure and iterating until gates genuinely pass. This authorizes bounded regression repairs across previously reserved builder areas; it does not authorize new features, live cloud calls or spending, destructive retention, live production deployments or operations, history rewrites, published migration changes, or weaker gates. Commit author and committer remain Arnav Bule. Astra ultra provides independent engineering review; its decisions do not impersonate browser-human product approvals or grant external-account authority.

Baseline: published `6a82cc4c9368c5194727d2f8e06a2becc069ed24`. Main CI run `37670974784` finished with nine successful and seven failed jobs. Reconciliation additionally failed one schedule-restart case with 37 passed and one failed; timeout cause remains under investigation. Separate native architecture runs require their own inspection. Prior `9b568108` evidence remains historical, not current green evidence.

## Review decisions and execution

- Astra: retain exact approval `semanticsDigest` guard. Repair positive callers/fixtures using the immutable reviewed operation digest; missing, changed and stale digests must refuse. Never infer human approval from a server-populated digest.
- Astra corrected its initial upgrade recommendation after checking actual classification: schema12 to current would require unregistered historical contract admissions. Accepted historical fixture instead preserves schema12, proves standing-grant table absent and removes only its optional modern broker port in test composition. Same-owner schema6 fixture explicitly constructs canonical historical7–11 before running actual migration12. Current production admission and store composition stay unchanged; native historical execution remains pending.
- Astra: baseline-version digit validator typo is a bounded production repair. Preserve contract/drained-writer admission and add malformed-value controls.
- Astra: environment concurrency preflight currently infers idle when authoritative reads fail and no active product projection exists. Fail closed with explicit unavailable state; verify zero downstream mutations. Accepted production safety repair `e67c652f813ae5121386d1558ba958507fb2a6de` includes explicit unavailable messages and18 focused action cases. Core seven-file worker evidence195 passed /0 failed /2 skipped does not include native tombstone execution. Root rerun remains pending.
- Astra accepted provider fixture packet `d249fe9ce5c53d4f2a1f91b8bf030a3f4c997a01`: valid ACR identifier, existing operation authority, bounded cleanup timing, actual pagination fixture, and explicit absent reviewed-address inputs. Production code unchanged. Worker executed 77 passed / 0 failed / 0 skipped; root rerun and integration pending.
- Root repaired documentation/source pins and current wiring assertions. Operator documentation suite: 59 passed / 0 failed / 0 skipped on Node22.23.3. Initial successor attempt exposed another stale Azure audience assertion, preserved as 58 passed /1 failed before corrected cloud-derived audience check. This is source/documentation evidence, not operated default-stack evidence.
- Astra: canonical PostgreSQL evidence matcher must recognize actual complete backend labels used by newly registered suites while rejecting PGlite, title-only and malformed ancestry. Preserve all required IDs. Historical fixture projections exclude only explicitly pinned new cohort IDs; missing source directories remain production errors.

## Resources and remaining evidence

Two isolated owned repair worktrees share installed dependencies; one focused test workload at a time. No Docker or default API startup during this batch. Available disk approximately19GiB, below22GiB continuous heavy-work floor. Storage helper contacted under existing user authorization, with active worktrees, source, credentials, evidence and installed dependencies protected. Heavy default acceptance remains blocked until adequate headroom returns. Lightweight source fixes continue.

All78 requirements and four false release states remain preserved. No new requirement is verified by these partial checks. Next: finish reviewed corrections, root reruns, coherent integration, combined gates, normal pull/merge/push and exact-SHA CI inspection. Pending and external evidence remain open.

## Additional reviewed packets

- Authority packet `7b438bec`: missing workspace request uses an explicit omission; scoped SDK tool refusal includes no broker proposal; each bridge test resets owned runtime quotas while preserving tenant-qualified signals and lost-response uncertainty; explicit build-egress fixture has no permitted mutation/SQL fallback. Worker broader rerun87 passed /0 failed /0 skipped. Root rerun pending.
- Protocol/session packet `3d205d8e77af88564353d852183326e6b724bed7`: owned MySQL protocol peer now preserves buffered ClientHello bytes through public duplex transport. TLS identity verification and production transport are unchanged. Scoped guest fixture, actual OCI operation authority, expected decrypt-only history, repeated403 propagation and startup composition boundaries corrected. Worker104 passed /0 failed /1 skipped (real MySQL engine), then stronger Azure assertion6 passed /0 failed /0 skipped. Astra source review accepted. Counts overlap.
- Root canonical CI fixture successor run663 passed /2 failed /0 skipped. Corrected final historical projections; focused successor4 passed /0 failed /274 filtered siblings. Full combined successor remains pending. Preserve all1140 platform and70 workflow obligations; historical comparisons remove only16/eight exact IDs, with unknown same-file successors visible.
- Root SQL repairs replace dynamic state-recovery statement fragments with fixed statements while retaining workspace/id/status CAS, expiry rules and bound parameters. Incident timestamp formatting is equivalent fixed SQL. Astra independently accepted; behavior and static-scoping reruns pending.
- Kubernetes native execution exposed missing rendered-plan semantics binding. Implementation and independent review underway; no approval or engine bypass permitted.
- Storage helper recovered57.8MiB cache; requested bounded recoverable archival of positively dormant verifier worktrees. Heavy local acceptance floor remains binding.

- Default composed approval exposed a real bridge omission: strict broker requires reviewed executable semantics but legacy action/bridge forwards only plan digest. Bounded fix must carry an explicit human-reviewed semantics digest; never infer or auto-fill authority. Local composed successor45 passed /1 failed /6 skipped across three files, including actual Temporal siblings unavailable in this source-only profile. Repair under Astra review.

## Independent root successor checks

Root frozen integration tree `8b425224` plus explicitly recorded root diff contains reviewed authority and provider packets. This is a candidate with uncommitted changes, not evidence for the clean `8b425224` commit alone.

- Authority first two packets: root 264 passed /0 failed /2 skipped across ten suites. Historical PostgreSQL tombstone execution is not included.
- Provider first two packets: root 181 passed /0 failed /1 skipped. The skipped real MySQL engine case still requires separate execution.
- Combined 21-suite attempt: 1130 passed /2 failed /12 skipped. Both new failures preserved: the cost scanner matched explanatory comments in its own implementation, and the migration inventory misclassified global key-custody metadata. Two requested path filters did not correspond to suites; actual SQL-scoping path was then executed in the successor.
- Five-suite successor: 77 passed /1 failed /11 skipped. Cost comments now pass, actual SQL-scoping and repository behavior checks pass within that scope. Migration inventory then exposed `mcp_stream_events` missing its tenant-leading index. Investigation remains open; no tenant invariant was weakened.
- Astra accepted final native Kubernetes commits `62282985` and `70c4a720`, final root diff, and the two subsequent focused corrections. Acceptance is source review only. Native script-change control refuses changed executable effects with zero additional writes; current canonical obligations remain1140 PostgreSQL and70 workflows.

Storage helper archived46 positively dormant verifier worktrees with recoverable backups and preserved active repairs. Net reclaimed2.72GiB after backups; subsequent root free disk approximately24.4GiB. Earlier19GiB blockage is superseded for current lightweight/native work; continuous22GiB heavy-work floor remains binding. No global Docker prune or unrelated deletion.

## Native reconciliation successor and pending index repair

Canonical reconciliation executed on frozen candidate plus root diff:38 passed /0 failed /0 skipped, all26 mandatory groups, parent exit0. Native Darwin ARM64 PostgreSQL16.15 and Temporal CLI1.9.1; includes real schedule restart, bounded database outage/recovery, fleet-lease exclusion and cancellation controls. PostgreSQL stop exit0 and owned data/socket removed; test-owned Temporal stopped. Minimum free disk27,071,913,984bytes, above23,622,320,128byte floor. Initial controller startup failed before tests because an owned Unix-domain socket path exceeded PostgreSQL's103-byte limit; shortened private owned socket path and retained failed attempt. Integrated schedule correction `4f1f4441`; exact full candidate/CI successor still pending.

Compiler attempt with3GiB heap exited134 with JavaScript heap exhaustion, not a compiler pass or diagnosed source error. Prior4GiB compiler success was historical; new coherent candidate needs a fresh4GiB attempt with continuous disk-floor monitoring.

Astra accepted additive43 proposal after complete schema inventory:92 tenant tables,91 already indexed; only `mcp_stream_events` missing workspace-leading index. Proposed nonunique(workspace_id,stream_id,seq) matches scoped replay query. New migration/snapshot must preserve35/42/0024, keys/RLS/ACL/rows and42's contract admission. Standard index creation may block writers; no live or zero-downtime approval implied. Final source and native upgrade proof pending.

Current6a native CI runs inspected independently: platform run37670974634 completed linux-systemd and windows-acl successfully; worker run37670974732 completed native AMD64 and ARM64 jobs successfully. These are historical6a results, not acceptance of changed candidate bytes.

## Coherent integration and remaining native findings

Integrated reviewed packets: authority `ee087577`, `4f1eeac3`, `c8cd79c8`; provider `6c6c9e13`, `bd4ee5c3`; native semantics `938e39d0`; inventory `0bbdd943`; root mandatory identities `d9ff3612`, fixed scoped SQL `d2c4b7dd`, operator/metadata fixtures `5e492144`; schedule `4f1f4441`; additive schema43 `4a4683a1` and current inventory `187f039b`. All Arnav author/committer; normal history preserved.

The new native MCP index obligation increases platform groups from1140 to1141. Historical projections now remove17 precisely pinned successor IDs while current discovery requires every one; unknown successor IDs remain visible. New0025 appended, old snapshots retained; historical42 repair rehearsal stays scoped through42. Schema43 worker2 passed /0 failed /1 native PostgreSQL unavailable; root native proof pending. Astra accepted exact six-file schema/snapshot and preservation tests.

Canonical workflow-intents on4f source:154 passed /2 failed /0 skipped,141 groups, exit1. The execution receipt also became source-mismatched because inventory corrections changed tracked inputs while this attempt ran; preserve failure, freeze tracked inputs on successor. Both native failures are historical schema12 ACL cases. Modern helper deliberately rebinds its own SQL store, so the earlier optional-port fixture override cannot survive. Production refusal is correct. Astra accepted explicit historical retained-intent fixture after modern refusal, with actual SQL running lease and approval guards, actual TRUNCATE denial, exact tombstone equality, and actual current no-replay recovery. No invented successful modern dispatch on obsolete schema, no rebind bypass or migration exception. Final patch and native rerun pending.

Fresh4GiB compiler on187f039b completed58.83s, exit2; minimum free27,106,234,368bytes. Only two errors: synthetic test principals in Azure release-journal and OCI sessions omit required name. Bounded fixture corrections pending. Earlier3GiB heap failure remains recorded.

Astra checked concrete browser approval wiring: validated review view and semantics digest already flow through displayed ApprovalCard, OperationActions and API to broker. Legacy deployment-only buttons route bound rounds to platform review; no missing production forwarding or server digest inference. Add a narrow screen regression asserting displayed immutable semantics and exact approval payload.

## WIP checkpoint request

User requested immediate WIP commit and complete in-progress handoff. `WIP-HANDOFF-2026-10-08.md` records integrated17 repairs, exact executed results, active local packets, remaining failures/skips and continuation. Latest root23-suite run1626 passed /0 failed /6 Linux-only skipped; compiler9b895088 exit0. Native predecessor65/12/0 stays failed. One historical42 reapplication fixture scope saved as WIP; successor execution pending. No push, requirement promotion or completed verification claim.

## Published-context update requested

User requested immediate commit and GitHub publication with updated progress context. Root native successor at `b69a6c121ee1fae033246231ffad85d4d9f3b95f`:41 passed/0 failed/0 skipped, including23 actual PostgreSQL,17 PGlite and1 pure contract case. Historical JSON repair1c449864 and schema upgrade fixtureb69a6c12 source-reviewed by Astra. Server stop exit0, owned data/socket removed; minimum27,039,387,648bytes above22GiB floor. Earlier broader65/12/0 remains failed and unsuperseded for unrerun migration cases. Public sanitized receipt added under CI08; no requirement state or release flag promoted. Final pushed SHA CI must be inspected separately.


## Native historical and codec successors, 8 October 2026

Actual source `648a3f82`: historical/index/tombstone suites **77 passed / 0 failed / 0 skipped**, comprising44 actual PostgreSQL,27 PGlite and6 pure controls. Dedicated migration42 refusals remain; four owned historical cases scope42 through both phases. Exact migration30 operations TRIGGER and migration38 runner_jobs owner failures were reproduced inside savepoints before narrowly authorized fixture permissions and successful current upgrades. Published SQL and production privilege boundaries are unchanged. Prior73/4 and both76/1 attempts remain evidence. Owned PostgreSQL stopped/data removed; minimum free27,013,103,616 bytes exceeded22GiB floor.

Separate frozen `4c3d6476`: canonical workflow-intents **156/0/0**, all141 mandatory groups, matched source/report/environment binding, observed exit0 and cleanup0. Separate `722c7304`: actual local Temporal plus composed deployment/helper **30/0/0**:7 helper,2 rehearsal and21 composed cases. Matching-runtime full protobuf converter preserves SDK normalization; actual-history binary equality, stable JSON and Worker replay passed. This closes the reproduced coupled codec defect, not missing frozen released-history corpus acceptance or live-cloud behavior.

Current canonical workflows require71 groups, including the new full codec helper. Exact historical70/60/58 comparisons retain unchanged prior identities; unknown additions are not excluded. Root two-suite metadata verification345/0/0 and independent Astra source review passed; native100 stays100. Whole lint passed with0errors/3existing vendor warnings, compiler passed on4c; combined successor remains mandatory.

Published `3dae8f9a` CI remains separate: native AMD64/ARM64 workers and Windows ACL/Linux systemd all successful; main13 successful jobs, workflows failed1330/1/0 (sole already-repaired same-environment rehearsal contention), verify/platform-postgres still running at inspection. No complete green or zero-skip project claim. Ledger10verified/49in_progress/19planned; all78 requirements/four false release states preserved.
