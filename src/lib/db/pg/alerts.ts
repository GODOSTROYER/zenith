/**
 * Phase 3 package: alerts. Registers its collections with the store registry and
 * replaces its delegate group; nothing here runs until the module is imported
 * from src/lib/db/pg/all.ts, which happens once at store selection.
 *
 * Five tables, all loaded in prefetch round 3:
 *
 *     findings · navigator_runs · alert_rules · alert_events · alert_outbox
 *
 * The first four hang off a project, so they are filtered by the project ids
 * round 2 loaded; `alert_outbox` carries no project (a delivery intent belongs
 * to a channel, and a channel belongs to the workspace) and is filtered by
 * workspace id instead. None of the four domain types carries a `workspaceId`
 * field — a rule, an event, a finding and a Navigator run all reach their
 * tenant through their project — so the load stamps the answer on with
 * `setTenant` and the diff re-derives it from the project in the graph. Only
 * `AlertOutboxEntry` has a real `workspaceId`, and it is promoted like any
 * other field.
 *
 * ## Cross-instance outbox claims
 *
 * The bottom half of this file is the part the generic store cannot do for
 * `src/lib/alerts/deliver.ts`: a **per-row, version-guarded claim**. A snapshot
 * flush writes every dirty row and a single conflict aborts the batch, which is
 * right for a request and wrong for a drainer — there, "somebody else claimed
 * this row" is ordinary traffic, not an error. `claimOutboxRowIn` therefore
 * writes one row with `.eq("version", loaded)` outside the flush and reports
 * `false` instead of throwing, then re-syncs the snapshot (object *and*
 * baseline) so a later flush never 409s on a row this instance lost.
 *
 * Two instances draining at once is the case this exists for. `alert_outbox`'s
 * unique index on `idempotency_key` is the line behind it: even if a claim
 * protocol were wrong, a second row for the same (event, transition, channel)
 * cannot be inserted, so the duplicate send cannot be created in the first
 * place. `dropDuplicateOutboxRows` turns that refusal into the right outcome
 * — adopt the row the other instance wrote and drop our copy — rather than a
 * failed flush.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AlertEvent,
  AlertOutboxEntry,
  AlertRule,
  NavigatorRun,
  SecurityFinding,
} from "@/lib/domain/types";
import type { Database } from "../types";
import {
  hydrateWith,
  iso,
  keyScope,
  type PgRow,
  type PrefetchContext,
  type PrefetchQuery,
  registerCollection,
  storeError,
  tenantOf,
  type TenantContext,
} from "./registry";

/* --------------------------------- helpers -------------------------------- */

/** Round 3, keyed by the project ids round 2 loaded. `null` user loads all. */
const byProject = (ctx: PrefetchContext): PrefetchQuery =>
  ctx.user ? { kind: "in", column: "project_id", values: ctx.projectIds } : { kind: "all" };

/** Round 3, keyed by workspace — the outbox has no project of its own. */
const byWorkspace = (ctx: PrefetchContext): PrefetchQuery =>
  ctx.user ? { kind: "in", column: "workspace_id", values: ctx.workspaceIds } : { kind: "all" };

/**
 * The tenant answer for everything that reaches its workspace through a
 * project: the column during a load, the project in the live graph during a
 * diff, and the non-enumerable stamp the load left behind when neither is
 * available (a row saved by a caller that never re-read it).
 */
const viaProject = (row: { projectId: string }, ctx: TenantContext): string => {
  const own = ctx.row?.workspace_id;
  if (own) return String(own);
  const project = ctx.db?.projects.find((p) => p.id === row.projectId);
  return project ? project.workspaceId : tenantOf(row);
};

/**
 * `hydrateWith`, plus the timestamp fields the registry's own list does not
 * know about.
 *
 * The registry normalises `createdAt`/`acceptedAt`/`lastCheckedAt` because
 * those are the only promoted timestamps Phase 2 had. `firedAt`, `resolvedAt`
 * and `claimedAt` are this package's, and Postgres hands `timestamptz` back as
 * `2026-09-02T12:00:00+00:00` — same instant, different bytes from the
 * `toISOString()` the file store stored. Without this a hydrated AlertEvent
 * would not be `toEqual` the one FileStore hands out, which is the whole claim
 * the contract suite makes.
 */
function hydrateIso<T>(rename: Record<string, string>, fields: string[]): (row: PgRow) => T {
  const base = hydrateWith<T>(rename);
  return (row) => {
    const out = base(row) as Record<string, unknown>;
    for (const field of fields) {
      const value = out[field];
      if (typeof value === "string" && value) out[field] = new Date(value).toISOString();
    }
    return out as T;
  };
}

