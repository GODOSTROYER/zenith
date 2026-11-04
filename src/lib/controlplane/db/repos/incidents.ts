/**
 * Incidents and investigations (ADR-0014).
 *
 * An incident is the durable envelope (status, severity, correlation id) around
 * a problem; the structured body an investigation produces (`Investigation`
 * from `incidents/types.ts`: path, evidence, hypotheses, recent changes) is
 * stored whole as `document` next to the columns we query on. Confidence,
 * hypotheses and evidence are computed by deterministic rules elsewhere — this
 * store persists them and refuses nothing about their content except literal
 * secret values.
 *
 * `resolved` is terminal for an incident; a recurrence opens a new incident.
 */
import type { Sql } from "@/lib/controlplane/types";
import type { Investigation } from "@/lib/incidents/types";
import { ControlStoreError, requireText } from "../errors";
import { assertNoSecretValues } from "../secrets";
import { clampLimit, json, newId, opt, textArray } from "../sql";

export const INCIDENT_STATUSES = ["open", "investigating", "mitigating", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type IncidentSeverity = "low" | "medium" | "high" | "critical";

export interface IncidentRecord {
  id: string;
  workspaceId: string;
  environmentId?: string;
  title: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  /** what opened it: `alert`, `drift`, `user`, `probe`, … */
  source: string;
  summary?: string;
  correlationId: string;
  /** bounded, redacted structured context */
  document: Record<string, unknown>;
  openedAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

interface IncidentRow {
  id: string;
  workspace_id: string;
  environment_id: string | null;
  title: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  source: string;
  summary: string | null;
  correlation_id: string;
  document: Record<string, unknown>;
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
}

const COLUMNS = "id, workspace_id, environment_id, title, status, severity, source, summary, correlation_id, document, opened_at, updated_at, resolved_at";

const toIncident = (row: IncidentRow): IncidentRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  environmentId: opt(row.environment_id),
  title: row.title,
  status: row.status,
  severity: row.severity,
  source: row.source,
  summary: opt(row.summary),
  correlationId: row.correlation_id,
  document: row.document,
  openedAt: row.opened_at,
  updatedAt: row.updated_at,
  resolvedAt: opt(row.resolved_at),
});

export interface OpenIncidentInput {
  workspaceId: string;
  environmentId?: string;
  title: string;
  severity: IncidentSeverity;
  source: string;
  summary?: string;
  correlationId?: string;
  document?: Record<string, unknown>;
  id?: string;
}

export async function openIncident(sql: Sql, input: OpenIncidentInput): Promise<IncidentRecord> {
  assertNoSecretValues(input.document, "document");
  assertNoSecretValues(input.summary, "summary");
  const rows = await sql.query<IncidentRow>(
    `insert into platform.incidents (id, workspace_id, environment_id, title, severity, source, summary, correlation_id, document)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb)
     returning ${COLUMNS}`,
    [
      input.id ?? newId("inc"),
      requireText("workspaceId", input.workspaceId),
      input.environmentId ?? null,
      requireText("title", input.title, 300),
      input.severity,
      requireText("source", input.source, 64),
      input.summary ?? null,
      input.correlationId ?? newId("corr"),
      json(input.document ?? {}),
    ]
  );
  return toIncident(rows[0]);
}

export async function getIncident(sql: Sql, workspaceId: string, id: string): Promise<IncidentRecord | null> {
  const rows = await sql.query<IncidentRow>(
    `select ${COLUMNS} from platform.incidents where workspace_id = $1 and id = $2`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]
  );
  return rows.length ? toIncident(rows[0]) : null;
}

