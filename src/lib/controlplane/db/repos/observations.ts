/**
 * Observed state (what the provider's configuration API returned) and runtime
 * state (what is actually running now) — the second and third of the three
 * states that are never conflated (`resources/types.ts`).
 *
 * `observations` is an append-only history bounded per resource: every append
 * prunes that resource's history to the latest `keepLatest` rows (default 100),
 * and `prune` does it fleet-wide. `runtime` is the latest per resource; an
 * older `observedAt` never overwrites a newer one (out-of-order writers lose).
 *
 * Nothing here infers a value: an `Observation` with `presence: "unknown"` or
 * attributes marked `unknown` is stored exactly so, and readers get exactly
 * that back. Rows are attached to a resource of the SAME workspace — the insert
 * selects from `resources` filtered by workspace and address, so a wrong-tenant
 * or mismatched-address write inserts nothing (`not_found`).
 */
import type { Sql } from "@/lib/controlplane/types";
import type { Observation, Presence, RuntimeState, HealthState } from "@/lib/resources/types";
import { ControlStoreError, requireText } from "../errors";
import { assertNoSecretValues } from "../secrets";
import { clampLimit, json, jsonOrNull, opt } from "../sql";

/* ------------------------------- observations ------------------------------- */

interface ObservationRow {
  address: string;
  external_id: string | null;
  presence: Presence;
  attributes: Observation["attributes"];
  native: Record<string, unknown> | null;
  observed_at: string;
  source: string;
  simulated: boolean;
  error: string | null;
}

const OBS_COLUMNS = "address, external_id, presence, attributes, native, observed_at, source, simulated, error";
export const DEFAULT_KEEP_OBSERVATIONS = 100;

const toObservation = (row: ObservationRow): Observation => ({
  address: row.address,
  externalId: opt(row.external_id),
  presence: row.presence,
  attributes: row.attributes,
  native: opt(row.native),
  observedAt: row.observed_at,
  source: row.source,
  simulated: row.simulated,
  error: opt(row.error),
});

export interface AppendObservationInput {
  workspaceId: string;
  resourceId: string;
  observation: Observation;
  /** history bound for this resource (default 100) */
  keepLatest?: number;
}

/** Append one observation of a resource and trim that resource's history. */
export async function appendObservation(sql: Sql, input: AppendObservationInput): Promise<void> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const resourceId = requireText("resourceId", input.resourceId);
  const o = input.observation;
  assertNoSecretValues(o.native, "native");
  assertNoSecretValues(o.attributes, "attributes");
  const keep = Math.max(1, Math.min(10_000, Math.trunc(input.keepLatest ?? DEFAULT_KEEP_OBSERVATIONS)));
  await sql.tx(async (tx) => {
    const inserted = await tx.query<{ id: number }>(
      `insert into platform.resource_observations
         (resource_id, workspace_id, environment_id, address, presence, external_id, attributes, native, observed_at, source, simulated, error)
       select r.id, r.workspace_id, r.environment_id, r.address, $4, $5, $6::text::jsonb, $7::text::jsonb, $8::timestamptz, $9, $10::boolean, $11
         from platform.resources r where r.workspace_id = $1 and r.id = $2 and r.address = $3
       returning id`,
      [workspaceId, resourceId, requireText("address", o.address, 512), o.presence, o.externalId ?? null, json(o.attributes ?? {}), jsonOrNull(o.native), o.observedAt, requireText("source", o.source, 128), o.simulated, o.error ?? null]
    );
    if (inserted.length === 0) throw new ControlStoreError("not_found", "Resource not found in this workspace (or its address differs).", { resourceId });
    await trim(tx, workspaceId, resourceId, keep);
  });
}

async function trim(sql: Sql, workspaceId: string, resourceId: string, keep: number): Promise<number> {
  const rows = await sql.query<{ id: number }>(
    `delete from platform.resource_observations
      where workspace_id = $1 and resource_id = $2 and id in (
        select id from platform.resource_observations
         where workspace_id = $1 and resource_id = $2
         order by observed_at desc, id desc offset $3::bigint)
      returning id`,
    [workspaceId, resourceId, keep]
  );
  return rows.length;
}

/** The newest observation of one resource (by `observedAt`), or null if never observed. */
export async function latestObservation(sql: Sql, workspaceId: string, resourceId: string): Promise<Observation | null> {
  const rows = await sql.query<ObservationRow>(
    `select ${OBS_COLUMNS} from platform.resource_observations
      where workspace_id = $1 and resource_id = $2 order by observed_at desc, id desc limit 1`,
    [requireText("workspaceId", workspaceId), requireText("resourceId", resourceId)]
  );
  return rows.length ? toObservation(rows[0]) : null;
}

/** Observation history of one resource, newest first. */
export async function observationHistory(sql: Sql, workspaceId: string, resourceId: string, limit = 50): Promise<Observation[]> {
  const rows = await sql.query<ObservationRow>(
    `select ${OBS_COLUMNS} from platform.resource_observations
      where workspace_id = $1 and resource_id = $2 order by observed_at desc, id desc limit $3::bigint`,
    [requireText("workspaceId", workspaceId), requireText("resourceId", resourceId), clampLimit(limit, 50, 1000)]
  );
  return rows.map(toObservation);
}