/* ---------------------------------------------------------------------------
 * Registration order is foreign-key order: writes run down this list, deletes
 * run back up it. Findings and Navigator runs hang off a project only; a rule
 * comes before the events it produced, and an event before the outbox rows
 * that deliver it.
 * ------------------------------------------------------------------------- */

const findingRename = {
  project_id: "projectId",
  environment_id: "environmentId",
  status: "status",
  severity: "severity",
  created_at: "createdAt",
};

registerCollection<SecurityFinding>({
  collection: "findings",
  table: "findings",
  key: (r) => ({ id: r.id }),
  tenant: viaProject,
  promote: (f) => ({
    project_id: f.projectId,
    environment_id: f.environmentId ?? null,
    status: f.status,
    severity: f.severity,
    created_at: iso(f.createdAt),
  }),
  rename: findingRename,
  hydrate: hydrateIso<SecurityFinding>(findingRename, ["resolvedAt"]),
  prefetch: { round: 3, filter: byProject },
  rows: (db: Database) => db.findings as unknown as { id: string }[],
});

const navigatorRename = {
  project_id: "projectId",
  status: "status",
  created_at: "createdAt",
};

registerCollection<NavigatorRun>({
  collection: "navigatorRuns",
  table: "navigator_runs",
  key: (r) => ({ id: r.id }),
  tenant: viaProject,
  promote: (r) => ({ project_id: r.projectId, status: r.status, created_at: iso(r.createdAt) }),
  rename: navigatorRename,
  hydrate: hydrateIso<NavigatorRun>(navigatorRename, ["endedAt"]),
  prefetch: { round: 3, filter: byProject },
  rows: (db: Database) => db.navigatorRuns as unknown as { id: string }[],
});

const ruleRename = {
  project_id: "projectId",
  environment_id: "environmentId",
  kind: "kind",
  enabled: "enabled",
};

registerCollection<AlertRule>({
  collection: "alertRules",
  table: "alert_rules",
  key: (r) => ({ id: r.id }),
  tenant: viaProject,
  promote: (r) => ({
    project_id: r.projectId,
    environment_id: r.environmentId,
    kind: r.kind,
    enabled: r.enabled,
  }),
  rename: ruleRename,
  // `createdAt` lives in `data` (there is no created_at column on this table),
  // so it is already the exact string the file store wrote.
  hydrate: hydrateWith<AlertRule>(ruleRename),
  prefetch: { round: 3, filter: byProject },
  rows: (db: Database) => db.alertRules as unknown as { id: string }[],
});

const eventRename = {
  rule_id: "ruleId",
  project_id: "projectId",
  environment_id: "environmentId",
  fired_at: "firedAt",
  resolved_at: "resolvedAt",
};

registerCollection<AlertEvent>({
  collection: "alertEvents",
  table: "alert_events",
  key: (r) => ({ id: r.id }),
  tenant: viaProject,
  promote: (e) => ({
    rule_id: e.ruleId,
    project_id: e.projectId,
    environment_id: e.environmentId,
    fired_at: iso(e.firedAt),
    resolved_at: iso(e.resolvedAt),
  }),
  rename: eventRename,
  hydrate: hydrateIso<AlertEvent>(eventRename, ["firedAt", "resolvedAt", "acknowledgedAt"]),
  prefetch: { round: 3, filter: byProject },
  rows: (db: Database) => db.alertEvents as unknown as { id: string }[],
});

const outboxRename = {
  workspace_id: "workspaceId",
  channel_id: "channelId",
  event_id: "eventId",
  status: "status",
  claimed_at: "claimedAt",
  attempts: "attempts",
  idempotency_key: "idempotencyKey",
};

registerCollection<AlertOutboxEntry>({
  collection: "alertOutbox",
  table: "alert_outbox",
  key: (r) => ({ id: r.id }),
  // The one collection in this package that carries its own workspace.
  tenant: (r, ctx) => String(ctx.row?.workspace_id ?? r.workspaceId ?? tenantOf(r)),
  promote: (r) => ({
    channel_id: r.channelId,
    event_id: r.eventId,
    status: r.status,
    claimed_at: iso(r.claimedAt),
    attempts: r.attempts,
    idempotency_key: r.idempotencyKey,
  }),
  rename: outboxRename,
  hydrate: hydrateIso<AlertOutboxEntry>(outboxRename, ["claimedAt", "settledAt"]),
  prefetch: { round: 3, filter: byWorkspace },
  rows: (db: Database) => db.alertOutbox as unknown as { id: string }[],
});

/* ------------------------------ outbox claims ------------------------------ */

