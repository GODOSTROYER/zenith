/**
 * Durable incident stability (PROD-OBS-03).
 *
 * The store half of `@/lib/incidents/stability`: it loads facts under a lock,
 * asks the pure rules what is allowed, and records the outcome in the same
 * transaction, so two observers or two repair proposals can never both slip
 * under a limit.
 *
 *   observeSignal         hysteresis + fingerprint dedup + auto-resolve
 *   checkRemediation      read-only gate (used while proposing)
 *   reserveRemediation    gate + attempt reservation, serialized per workspace
 *   settleAttempt         record how a reserved attempt ended
 *   escalateIncident / evaluateIncidentEscalation / recordInvestigation
 *   maintenance windows   create / cancel / list
 *   recordPostmortem      one deterministic record per resolved incident
 *
 * Every function here takes `Sql` first (the repo binder relies on that), is
 * tenant-scoped by `workspaceId`, and takes `now` so tests and replays are
 * deterministic.
 */
import { digest } from "@/lib/controlplane/digest";
import type { Sql } from "@/lib/controlplane/types";
import {
  DEFAULT_STABILITY_POLICY,
  advanceSignal,
  buildPostmortem,
  decideEscalation,
  decideRemediation,
  gateMessage,
  gateUnavailable,
  type AttemptView,
  type BlastRadius,
  type EscalationDecision,
  type EscalationReason,
  type GateCode,
  type GateDecision,
  type GateRequest,
  type Observation,
  trustedObservation,
  type PostmortemDocument,
  type SignalState,
  type SignalTransition,
  type StabilityPolicy,
  type WindowView,
} from "@/lib/incidents/stability";
import type { TelemetryEnvelope } from "@/lib/observability/telemetry";
import type { Investigation } from "@/lib/incidents/types";
import { ControlStoreError, requireText } from "../errors";
import { assertNoSecretValues } from "../secrets";
import { json, newId, opt, textArray } from "../sql";
import { append as appendEvent } from "./events";
import { getIncident, insertInvestigation, listInvestigationsForIncident, type IncidentRecord, type IncidentSeverity } from "./incidents";