export async function listIncidents(
  sql: Sql,
  workspaceId: string,
  filter: { status?: IncidentStatus | readonly IncidentStatus[]; environmentId?: string; limit?: number } = {}
): Promise<IncidentRecord[]> {
  const statuses = filter.status === undefined ? null : Array.isArray(filter.status) ? filter.status : [filter.status];
  const rows = await sql.query<IncidentRow>(
    `select ${COLUMNS} from platform.incidents
      where workspace_id = $1 and ($2::text[] is null or status = any($2::text[])) and ($3::text is null or environment_id = $3::text)
      order by opened_at desc, id limit $4::bigint`,
    [requireText("workspaceId", workspaceId), statuses ? textArray(statuses as readonly string[]) : null, filter.environmentId ?? null, clampLimit(filter.limit, 50, 500)]
  );
  return rows.map(toIncident);
}

const ORDER: Record<IncidentStatus, number> = { open: 0, investigating: 1, mitigating: 2, resolved: 3 };

/**
 * Conditional status change (`WHERE status = ANY(from)`); returns null when the
 * incident is missing, of another workspace, or not in a `from` status. Status
 * only moves forward; `resolved` is terminal.
 */
export async function transitionIncident(
  sql: Sql,
  input: { workspaceId: string; id: string; from: readonly IncidentStatus[]; to: IncidentStatus; summary?: string; severity?: IncidentSeverity }
): Promise<IncidentRecord | null> {
  if (input.from.length === 0) throw new ControlStoreError("invalid_input", "transition needs at least one `from` status.");
  for (const f of input.from)
    if (f === "resolved" || ORDER[input.to] <= ORDER[f])
      throw new ControlStoreError("invalid_state", `Illegal incident transition ${f} to ${input.to}.`, { from: f, to: input.to });
  assertNoSecretValues(input.summary, "summary");
  const rows = await sql.query<IncidentRow>(
    `update platform.incidents
        set status = $4::text, updated_at = clock_timestamp(),
            summary = coalesce($5::text, summary), severity = coalesce($6::text, severity),
            resolved_at = case when $4::text = 'resolved' then clock_timestamp() else resolved_at end
      where workspace_id = $1 and id = $2 and status = any($3::text[])
      returning ${COLUMNS}`,
    [requireText("workspaceId", input.workspaceId), requireText("id", input.id), textArray(input.from as readonly string[]), input.to, input.summary ?? null, input.severity ?? null]
  );
  return rows.length ? toIncident(rows[0]) : null;
}

/* ------------------------------ investigations ------------------------------ */

export type StoredInvestigation = Investigation;

interface InvestigationRow {
  document: Investigation;
}

/** Persist a finished investigation (append-only). Returns it as stored. */
export async function insertInvestigation(sql: Sql, investigation: Investigation): Promise<Investigation> {
  assertNoSecretValues(investigation, "investigation");
  const rows = await sql.query<InvestigationRow>(
    `insert into platform.investigations (id, workspace_id, incident_id, environment_id, started_at, finished_at, simulated, document)
     values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::boolean, $8::text::jsonb)
     returning document`,
    [
      requireText("id", investigation.id),
      requireText("workspaceId", investigation.workspaceId),
      investigation.incidentId ?? null,
      requireText("environmentId", investigation.environmentId),
      investigation.startedAt,
      investigation.finishedAt,
      investigation.simulated,
      json(investigation),
    ]
  );
  return rows[0].document;
}

export async function getInvestigation(sql: Sql, workspaceId: string, id: string): Promise<Investigation | null> {
  const rows = await sql.query<InvestigationRow>(
    "select document from platform.investigations where workspace_id = $1 and id = $2",
    [requireText("workspaceId", workspaceId), requireText("id", id)]
  );
  return rows.length ? rows[0].document : null;
}

export async function listInvestigationsForIncident(sql: Sql, workspaceId: string, incidentId: string): Promise<Investigation[]> {
  const rows = await sql.query<InvestigationRow>(
    `select document from platform.investigations
      where workspace_id = $1 and incident_id = $2 order by started_at desc, id`,
    [requireText("workspaceId", workspaceId), requireText("incidentId", incidentId)]
  );
  return rows.map((r) => r.document);
}