/**
 * The snapshot shape this file needs. Declared structurally rather than
 * imported, because `../postgres-store` imports `./all` which imports this
 * module: a value import here would close the cycle. Every entry point below
 * takes the snapshot as an argument or loads it through a dynamic import.
 */
interface SnapshotLike {
  data: Database;
  baseline: Map<string, { version: number; json: string }>;
}

/** `bkey()` in postgres-store: `collection:workspaceScope:id`. */
const bkey = (collection: string, id: string, workspaceId: string): string =>
  `${collection}:${keyScope(collection, workspaceId)}:${id}`;

const outboxKey = (row: AlertOutboxEntry): string =>
  bkey("alertOutbox", row.id, row.workspaceId);

/** The same canonical form the store's diff compares against. */
const canonical = (row: unknown): string => JSON.stringify(row);

const now = (): string => new Date().toISOString();

const rows = (snap: SnapshotLike): AlertOutboxEntry[] => {
  const d = snap.data as Database & { alertOutbox?: AlertOutboxEntry[] };
  d.alertOutbox ??= [];
  return d.alertOutbox;
};

async function client(): Promise<SupabaseClient> {
  const { pgClient } = await import("../postgres-store");
  return pgClient();
}

/** The snapshot this call reads, for the callers that do not hold one. */
export async function outboxSnapshot(): Promise<SnapshotLike> {
  const { currentSnapshot } = await import("../postgres-store");
  return currentSnapshot() as unknown as SnapshotLike;
}

const OUTBOX_HYDRATE = hydrateIso<AlertOutboxEntry>(outboxRename, ["claimedAt", "settledAt"]);

/**
 * Copy one database row over the snapshot's own, and re-baseline it so the
 * next flush compares against what is actually in the table. Used both when a
 * claim is won (this instance's write *is* the new truth) and when one is lost
 * (somebody else's write is), because a stale baseline on a row this snapshot
 * still holds would turn every later flush into a 409.
 */
function adoptRow(snap: SnapshotLike, dbRow: PgRow): AlertOutboxEntry {
  const fresh = OUTBOX_HYDRATE(dbRow);
  const list = rows(snap);
  const existing = list.find((r) => r.id === fresh.id);
  let target: AlertOutboxEntry;
  if (existing) {
    // Mutate in place: the live graph is what callers already hold references
    // to, and replacing the object would strand them on the old one.
    const held = existing as unknown as Record<string, unknown>;
    for (const k of Object.keys(held)) delete held[k];
    Object.assign(existing, fresh);
    target = existing;
  } else {
    list.push(fresh);
    target = fresh;
  }
  snap.baseline.set(outboxKey(target), {
    version: Number(dbRow.version ?? 1),
    json: canonical(target),
  });
  return target;
}

/**
 * Re-read this snapshot's outbox from the database.
 *
 * Two things make this necessary on a multi-instance host: a row another
 * instance enqueued is not in this snapshot at all, and a row this snapshot
 * loaded as `pending` may already be `sending` or settled. Only the claimable
 * window is fetched — `pending` and `sending` — because a settled row is never
 * re-driven and re-reading them would grow with the log. Rows are never
 * *removed* here: the store's diff reads an absent row as a delete.
 */
export async function refreshOutbox(snap: SnapshotLike, workspaceIds: string[]): Promise<void> {
  if (workspaceIds.length === 0) return;
  const { data, error } = await (await client())
    .from("alert_outbox")
    .select("*")
    .in("workspace_id", workspaceIds)
    .in("status", ["pending", "sending"]);
  if (error) throw storeError("alert_outbox", "read", error.message);
  for (const row of (data ?? []) as PgRow[]) adoptRow(snap, row);
}

/** Every workspace this snapshot holds outbox rows for. */
export const outboxWorkspaces = (snap: SnapshotLike): string[] => [
  ...new Set(rows(snap).map((r) => r.workspaceId).filter(Boolean)),
];

/**
 * Claim one row for this instance, guarded on the version it was loaded at.
 *
 * Returns `true` when this instance owns the row and may send it. `false` means
 * the guarded update matched nothing — another instance claimed it first, or
 * settled it — and the caller must **skip** the row: it is not an error, and it
 * is not a retry. Either way the snapshot is left agreeing with the table.
 *
 * A row with no baseline has never been written, so there is nothing to guard
 * against and nothing to claim yet; the caller flushes first (see
 * `claimPending` in ../../alerts/deliver.ts) and comes back.
 */