const iso = (column: string): string => `to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const HEX64 = /^[0-9a-f]{64}$/;
const COUNTED = ["reserved", "succeeded", "failed"];
const SIGNAL_COLUMNS = `state, consecutive_bad, consecutive_good, ${iso("cooldown_until")} as cooldown_until`;
const ACTIVE_WINDOW_COLUMNS = `id, environment_id, ${iso("starts_at")} as starts_at, ${iso("ends_at")} as ends_at`;

const INCIDENT_COLUMNS = `id, workspace_id, environment_id, title, status, severity, source, summary, correlation_id, document,
  ${iso("opened_at")} as opened_at, ${iso("updated_at")} as updated_at, ${iso("resolved_at")} as resolved_at`;

interface IncidentRow {
  id: string;
  workspace_id: string;
  environment_id: string | null;
  title: string;
  status: IncidentRecord["status"];
  severity: IncidentSeverity;
  source: string;
  summary: string | null;
  correlation_id: string;
  document: Record<string, unknown>;
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
}

const toIncident = (r: IncidentRow): IncidentRecord => ({
  id: r.id,
  workspaceId: r.workspace_id,
  environmentId: opt(r.environment_id),
  title: r.title,
  status: r.status,
  severity: r.severity,
  source: r.source,
  summary: opt(r.summary),
  correlationId: r.correlation_id,
  document: r.document,
  openedAt: r.opened_at,
  updatedAt: r.updated_at,
  resolvedAt: opt(r.resolved_at),
});

/* ------------------------------ shared records ------------------------------ */

export interface StabilityIncident extends IncidentRecord {
  fingerprint?: string;
  occurrenceCount: number;
  lastSeenAt?: string;
  escalatedAt?: string;
  escalationReasons: string[];
  escalationAcknowledgedAt?: string;
  escalationAcknowledgedBy?: string;
  /** none: not escalated; unacknowledged: no person has taken ownership yet */
  escalationState: "none" | "unacknowledged" | "acknowledged";
}

interface StabilityRow extends IncidentRow {
  fingerprint: string | null;
  occurrence_count: number;
  last_seen_at: string | null;
  escalated_at: string | null;
  escalation_reasons: string[];
  escalation_acknowledged_at: string | null;
  escalation_acknowledged_by: string | null;
}

const STABILITY_COLUMNS = `${INCIDENT_COLUMNS}, fingerprint, occurrence_count, ${iso("last_seen_at")} as last_seen_at, ${iso("escalated_at")} as escalated_at, escalation_reasons, ${iso("escalation_acknowledged_at")} as escalation_acknowledged_at, escalation_acknowledged_by`;

const toStabilityIncident = (r: StabilityRow): StabilityIncident => ({
  ...toIncident(r),
  fingerprint: opt(r.fingerprint),
  occurrenceCount: r.occurrence_count,
  lastSeenAt: opt(r.last_seen_at),
  escalatedAt: opt(r.escalated_at),
  escalationReasons: Array.isArray(r.escalation_reasons) ? r.escalation_reasons : [],
  ...(r.escalation_acknowledged_at ? { escalationAcknowledgedAt: r.escalation_acknowledged_at } : {}),
  ...(r.escalation_acknowledged_by ? { escalationAcknowledgedBy: r.escalation_acknowledged_by } : {}),
  escalationState: !r.escalated_at ? "none" : r.escalation_acknowledged_at ? "acknowledged" : "unacknowledged",
});

export async function getStabilityIncident(sql: Sql, workspaceId: string, id: string): Promise<StabilityIncident | null> {
  const rows = await sql.query<StabilityRow>(`select ${STABILITY_COLUMNS} from platform.incidents where workspace_id = $1 and id = $2`, [requireText("workspaceId", workspaceId), requireText("id", id)]);
  return rows.length ? toStabilityIncident(rows[0]) : null;
}

function at(now: Date | undefined): string {
  const d = now ?? new Date();
  if (Number.isNaN(d.getTime())) throw new ControlStoreError("invalid_input", "now must be a valid date.", { field: "now" });
  return d.toISOString();
}

async function emit(sql: Sql, type: "incident.opened" | "incident.resolved" | "incident.escalated" | "incident.remediation_blocked" | "incident.postmortem_recorded", incident: Pick<IncidentRecord, "id" | "workspaceId" | "environmentId" | "correlationId">, key: string, data: Record<string, unknown>): Promise<void> {
  await appendEvent(sql, {
    id: `evt_${digest({ type, incident: incident.id, key }).slice(0, 40)}`,
    type,
    workspaceId: incident.workspaceId,
    ...(incident.environmentId ? { environmentId: incident.environmentId } : {}),
    correlationId: incident.correlationId,
    data: { incidentId: incident.id, ...data },
  });
}

/* ---------------------------- hysteresis and dedup ---------------------------- */

export interface ObserveSignalInput {
  workspaceId: string;
  environmentId: string;
  /** from `incidentFingerprint` */
  fingerprint: string;
  observation: Observation;
  /**
   * The envelope of the telemetry read behind this observation (PROD-OBS-02).
   * Only fresh data may open an incident; only fresh or empty data may clear
   * one. Anything else is downgraded to `unknown`.
   */
  telemetry?: Pick<TelemetryEnvelope, "state" | "signal" | "observedAt" | "partial">;
  /** used only when this observation opens a new incident */
  incident?: { title: string; severity: IncidentSeverity; source: string; summary?: string; document?: Record<string, unknown> };
  policy?: StabilityPolicy;
  now?: Date;
}

export interface ObserveSignalResult {
  signal: SignalState;
  transition: SignalTransition;
  /** the open incident for this fingerprint, when the signal is active */
  incident?: StabilityIncident;
  incidentCreated: boolean;
  /** the observation actually applied after the telemetry trust gate */
  appliedObservation: Observation;
  /** set when this observation cleared the signal and resolved the incident */
  resolved?: { incident: StabilityIncident; postmortem: PostmortemRecord };
}

interface SignalRow {
  state: "quiet" | "active";
  consecutive_bad: number;
  consecutive_good: number;
  cooldown_until: string | null;
}

export async function observeSignal(sql: Sql, input: ObserveSignalInput): Promise<ObserveSignalResult> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const environmentId = requireText("environmentId", input.environmentId);
  if (!HEX64.test(input.fingerprint)) throw new ControlStoreError("invalid_input", "fingerprint must be a 64-character hex digest.", { field: "fingerprint" });
  const policy = input.policy ?? DEFAULT_STABILITY_POLICY;
  const now = at(input.now);
  if (input.incident) assertNoSecretValues(input.incident, "incident");
  const applied = trustedObservation(input.observation, input.telemetry?.state);

  return sql.tx(async (tx) => {
    await tx.query(
      `insert into platform.incident_signal_state (workspace_id, environment_id, fingerprint, last_observed_at) values ($1, $2, $3, $4::timestamptz)
       on conflict (workspace_id, environment_id, fingerprint) do nothing`,
      [workspaceId, environmentId, input.fingerprint, now]
    );
    const [row] = await tx.query<SignalRow>(
      `select ${SIGNAL_COLUMNS} from platform.incident_signal_state
        where workspace_id = $1 and environment_id = $2 and fingerprint = $3 for update`,
      [workspaceId, environmentId, input.fingerprint]
    );
    const { next, transition } = advanceSignal(policy, { state: row.state, consecutiveBad: row.consecutive_bad, consecutiveGood: row.consecutive_good }, applied);
    const cooldownUntil = transition === "cleared" ? new Date(Date.parse(now) + policy.remediation.baseCooldownMs).toISOString() : opt(row.cooldown_until);
    await tx.query(
      `update platform.incident_signal_state set state = $4, consecutive_bad = $5, consecutive_good = $6,
              last_observed_at = case when $7::boolean then $8::timestamptz else last_observed_at end,
              cooldown_until = $9::timestamptz, updated_at = clock_timestamp()
        where workspace_id = $1 and environment_id = $2 and fingerprint = $3`,
      [workspaceId, environmentId, input.fingerprint, next.state, next.consecutiveBad, next.consecutiveGood, applied !== "unknown", now, cooldownUntil ?? null]
    );

    let incident: StabilityIncident | undefined;
    let incidentCreated = false;
    if (applied === "bad" && next.state === "active") {
      const attached = await tx.query<StabilityRow>(
        `update platform.incidents set occurrence_count = occurrence_count + 1, last_seen_at = $3::timestamptz, updated_at = $3::timestamptz
          where workspace_id = $1 and fingerprint = $2 and status <> 'resolved' returning ${STABILITY_COLUMNS}`,
        [workspaceId, input.fingerprint, now]
      );
      if (attached.length) incident = toStabilityIncident(attached[0]);
      else {
        const spec = input.incident ?? { title: "Recurring problem detected", severity: "medium" as IncidentSeverity, source: "probe" };
        const created = await tx.query<StabilityRow>(
          `insert into platform.incidents (id, workspace_id, environment_id, title, severity, source, summary, correlation_id, document, opened_at, updated_at, fingerprint, last_seen_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10::timestamptz, $10::timestamptz, $11, $10::timestamptz)
           on conflict (workspace_id, fingerprint) where fingerprint is not null and status <> 'resolved' do nothing
           returning ${STABILITY_COLUMNS}`,
          [newId("inc"), workspaceId, environmentId, requireText("title", spec.title, 300), spec.severity, requireText("source", spec.source, 64), spec.summary ?? null, newId("corr"), json({ ...(spec.document ?? {}), ...(input.telemetry ? { telemetry: { state: input.telemetry.state, signal: input.telemetry.signal, observedAt: input.telemetry.observedAt, partial: input.telemetry.partial } } : {}) }), now, input.fingerprint]
        );
        if (created.length) {
          incident = toStabilityIncident(created[0]);
          incidentCreated = true;
          await emit(tx, "incident.opened", incident, "opened", { fingerprint: input.fingerprint, severity: incident.severity, source: incident.source });
        } else {
          const raced = await tx.query<StabilityRow>(`select ${STABILITY_COLUMNS} from platform.incidents where workspace_id = $1 and fingerprint = $2 and status <> 'resolved'`, [workspaceId, input.fingerprint]);
          incident = raced.length ? toStabilityIncident(raced[0]) : undefined;
        }
      }
    }

    let resolved: ObserveSignalResult["resolved"];
    if (transition === "cleared") {
      const rows = await tx.query<StabilityRow>(
        `update platform.incidents set status = 'resolved', resolved_at = $3::timestamptz, updated_at = $3::timestamptz
          where workspace_id = $1 and fingerprint = $2 and status <> 'resolved' returning ${STABILITY_COLUMNS}`,
        [workspaceId, input.fingerprint, now]
      );
      for (const r of rows) {
        const closed = toStabilityIncident(r);
        await emit(tx, "incident.resolved", closed, "resolved", { fingerprint: input.fingerprint, via: "hysteresis_clear" });
        const postmortem = await recordPostmortem(tx, { workspaceId, incidentId: closed.id, policy, now: input.now });
        resolved = { incident: closed, postmortem };
      }
    }
    return { signal: next, transition, ...(incident ? { incident } : {}), incidentCreated, appliedObservation: applied, ...(resolved ? { resolved } : {}) };
  });
}

/* ------------------------------ remediation gate ------------------------------ */

export interface RemediationGateInput {
  workspaceId: string;
  environmentId: string;
  /** durable incident this proposal belongs to; absent for a read-only investigation */
  incidentId?: string;
  request: GateRequest;
  /** hex64 identity of the exact proposal; default is a digest of capability + resource */
  proposalDigest?: string;
  policy?: StabilityPolicy;
  now?: Date;
}

interface AttemptRow {
  id: string;
  incident_id: string;
  environment_id: string;
  fingerprint: string;
  capability: string;
  resource_id: string | null;
  status: AttemptView["status"] | "blocked";
  reserved_at: string;
  operation_id: string | null;
  settled_at: string | null;
  block_codes: string[];
  blast_radius: BlastRadius;
  idempotency_key: string;
}

const ATTEMPT_COLUMNS = `id, incident_id, environment_id, fingerprint, capability, resource_id, status, ${iso("reserved_at")} as reserved_at, operation_id, ${iso("settled_at")} as settled_at, block_codes, blast_radius, idempotency_key`;

export interface RemediationAttempt extends AttemptView {
  blastRadius: BlastRadius;
  idempotencyKey: string;
  operationId?: string;
  settledAt?: string;
}

const toView = (r: AttemptRow): RemediationAttempt => ({
  id: r.id,
  incidentId: r.incident_id,
  environmentId: r.environment_id,
  fingerprint: r.fingerprint,
  capability: r.capability,
  ...(r.resource_id ? { resourceId: r.resource_id } : {}),
  status: r.status as AttemptView["status"],
  reservedAt: r.reserved_at,
  blastRadius: r.blast_radius,
  idempotencyKey: r.idempotency_key,
  ...(r.operation_id ? { operationId: r.operation_id } : {}),
  ...(r.settled_at ? { settledAt: r.settled_at } : {}),
});

async function loadWindows(sql: Sql, workspaceId: string, now: string): Promise<WindowView[]> {
  const rows = await sql.query<{ id: string; environment_id: string | null; starts_at: string; ends_at: string }>(
    `select ${ACTIVE_WINDOW_COLUMNS} from platform.incident_maintenance_windows
      where workspace_id = $1 and cancelled_at is null and starts_at <= $2::timestamptz and ends_at > $2::timestamptz`,
    [workspaceId, now]
  );
  return rows.map((r) => ({ id: r.id, ...(r.environment_id ? { environmentId: r.environment_id } : {}), startsAt: r.starts_at, endsAt: r.ends_at }));
}

function proposalKey(input: RemediationGateInput): string {
  const key = input.proposalDigest ?? digest({ capability: input.request.capability, resourceId: input.request.resourceId ?? null });
  if (!HEX64.test(key)) throw new ControlStoreError("invalid_input", "proposalDigest must be a 64-character hex digest.", { field: "proposalDigest" });
  return key;
}

interface Loaded {
  incident: StabilityIncident | null;
  fingerprint?: string;
  decision: GateDecision;
}

async function evaluate(sql: Sql, input: RemediationGateInput, now: string): Promise<Loaded> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const environmentId = requireText("environmentId", input.environmentId);
  const policy = input.policy ?? DEFAULT_STABILITY_POLICY;
  const r = policy.remediation;
  const nowMs = Date.parse(now);

  let incident: StabilityIncident | null = null;
  if (input.incidentId) {
    incident = await getStabilityIncident(sql, workspaceId, input.incidentId);
    if (incident && incident.environmentId && incident.environmentId !== environmentId) incident = null;
    if (!incident) {
      const decision = decideRemediation(policy, snapshotOf(now, environmentId, null, null, undefined, [], [], [], 0, []), input.request);
      return { incident: null, decision: { ...decision, allowed: false, codes: [...new Set<GateCode>(["incident_inactive", ...decision.codes])], messages: [gateMessage("incident_inactive"), ...decision.messages] } };
    }
  }
  const fingerprint = incident?.fingerprint;

  let signalActive: boolean | null = null;
  let cooldownUntil: string | undefined;
  if (fingerprint) {
    const s = await sql.query<SignalRow>(
      `select ${SIGNAL_COLUMNS} from platform.incident_signal_state where workspace_id = $1 and environment_id = $2 and fingerprint = $3`,
      [workspaceId, environmentId, fingerprint]
    );
    signalActive = s.length ? s[0].state === "active" : false;
    cooldownUntil = opt(s[0]?.cooldown_until);
  }

  const windowStart = new Date(nowMs - r.windowMs).toISOString();
  const incidentAttempts = incident
    ? (await sql.query<AttemptRow>(`select ${ATTEMPT_COLUMNS} from platform.incident_remediation_attempts where workspace_id = $1 and incident_id = $2 and status = any($3::text[])`, [workspaceId, incident.id, textArray(COUNTED)])).map(toView)
    : [];
  const fingerprintAttempts = fingerprint
    ? (await sql.query<AttemptRow>(`select ${ATTEMPT_COLUMNS} from platform.incident_remediation_attempts where workspace_id = $1 and fingerprint = $2 and status = any($3::text[]) and reserved_at > $4::timestamptz`, [workspaceId, fingerprint, textArray(COUNTED), new Date(nowMs - r.maxCooldownMs).toISOString()])).map(toView)
    : [];
  const environmentAttempts = (
    await sql.query<AttemptRow>(`select ${ATTEMPT_COLUMNS} from platform.incident_remediation_attempts where workspace_id = $1 and environment_id = $2 and status = any($3::text[]) and reserved_at > $4::timestamptz`, [workspaceId, environmentId, textArray(COUNTED), new Date(nowMs - Math.max(r.windowMs, r.inflightTtlMs)).toISOString()])
  ).map(toView);
  const [{ n }] = await sql.query<{ n: string | number }>(`select count(*) as n from platform.incident_remediation_attempts where workspace_id = $1 and status = any($2::text[]) and reserved_at > $3::timestamptz`, [workspaceId, textArray(COUNTED), windowStart]);

  const windows = await loadWindows(sql, workspaceId, now);
  const snap = snapshotOf(now, environmentId, incident, signalActive, cooldownUntil, incidentAttempts, fingerprintAttempts, environmentAttempts, Number(n), windows);
  return { incident, ...(fingerprint ? { fingerprint } : {}), decision: decideRemediation(policy, snap, input.request) };
}

function snapshotOf(now: string, environmentId: string, incident: StabilityIncident | null, signalActive: boolean | null, fingerprintCooldownUntil: string | undefined, incidentAttempts: AttemptView[], fingerprintAttempts: AttemptView[], environmentAttempts: AttemptView[], workspaceAttemptCount: number, windows: WindowView[]) {
  return {
    now: new Date(now),
    environmentId,
    incident: incident ? { id: incident.id, status: incident.status, ...(incident.escalatedAt ? { escalatedAt: incident.escalatedAt } : {}) } : null,
    signalActive,
    ...(fingerprintCooldownUntil ? { fingerprintCooldownUntil } : {}),
    incidentAttempts,
    fingerprintAttempts,
    environmentAttempts,
    workspaceAttemptCount,
    windows,
  };
}

/** Read-only: would this proposal be allowed right now? Records nothing. Fails closed when the store errors. */
export async function checkRemediation(sql: Sql, input: RemediationGateInput): Promise<GateDecision> {
  try {
    return (await evaluate(sql, input, at(input.now))).decision;
  } catch (e) {
    if (e instanceof ControlStoreError && e.code === "invalid_input") throw e;
    return gateUnavailable();
  }
}

export interface ReserveRemediationResult {
  decision: GateDecision;
  attempt?: RemediationAttempt;
  /** the same proposal was already reserved; nothing new was counted */
  replayed: boolean;
}

/**
 * Enforce the gate and reserve the attempt atomically. Callers must obtain a
 * reservation (and keep its id) before submitting the remediation capability;
 * a blocked proposal is recorded for audit and may escalate the incident.
 */
export async function reserveRemediation(sql: Sql, input: RemediationGateInput): Promise<ReserveRemediationResult> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const environmentId = requireText("environmentId", input.environmentId);
  const key = proposalKey(input);
  const now = at(input.now);
  if (!input.incidentId) throw new ControlStoreError("invalid_input", "A repair attempt can only be reserved against a tracked incident.", { field: "incidentId" });
  return sql.tx(async (tx) => {
    // One lock per workspace serializes every cap that counts across environments.
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`zenith:incident-remediation:${workspaceId}`]);
    if (input.incidentId) {
      const prior = await tx.query<AttemptRow>(`select ${ATTEMPT_COLUMNS} from platform.incident_remediation_attempts where workspace_id = $1 and incident_id = $2 and idempotency_key = $3 and status <> 'blocked'`, [workspaceId, input.incidentId, key]);
      if (prior.length) return { decision: { allowed: true, codes: [], messages: [], escalate: false }, attempt: toView(prior[0]), replayed: true };
    }
    await syncAttemptOutcomes(tx, { workspaceId, now: input.now });
    const { incident, fingerprint, decision } = await evaluate(tx, input, now);
    const row = (status: "reserved" | "blocked") => [newId("att"), workspaceId, incident?.id ?? input.incidentId, environmentId, fingerprint ?? "", key, input.request.capability, input.request.resourceId ?? null, input.request.blastRadius, status, json(decision.codes), now];
    if (decision.allowed) {
      const rows = await tx.query<AttemptRow>(
        `insert into platform.incident_remediation_attempts (id, workspace_id, incident_id, environment_id, fingerprint, idempotency_key, capability, resource_id, blast_radius, status, block_codes, reserved_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12::timestamptz) returning ${ATTEMPT_COLUMNS}`,
        row("reserved")
      );
      return { decision, attempt: toView(rows[0]), replayed: false };
    }
    if (incident) {
      await tx.query(
        `insert into platform.incident_remediation_attempts (id, workspace_id, incident_id, environment_id, fingerprint, idempotency_key, capability, resource_id, blast_radius, status, block_codes, reserved_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12::timestamptz)`,
        row("blocked")
      );
      await emit(tx, "incident.remediation_blocked", incident, `${key}:${now}`, { capability: input.request.capability, codes: decision.codes });
      if (decision.escalate) await escalateIncident(tx, { workspaceId, incidentId: incident.id, reasons: decision.codes.includes("attempts_exhausted") ? ["attempts_exhausted"] : ["remediation_requires_human"], now: input.now });
    }
    return { decision, replayed: false };
  });
}

export async function settleAttempt(
  sql: Sql,
  input: { workspaceId: string; attemptId: string; outcome: "succeeded" | "failed" | "abandoned"; operationId?: string; now?: Date }
): Promise<RemediationAttempt | null> {
  const rows = await sql.query<AttemptRow>(
    `update platform.incident_remediation_attempts set status = $3, operation_id = coalesce($4, operation_id), settled_at = $5::timestamptz
      where workspace_id = $1 and id = $2 and status = 'reserved' returning ${ATTEMPT_COLUMNS}`,
    [requireText("workspaceId", input.workspaceId), requireText("attemptId", input.attemptId), input.outcome, input.operationId ?? null, at(input.now)]
  );
  return rows.length ? toView(rows[0]) : null;
}

export async function listRemediationAttempts(sql: Sql, workspaceId: string, incidentId: string): Promise<(RemediationAttempt & { blockCodes: string[] })[]> {
  const rows = await sql.query<AttemptRow>(`select ${ATTEMPT_COLUMNS} from platform.incident_remediation_attempts where workspace_id = $1 and incident_id = $2 order by reserved_at, id`, [requireText("workspaceId", workspaceId), requireText("incidentId", incidentId)]);
  return rows.map((r) => ({ ...toView(r), blockCodes: Array.isArray(r.block_codes) ? r.block_codes : [] }));
}

/* ------------------------------- escalation -------------------------------- */

export interface EscalateInput {
  workspaceId: string;
  incidentId: string;
  reasons: readonly EscalationReason[];
  now?: Date;
}

/** Idempotent: records the first escalation time and the union of reasons; emits an event only when something is new. */
export async function escalateIncident(sql: Sql, input: EscalateInput): Promise<StabilityIncident | null> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  if (input.reasons.length === 0) throw new ControlStoreError("invalid_input", "an escalation needs at least one reason.", { field: "reasons" });
  const now = at(input.now);
  return sql.tx(async (tx) => {
    const rows = await tx.query<StabilityRow>(`select ${STABILITY_COLUMNS} from platform.incidents where workspace_id = $1 and id = $2 for update`, [workspaceId, requireText("incidentId", input.incidentId)]);
    if (!rows.length || rows[0].status === "resolved") return rows.length ? toStabilityIncident(rows[0]) : null;
    const current = toStabilityIncident(rows[0]);
    const merged = [...new Set([...current.escalationReasons, ...input.reasons])];
    if (current.escalatedAt && merged.length === current.escalationReasons.length) return current;
    const updated = await tx.query<StabilityRow>(
      `update platform.incidents set escalated_at = coalesce(escalated_at, $3::timestamptz), escalation_reasons = $4::text::jsonb, updated_at = $3::timestamptz
        where workspace_id = $1 and id = $2 returning ${STABILITY_COLUMNS}`,
      [workspaceId, current.id, now, json(merged)]
    );
    const out = toStabilityIncident(updated[0]);
    await emit(tx, "incident.escalated", out, merged.join(","), { reasons: merged, severity: out.severity });
    return out;
  });
}

/** Decide escalation from stored facts (latest investigation, attempts, recent blocks, age) and record it. */
export async function evaluateIncidentEscalation(sql: Sql, input: { workspaceId: string; incidentId: string; policy?: StabilityPolicy; now?: Date }): Promise<EscalationDecision & { incident: StabilityIncident | null }> {
  const policy = input.policy ?? DEFAULT_STABILITY_POLICY;
  const now = at(input.now);
  const incident = await getStabilityIncident(sql, input.workspaceId, input.incidentId);
  if (!incident) return { escalate: false, reasons: [], alreadyEscalated: false, incident: null };
  const attempts = await listRemediationAttempts(sql, incident.workspaceId, incident.id);
  const investigations = await listInvestigationsForIncident(sql, incident.workspaceId, incident.id);
  const blockedCodes = attempts.filter((a) => (a.status as string) === "blocked").flatMap((a) => a.blockCodes) as GateCode[];
  const decision = decideEscalation(policy, {
    now: new Date(now),
    incident: { severity: incident.severity, openedAt: incident.openedAt, ...(incident.escalatedAt ? { escalatedAt: incident.escalatedAt } : {}), status: incident.status },
    ...(investigations.length ? { diagnosis: { hypotheses: investigations[0].hypotheses.map((h) => ({ code: h.code, confidence: h.confidence })) } } : {}),
    countedAttempts: attempts.filter((a) => COUNTED.includes(a.status)).length,
    blockedCodes,
  });
  const recorded = decision.escalate ? await escalateIncident(sql, { workspaceId: incident.workspaceId, incidentId: incident.id, reasons: decision.reasons, now: input.now }) : incident;
  return { ...decision, incident: recorded };
}

/** Store a finished investigation for a tracked incident, then escalate when it is inconclusive. */
export async function recordInvestigation(sql: Sql, input: { investigation: Investigation; policy?: StabilityPolicy; now?: Date }): Promise<{ investigation: Investigation; escalation: EscalationDecision | null }> {
  const inv = input.investigation;
  return sql.tx(async (tx) => {
    if (inv.incidentId && !(await getIncident(tx, inv.workspaceId, inv.incidentId))) throw new ControlStoreError("not_found", "The incident does not exist in this workspace.", { incidentId: inv.incidentId });
    const stored = await insertInvestigation(tx, inv);
    if (!inv.incidentId) return { investigation: stored, escalation: null };
    const escalation = await evaluateIncidentEscalation(tx, { workspaceId: inv.workspaceId, incidentId: inv.incidentId, policy: input.policy, now: input.now });
    return { investigation: stored, escalation: { escalate: escalation.escalate, reasons: escalation.reasons, alreadyEscalated: escalation.alreadyEscalated } };
  });
}

/* ----------------------------- maintenance windows ----------------------------- */

export interface MaintenanceWindow {
  id: string;
  workspaceId: string;
  environmentId?: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  createdBy: string;
  cancelledAt?: string;
}

interface WindowRow {
  id: string;
  workspace_id: string;
  environment_id: string | null;
  starts_at: string;
  ends_at: string;
  reason: string;
  created_by: string;
  cancelled_at: string | null;
}
const WINDOW_COLUMNS = `id, workspace_id, environment_id, ${iso("starts_at")} as starts_at, ${iso("ends_at")} as ends_at, reason, created_by, ${iso("cancelled_at")} as cancelled_at`;
const toWindow = (r: WindowRow): MaintenanceWindow => ({ id: r.id, workspaceId: r.workspace_id, ...(r.environment_id ? { environmentId: r.environment_id } : {}), startsAt: r.starts_at, endsAt: r.ends_at, reason: r.reason, createdBy: r.created_by, ...(r.cancelled_at ? { cancelledAt: r.cancelled_at } : {}) });

export const MAX_MAINTENANCE_WINDOW_MS = 7 * 24 * 3_600_000;

export async function createMaintenanceWindow(sql: Sql, input: { workspaceId: string; environmentId?: string; startsAt: Date; endsAt: Date; reason: string; createdBy: string; id?: string }): Promise<MaintenanceWindow> {
  const start = input.startsAt.getTime();
  const end = input.endsAt.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new ControlStoreError("invalid_input", "A maintenance window must end after it starts.", { field: "endsAt" });
  if (end - start > MAX_MAINTENANCE_WINDOW_MS) throw new ControlStoreError("value_out_of_range", "A maintenance window may last at most 7 days.", { field: "endsAt" });
  assertNoSecretValues(input.reason, "reason");
  const rows = await sql.query<WindowRow>(
    `insert into platform.incident_maintenance_windows (id, workspace_id, environment_id, starts_at, ends_at, reason, created_by)
     values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7) returning ${WINDOW_COLUMNS}`,
    [input.id ?? newId("mw"), requireText("workspaceId", input.workspaceId), input.environmentId ?? null, input.startsAt.toISOString(), input.endsAt.toISOString(), requireText("reason", input.reason, 500), requireText("createdBy", input.createdBy)]
  );
  return toWindow(rows[0]);
}

export async function cancelMaintenanceWindow(sql: Sql, input: { workspaceId: string; id: string; now?: Date }): Promise<MaintenanceWindow | null> {
  const rows = await sql.query<WindowRow>(
    `update platform.incident_maintenance_windows set cancelled_at = $3::timestamptz where workspace_id = $1 and id = $2 and cancelled_at is null returning ${WINDOW_COLUMNS}`,
    [requireText("workspaceId", input.workspaceId), requireText("id", input.id), at(input.now)]
  );
  return rows.length ? toWindow(rows[0]) : null;
}

export async function listMaintenanceWindows(sql: Sql, workspaceId: string, filter: { environmentId?: string; activeAt?: Date } = {}): Promise<MaintenanceWindow[]> {
  const rows = await sql.query<WindowRow>(
    `select ${WINDOW_COLUMNS} from platform.incident_maintenance_windows
      where workspace_id = $1 and ($2::text is null or environment_id is null or environment_id = $2::text)
        and ($3::timestamptz is null or (cancelled_at is null and starts_at <= $3::timestamptz and ends_at > $3::timestamptz))
      order by starts_at desc, id limit 200`,
    [requireText("workspaceId", workspaceId), filter.environmentId ?? null, filter.activeAt ? filter.activeAt.toISOString() : null]
  );
  return rows.map(toWindow);
}

/* -------------------------------- postmortem -------------------------------- */

export interface PostmortemRecord {
  id: string;
  workspaceId: string;
  incidentId: string;
  document: PostmortemDocument;
  documentDigest: string;
  createdAt: string;
}

interface PostmortemRow {
  id: string;
  workspace_id: string;
  incident_id: string;
  document: PostmortemDocument;
  document_digest: string;
  created_at: string;
}
const PM_COLUMNS = `id, workspace_id, incident_id, document, document_digest, ${iso("created_at")} as created_at`;
const toPostmortem = (r: PostmortemRow): PostmortemRecord => ({ id: r.id, workspaceId: r.workspace_id, incidentId: r.incident_id, document: r.document, documentDigest: r.document_digest, createdAt: r.created_at });

export async function getPostmortem(sql: Sql, workspaceId: string, incidentId: string): Promise<PostmortemRecord | null> {
  const rows = await sql.query<PostmortemRow>(`select ${PM_COLUMNS} from platform.incident_postmortems where workspace_id = $1 and incident_id = $2`, [requireText("workspaceId", workspaceId), requireText("incidentId", incidentId)]);
  return rows.length ? toPostmortem(rows[0]) : null;
}

/** Build and store the postmortem for a RESOLVED incident from stored facts only. Immutable: a second call returns the first. */
export async function recordPostmortem(sql: Sql, input: { workspaceId: string; incidentId: string; policy?: StabilityPolicy; now?: Date }): Promise<PostmortemRecord> {
  const policy = input.policy ?? DEFAULT_STABILITY_POLICY;
  return sql.tx(async (tx) => {
    const existing = await getPostmortem(tx, input.workspaceId, input.incidentId);
    if (existing) return existing;
    const incident = await getStabilityIncident(tx, input.workspaceId, input.incidentId);
    if (!incident) throw new ControlStoreError("not_found", "The incident does not exist in this workspace.", { incidentId: input.incidentId });
    if (incident.status !== "resolved" || !incident.resolvedAt) throw new ControlStoreError("invalid_state", "A postmortem is recorded only for a resolved incident.", { status: incident.status });
    const investigations = await listInvestigationsForIncident(tx, incident.workspaceId, incident.id);
    const attempts = await listRemediationAttempts(tx, incident.workspaceId, incident.id);
    const doc = buildPostmortem(policy, {
      incident: { id: incident.id, title: incident.title, severity: incident.severity, source: incident.source, openedAt: incident.openedAt, resolvedAt: incident.resolvedAt, occurrenceCount: incident.occurrenceCount, ...(incident.escalatedAt ? { escalatedAt: incident.escalatedAt } : {}), escalationReasons: incident.escalationReasons },
      investigations: investigations.map((i) => ({ id: i.id, startedAt: i.startedAt, hypotheses: i.hypotheses.map((h) => ({ code: h.code, title: h.title, confidence: h.confidence, supportingEvidence: h.supportingEvidence })), ...(i.notes ? { notes: i.notes } : {}) })),
      attempts: attempts.filter((a) => (a.status as string) !== "blocked"),
      blocked: attempts.filter((a) => (a.status as string) === "blocked").map((a) => ({ capability: a.capability, ...(a.resourceId ? { resourceId: a.resourceId } : {}), at: a.reservedAt, codes: a.blockCodes })),
    });
    assertNoSecretValues(doc, "postmortem");
    const rows = await tx.query<PostmortemRow>(
      `insert into platform.incident_postmortems (id, workspace_id, incident_id, document, document_digest, created_at)
       values ($1, $2, $3, $4::text::jsonb, $5, $6::timestamptz)
       on conflict (workspace_id, incident_id) do nothing returning ${PM_COLUMNS}`,
      [newId("pm"), incident.workspaceId, incident.id, json(doc), digest(doc), at(input.now)]
    );
    const record = rows.length ? toPostmortem(rows[0]) : (await getPostmortem(tx, incident.workspaceId, incident.id))!;
    if (rows.length) await emit(tx, "incident.postmortem_recorded", incident, "postmortem", { documentDigest: record.documentDigest });
    return record;
  });
}

/* ---------------------- operation binding and outcome sync --------------------- */

/** Bind a reserved attempt to the operation that carries it out; the remediation start path requires this. */
export async function bindAttemptToOperation(sql: Sql, input: { workspaceId: string; attemptId: string; operationId: string }): Promise<RemediationAttempt | null> {
  const rows = await sql.query<AttemptRow>(
    `update platform.incident_remediation_attempts set operation_id = $3
      where workspace_id = $1 and id = $2 and status = 'reserved' and operation_id is null
        and exists (select 1 from platform.operations o where o.workspace_id = $1 and o.id = $3)
      returning ${ATTEMPT_COLUMNS}`,
    [requireText("workspaceId", input.workspaceId), requireText("attemptId", input.attemptId), requireText("operationId", input.operationId)]
  );
  return rows.length ? toView(rows[0]) : null;
}

/**
 * Settle reserved attempts whose operation reached a terminal status:
 * succeeded stays succeeded, failed/uncertain count as failed (backoff applies),
 * and operations that never ran (rejected, denied, cancelled, expired) are
 * abandoned so they do not consume the attempt budget. Returns rows settled.
 */
export async function syncAttemptOutcomes(sql: Sql, input: { workspaceId: string; now?: Date }): Promise<number> {
  const rows = await sql.query<{ id: string }>(
    `update platform.incident_remediation_attempts a
        set status = case o.status when 'succeeded' then 'succeeded' when 'failed' then 'failed' when 'uncertain' then 'failed' else 'abandoned' end,
            settled_at = $2::timestamptz
       from platform.operations o
      where a.workspace_id = $1 and o.workspace_id = a.workspace_id and o.id = a.operation_id and a.status = 'reserved'
        and o.status in ('succeeded','failed','uncertain','rejected','denied','cancelled','expired')
      returning a.id`,
    [requireText("workspaceId", input.workspaceId), at(input.now)]
  );
  return rows.length;
}

/** A settled drift.repair attempt of a still-open incident, awaiting a post-remediation re-observation. */
export interface RepairAwaitingVerification {
  attemptId: string;
  incidentId: string;
  fingerprint: string;
  /** the finding address the repair targeted (stored as the attempt's resource id) */
  address: string;
  operationId: string;
  attemptStatus: "succeeded" | "failed";
  settledAt?: string;
}

/**
 * Settled `drift.repair` attempts (operation reached a terminal status) of the
 * environment's OPEN incidents, latest per incident. The caller must list these
 * BEFORE it reads the environment, so the re-observation provably postdates the
 * operation. Settles reserved attempts first through the existing outcome sync.
 */
export async function listRepairsAwaitingVerification(sql: Sql, input: { workspaceId: string; environmentId: string; now?: Date; limit?: number }): Promise<RepairAwaitingVerification[]> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const environmentId = requireText("environmentId", input.environmentId);
  await syncAttemptOutcomes(sql, { workspaceId, now: input.now });
  const rows = await sql.query<{ id: string; incident_id: string; fingerprint: string; resource_id: string | null; operation_id: string; status: "succeeded" | "failed"; settled_at: string | null }>(
    `select distinct on (a.incident_id) a.id, a.incident_id, a.fingerprint, a.resource_id, a.operation_id, a.status, ${iso("a.settled_at")} as settled_at
       from platform.incident_remediation_attempts a
       join platform.incidents i on i.workspace_id = a.workspace_id and i.id = a.incident_id
      where a.workspace_id = $1 and a.environment_id = $2 and a.capability = 'drift.repair'
        and a.status in ('succeeded','failed') and a.operation_id is not null and a.resource_id is not null
        and i.status <> 'resolved'
      order by a.incident_id, a.settled_at desc nulls last, a.id
      limit $3::bigint`,
    [workspaceId, environmentId, Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)))]
  );
  return rows.map((r) => ({ attemptId: r.id, incidentId: r.incident_id, fingerprint: r.fingerprint, address: r.resource_id!, operationId: r.operation_id, attemptStatus: r.status, ...(r.settled_at ? { settledAt: r.settled_at } : {}) }));
}

/* ------------------------------ escalation queue ------------------------------ */

/** Escalated, unresolved incidents for a workspace (optionally one environment), oldest first. */
export async function listEscalations(sql: Sql, workspaceId: string, filter: { environmentId?: string; unacknowledgedOnly?: boolean; limit?: number } = {}): Promise<StabilityIncident[]> {
  const rows = await sql.query<StabilityRow>(
    `select ${STABILITY_COLUMNS} from platform.incidents
      where workspace_id = $1 and escalated_at is not null and status <> 'resolved'
        and ($2::text is null or environment_id = $2::text)
        and (not $3::boolean or escalation_acknowledged_at is null)
      order by escalated_at, id limit $4::bigint`,
    [requireText("workspaceId", workspaceId), filter.environmentId ?? null, Boolean(filter.unacknowledgedOnly), Math.max(1, Math.min(200, Math.trunc(filter.limit ?? 50)))]
  );
  return rows.map(toStabilityIncident);
}

/** A person takes ownership of an escalation. Idempotent: the first acknowledgement is kept. */
export async function acknowledgeEscalation(sql: Sql, input: { workspaceId: string; incidentId: string; by: string; now?: Date }): Promise<StabilityIncident | null> {
  const rows = await sql.query<StabilityRow>(
    `update platform.incidents set escalation_acknowledged_at = coalesce(escalation_acknowledged_at, $3::timestamptz),
            escalation_acknowledged_by = coalesce(escalation_acknowledged_by, $4), updated_at = $3::timestamptz
      where workspace_id = $1 and id = $2 and escalated_at is not null returning ${STABILITY_COLUMNS}`,
    [requireText("workspaceId", input.workspaceId), requireText("incidentId", input.incidentId), at(input.now), requireText("by", input.by)]
  );
  return rows.length ? toStabilityIncident(rows[0]) : null;
}