/** The newest observation of every resource in an environment (one per resource that has any). */
export async function latestObservationsByEnvironment(sql: Sql, workspaceId: string, environmentId: string): Promise<(Observation & { resourceId: string })[]> {
  const rows = await sql.query<ObservationRow & { resource_id: string }>(
    `select distinct on (resource_id) resource_id, ${OBS_COLUMNS} from platform.resource_observations
      where workspace_id = $1 and environment_id = $2 order by resource_id, observed_at desc, id desc`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId)]
  );
  return rows.map((r) => ({ ...toObservation(r), resourceId: r.resource_id }));
}

/**
 * Trim observation history to the latest `keepPerResource` rows per resource.
 * Bounded by `workspaceId` (and optionally one resource); returns rows deleted.
 */
export async function pruneObservations(
  sql: Sql,
  input: { workspaceId: string; keepPerResource: number; resourceId?: string }
): Promise<number> {
  if (!Number.isInteger(input.keepPerResource) || input.keepPerResource < 1)
    throw new ControlStoreError("invalid_input", "keepPerResource must be a positive integer.");
  const rows = await sql.query<{ id: number }>(
    `delete from platform.resource_observations
      where workspace_id = $1 and ($3::text is null or resource_id = $3::text) and id in (
        select id from (
          select id, row_number() over (partition by resource_id order by observed_at desc, id desc) as rn
            from platform.resource_observations
           where workspace_id = $1 and ($3::text is null or resource_id = $3::text)) ranked
         where rn > $2::bigint)
      returning id`,
    [requireText("workspaceId", input.workspaceId), input.keepPerResource, input.resourceId ?? null]
  );
  return rows.length;
}

/* --------------------------------- runtime ---------------------------------- */

interface RuntimeRow {
  address: string;
  health: HealthState;
  counts: Record<string, number>;
  signals: string[];
  observed_at: string;
  source: string;
  simulated: boolean;
}

const RT_COLUMNS = "address, health, counts, signals, observed_at, source, simulated";

const toRuntime = (row: RuntimeRow): RuntimeState => ({
  address: row.address,
  health: row.health,
  counts: row.counts,
  signals: row.signals,
  observedAt: row.observed_at,
  source: row.source,
  simulated: row.simulated,
});

/**
 * Upsert the latest runtime state of a resource. Returns false when the write
 * was not applied because a NEWER `observedAt` is already stored
 * (out-of-order writers lose); throws `not_found` for a wrong-tenant resource.
 */
export async function upsertRuntime(sql: Sql, input: { workspaceId: string; resourceId: string; runtime: RuntimeState }): Promise<boolean> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const resourceId = requireText("resourceId", input.resourceId);
  const rt = input.runtime;
  const exists = await sql.query<{ n: number }>("select 1 as n from platform.resources where workspace_id = $1 and id = $2 and address = $3", [
    workspaceId,
    resourceId,
    requireText("address", rt.address, 512),
  ]);
  if (exists.length === 0) throw new ControlStoreError("not_found", "Resource not found in this workspace (or its address differs).", { resourceId });
  const rows = await sql.query<{ resource_id: string }>(
    `insert into platform.resource_runtime as t (resource_id, workspace_id, environment_id, address, health, counts, signals, observed_at, source, simulated)
     select r.id, r.workspace_id, r.environment_id, r.address, $3, $4::text::jsonb, $5::text::jsonb, $6::timestamptz, $7, $8::boolean
       from platform.resources r where r.workspace_id = $1 and r.id = $2
     on conflict (resource_id) do update
       set health = excluded.health, counts = excluded.counts, signals = excluded.signals,
           observed_at = excluded.observed_at, source = excluded.source, simulated = excluded.simulated,
           updated_at = clock_timestamp()
     where t.observed_at <= excluded.observed_at
     returning resource_id`,
    [workspaceId, resourceId, rt.health, json(rt.counts ?? {}), json(rt.signals ?? []), rt.observedAt, requireText("source", rt.source, 128), rt.simulated]
  );
  return rows.length > 0;
}

export async function getRuntime(sql: Sql, workspaceId: string, resourceId: string): Promise<RuntimeState | null> {
  const rows = await sql.query<RuntimeRow>(
    `select ${RT_COLUMNS} from platform.resource_runtime where workspace_id = $1 and resource_id = $2`,
    [requireText("workspaceId", workspaceId), requireText("resourceId", resourceId)]
  );
  return rows.length ? toRuntime(rows[0]) : null;
}

export async function listRuntimeByEnvironment(sql: Sql, workspaceId: string, environmentId: string): Promise<(RuntimeState & { resourceId: string })[]> {
  const rows = await sql.query<RuntimeRow & { resource_id: string }>(
    `select resource_id, ${RT_COLUMNS} from platform.resource_runtime
      where workspace_id = $1 and environment_id = $2 order by address`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId)]
  );
  return rows.map((r) => ({ ...toRuntime(r), resourceId: r.resource_id }));
}
