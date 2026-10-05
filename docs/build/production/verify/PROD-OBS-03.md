# PROD-OBS-03 Incident stability and escalation: verification

## 1. What was built

Audit result: the existing lifecycle (`src/lib/incidents/*`, `repos/incidents.ts`) was a stateless investigation engine plus a bare incident store. It had no fingerprint, no hysteresis, no attempt or blast-radius accounting, no maintenance windows, no escalation record and no postmortem. `attachRemediations` proposed every drafted fix for every run, and nothing persisted repair attempts, so a loop re-investigating an incident could re-propose the same repair indefinitely. `alerts/index.ts` carries a TODO that it has no hysteresis (that separate alert-rule path is untouched).

Added:

- `src/lib/incidents/stability.ts` (pure, deterministic): policy with hard ceilings (`resolveStabilityPolicy`), `incidentFingerprint`, `advanceSignal` (hysteresis; `unknown` never opens or clears), `decideRemediation` (the gate: maintenance window, inactive/escalated incident, unconfirmed signal, low confidence, risk cap, blast-radius cap, autoscaler conflict, attempt limit, cooldown with exponential backoff, in-flight cap, per-environment and per-workspace window caps, distinct-resource spread cap), `autoscalerManaged`, `decideEscalation` / `isInconclusive`, `buildPostmortem`.
- `src/lib/controlplane/db/migrations/0017_incident_stability.ts` (registered in `migrations/index.ts`): columns on `incidents` (fingerprint, occurrence_count, last_seen_at, escalated_at, escalation_reasons) with partial unique index `incidents_open_fingerprint`; new tables `incident_signal_state`, `incident_remediation_attempts`, `incident_maintenance_windows`, `incident_postmortems`. All carry `workspace_id`.
- `src/lib/controlplane/db/repos/incident-stability.ts` (registered as `repos.incidentStability`): `observeSignal` (hysteresis, race-safe dedup, auto-resolve, postmortem), `checkRemediation` (read-only, fails closed), `reserveRemediation` (per-workspace advisory lock, gate plus attempt reservation in one transaction, blocked proposals recorded, escalation when a cap needs a person, idempotent replay), `settleAttempt`, `listRemediationAttempts`, `escalateIncident`, `evaluateIncidentEscalation`, `recordInvestigation`, maintenance window create/cancel/list, `recordPostmortem` / `getPostmortem`.
- Engine wiring: optional `InvestigationPorts.remediationGate`; `attachRemediations` runs every option through it BEFORE it is offered (refused options go to `Hypothesis.suppressedRemediations`; a throwing or timed-out gate refuses everything); `investigate()` sets `Investigation.escalation` for an inconclusive diagnosis or a cap that needs a person. `src/lib/platform/agent-ports.ts` wires the gate to `checkRemediation`.
- Additive event types `incident.escalated`, `incident.remediation_blocked`, `incident.postmortem_recorded` (`controlplane/types.ts`, plus the exhaustive sentence map in `components/platform/event-sentences.ts`).

## 2. Acceptance mapping