export async function claimOutboxRowIn(
  snap: SnapshotLike,
  row: AlertOutboxEntry,
  at: string = now()
): Promise<boolean> {
  const baseline = snap.baseline.get(outboxKey(row));
  if (!baseline || row.status !== "pending") return false;

  const c = await client();
  const { data, error } = await c
    .from("alert_outbox")
    .update({
      status: "sending",
      claimed_at: at,
      version: baseline.version + 1,
      updated_at: now(),
    })
    .eq("id", row.id)
    .eq("version", baseline.version)
    .select("*");
  if (error) throw storeError("alert_outbox", "claim a row in", error.message);

  const won = (data ?? []) as PgRow[];
  if (won.length === 1) {
    adoptRow(snap, won[0]);
    return true;
  }
  // Lost. Take whatever the winner wrote so this snapshot stops disagreeing.
  await resyncRow(snap, c, row);
  return false;
}

/** Pull one row back from the table, or forget it when it is gone. */
async function resyncRow(
  snap: SnapshotLike,
  c: SupabaseClient,
  row: AlertOutboxEntry
): Promise<void> {
  const { data, error } = await c.from("alert_outbox").select("*").eq("id", row.id).limit(1);
  if (error) throw storeError("alert_outbox", "re-read a row from", error.message);
  const found = ((data ?? []) as PgRow[])[0];
  if (found) {
    adoptRow(snap, found);
    return;
  }
  // Deleted underneath us. Drop the baseline *and* the object together: a
  // baseline with no object is a delete the next flush would issue.
  snap.baseline.delete(outboxKey(row));
  const list = rows(snap);
  const i = list.indexOf(row);
  if (i >= 0) list.splice(i, 1);
}

/**
 * Hand back rows whose claim has expired, one guarded write at a time.
 *
 * `claimed_at` is the only evidence a claim exists, and it is a column rather
 * than process state precisely so another instance can read it. A claim older
 * than the lease cannot still be in flight — nothing legitimately takes that
 * long — so the row goes back to `pending` under its original idempotency key.
 * A row whose guarded write loses was reclaimed or settled by somebody else in
 * the same instant, which is the correct outcome either way.
 */
export async function reclaimStaleIn(
  snap: SnapshotLike,
  leaseMs: number,
  at = Date.now()
): Promise<number> {
  const workspaces = outboxWorkspaces(snap);
  if (workspaces.length > 0) await refreshOutbox(snap, workspaces);
  const c = await client();
  let reclaimed = 0;
  for (const row of [...rows(snap)]) {
    if (row.status !== "sending") continue;
    const claimed = row.claimedAt ? Date.parse(row.claimedAt) : 0;
    // An unparseable or missing stamp is treated as expired: a row nobody can
    // prove is in flight is a row nobody is sending.
    if (Number.isFinite(claimed) && claimed > at - leaseMs) continue;
    const baseline = snap.baseline.get(outboxKey(row));
    if (!baseline) continue;
    const { data, error } = await c
      .from("alert_outbox")
      .update({
        status: "pending",
        claimed_at: null,
        version: baseline.version + 1,
        updated_at: now(),
      })
      .eq("id", row.id)
      .eq("version", baseline.version)
      .select("*");
    if (error) throw storeError("alert_outbox", "reclaim a row in", error.message);
    const won = (data ?? []) as PgRow[];
    if (won.length === 1) {
      adoptRow(snap, won[0]);
      reclaimed++;
    } else {
      await resyncRow(snap, c, row);
    }
  }
  return reclaimed;
}

/**
 * Drop local outbox rows the database already holds under the same
 * `idempotency_key`.
 *
 * The unique index is the last line against a duplicate send: two instances
 * that both decide to enqueue the same (event, transition, channel) produce one
 * row, and the loser's insert is refused. That refusal is correct and must not
 * surface as a failed flush — so the loser adopts the winner's row and drops
 * its own, which has never been written and therefore leaves no baseline and no
 * delete behind. Returns how many were dropped.
 */
export async function dropDuplicateOutboxRows(snap: SnapshotLike): Promise<number> {
  const list = rows(snap);
  const unwritten = list.filter((r) => !snap.baseline.has(outboxKey(r)));
  if (unwritten.length === 0) return 0;
  const { data, error } = await (await client())
    .from("alert_outbox")
    .select("*")
    .in("idempotency_key", unwritten.map((r) => r.idempotencyKey));
  if (error) throw storeError("alert_outbox", "check idempotency keys in", error.message);
  const taken = new Map<string, PgRow>();
  for (const row of (data ?? []) as PgRow[]) taken.set(String(row.idempotency_key), row);
  let dropped = 0;
  for (const row of unwritten) {
    const winner = taken.get(row.idempotencyKey);
    if (!winner || winner.id === row.id) continue;
    const i = list.indexOf(row);
    if (i >= 0) list.splice(i, 1);
    adoptRow(snap, winner);
    dropped++;
  }
  return dropped;
}