| Clause | Implementation | Tests |
| --- | --- | --- |
| Deduplication | `incidentFingerprint`; partial unique index; `observeSignal` attach / insert-on-conflict | `tests/incidents/stability.test.ts` (fingerprint); `tests/controlplane/incident-stability.test.ts` "hysteresis and dedup" (concurrent observers, one incident) |
| Hysteresis | `advanceSignal` (open 3, clear 5, unknown inert) | both files; a flapping signal opens nothing |
| Cooldowns | `cooldownMs` backoff, fingerprint cooldown, `decideRemediation` | "enforces cooldown with exponential backoff"; store "holds the cooldown after a settled attempt" |
| Attempt limits | `maxAttemptsPerIncident`, attempt ledger, escalation on exhaustion | "stops after the per-incident attempt limit and escalates" |
| Blast-radius limits | `maxBlastRadius`, `maxRisk`, distinct-resource cap, env/workspace window caps, in-flight cap | gate tests; store repair-storm tests (1 in flight; spread cap across incidents) |
| Windows | `incident_maintenance_windows`, gate code `maintenance_window` with `retryAfter` | store "maintenance windows" |
| Escalation | `decideEscalation`, `escalateIncident`, `recordInvestigation`, engine `Investigation.escalation` | "escalation" in both files |
| Inconclusive diagnosis escalates | `isInconclusive` (only unknown, or below 0.5 confidence); store and engine paths | "an inconclusive diagnosis escalates and proposes nothing"; store "an inconclusive investigation escalates the incident once" |
| Postmortem | `buildPostmortem` (stored facts only), `recordPostmortem` (resolved only, immutable, automatic on clear) | "postmortem" in both files |
| Repair storms prevented | `reserveRemediation` under a per-workspace advisory lock | 100-proposal pure storm test; 12-way and 6-incident concurrent store tests |
| Autoscaler conflicts blocked | `autoscalerManaged` feeds the gate; `service.scale` is never offered against an autoscaled target | "autoscaler detection"; "blocks a scale proposal against an autoscaled service" |
| Deterministic, before any proposal | gate port inside `attachRemediations`; fails closed | "investigation engine enforces the gate" |

## 3. Verification commands (other machine)

```
npx vitest run tests/incidents tests/controlplane/incident-stability.test.ts tests/controlplane/migrations.test.ts
ZENITH_TEST_PLATFORM_PG_URL=<postgres url> npx vitest run tests/controlplane/incident-stability.test.ts
npx tsc --noEmit -p .
npx eslint src/lib/incidents src/lib/controlplane/db/repos/incident-stability.ts tests/incidents/stability.test.ts tests/controlplane/incident-stability.test.ts
```

Expected: all pass on PGlite; the Postgres lane also runs when the env var is set. `tests/controlplane/migrations.test.ts` fails until the shared-file updates in section 4 are made (EXPECTED_TABLES and the emitted Supabase SQL).

## 4. Known gaps and orchestrator actions

- Shared files to update (not edited here): `tests/controlplane/migrations.test.ts` EXPECTED_TABLES add `incident_signal_state`, `incident_remediation_attempts`, `incident_maintenance_windows`, `incident_postmortems`; regenerate `supabase/migrations/0018_platform_core.sql` with `npx tsx scripts/platform/emit-sql.ts`; `scripts/ci/apply-supabase-migrations.sh` and `docs/platform/operations/DEPLOYING.md` inventories; add the new test files to the gate manifest. If another worker also added migration 0017, renumber this one (file name, `version`, export, index entry) and regenerate.
- Admission enforcement point: the gate runs when proposals are generated (`remediationGate`, read-only) and `reserveRemediation` is the atomic reservation the capability submission path must call before submitting a remediation. No existing production caller submits incident remediations (the investigator is read-only and its dry-run port deliberately throws), so that call site does not exist yet. `reserveRemediation` is tested but not yet invoked from a broker path.
- No automatic observer loop calls `observeSignal` yet (PROD-OBS-04 owns durable schedules). Escalation is a durable record plus a platform event; paging or channel delivery of escalations is not implemented (alerts have no on-call rotation).
- Tests were not run by this worker (build-only rule). `tsc` shows pre-existing unrelated errors only in `src/lib/tofu/engine.ts` and `tests/ci/platform-coverage.test.ts` (checked before the final test files were added; see handoff).
- SQL uses `to_char(... at time zone 'utc')` and `pg_advisory_xact_lock(hashtextextended(...))`; first thing to check if a lane fails.
- Maintenance windows suppress repair proposals only; observation and incident opening continue.

## 5. Suggested ledger implementationStatus

`source_complete_contract_and_local_engine_tests_written_unrun_broker_admission_wiring_pending`
