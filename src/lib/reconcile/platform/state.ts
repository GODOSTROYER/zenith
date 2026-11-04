/**
 * The platform-store-backed `ReconcileStatePort` over `platform.reconcile_state`
 * (migration 0002), plus registration of an environment with the controller.
 *
 * Scheduling policy lives in `../scheduler.ts` and is pure; this file only
 * persists it and claims work. The claim is ONE statement: due, unclaimed,
 * eligible, best first (`next_run_at − priority × boost`), `FOR UPDATE SKIP
 * LOCKED`, so two passes running at once never take the same environment and a
 * pass that dies leaves a claim that simply expires (`claimed_until`).
 *
 * Environments the controller must not reconcile — a sandbox unless configured,
 * or no VERIFIED provider connection — are never claimed (the SQL mirrors
 * `eligibility()`); a bounded number of them are parked at the slowest step on
 * each claim so the due scan does not keep rediscovering them.
 *
 * Times are the caller's clock (`now` is a parameter), not the database's: a
 * schedule is advisory, deterministic tests need to control it, and all of it
 * is written and compared at millisecond precision from the same source.
 * Mutual exclusion — which DOES need the database clock — is the lease's job
 * (`guard.ts`).
 */
import type { Sql } from "@/lib/controlplane/types";
import type { AutonomyLevel } from "@/lib/policy/types";
import { DEFAULT_AUTONOMY_LEVEL } from "@/lib/controlplane/db/repos/settings";
import { textArray } from "@/lib/controlplane/db/sql";
import { ReconcileError } from "../errors";
import { jitterMs, resolveSchedulerConfig, scheduleAfterRun, type ClaimedEnvironment, type ReconcileSchedule, type ReconcileStatePort, type ScheduleOutcome, type SchedulerConfig } from "../scheduler";
import type { ReconcileEnvironment, SchedulableEnvironment } from "../types";

interface StateRow {
  environment_id: string;
  workspace_id: string;
  project_id: string | null;
  env_class: SchedulableEnvironment["class"];
  provider: SchedulableEnvironment["provider"];
  region: string;
  connection_id: string | null;
  step_index: number;
  next_run_at: string;
  priority: number;
  last_run_at: string | null;
  last_changed_at: string | null;
  last_deploy_at: string | null;
  last_graph_digest: string | null;
  last_outcome: string | null;
  consecutive_failures: number;
}

const COLUMNS = (t: string): string =>
  ["environment_id", "workspace_id", "project_id", "env_class", "provider", "region", "connection_id", "step_index", "next_run_at", "priority", "last_run_at", "last_changed_at", "last_deploy_at", "last_graph_digest", "last_outcome", "consecutive_failures"]
    .map((c) => `${t}.${c}`)
    .join(", ");

/** Mirrors `eligibility()`: simulated environments only when `$n` (includeSandbox) is true; real ones need a verified connection. */
const eligibleSql = (s: string, includeSandboxParam: string): string =>
  `(case when (${s}.env_class = 'sandbox' or ${s}.provider in ('sandbox', 'localstack')) then ${includeSandboxParam}::boolean
         else exists (select 1 from platform.provider_connections c
                       where c.workspace_id = ${s}.workspace_id and c.id = ${s}.connection_id and c.status = 'verified') end)`;

const isoOrUndefined = (v: string | null): string | undefined => (v ? new Date(v).toISOString() : undefined);

const toSchedule = (r: StateRow): ReconcileSchedule => ({
  workspaceId: r.workspace_id,
  environmentId: r.environment_id,
  stepIndex: r.step_index,
  nextRunAt: new Date(r.next_run_at).toISOString(),
  priority: r.priority,
  ...(r.last_run_at ? { lastRunAt: new Date(r.last_run_at).toISOString() } : {}),
  ...(r.last_changed_at ? { lastChangedAt: new Date(r.last_changed_at).toISOString() } : {}),
  ...(r.last_graph_digest ? { lastGraphDigest: r.last_graph_digest } : {}),
  ...(r.last_outcome ? { lastOutcome: r.last_outcome as ScheduleOutcome["kind"] } : {}),
  consecutiveFailures: r.consecutive_failures,
});

interface Facts {
  connections: Map<string, SchedulableEnvironment["connection"]>;
  autonomy: Map<string, AutonomyLevel>;
  incidents: Map<string, number>;
}

/** Connection status, autonomy and open incidents for a small claimed batch (≤ one pass's worth). */
async function factsFor(db: Sql, rows: readonly StateRow[]): Promise<Facts> {
  const facts: Facts = { connections: new Map(), autonomy: new Map(), incidents: new Map() };
  if (rows.length === 0) return facts;
  const key = (workspaceId: string, id: string): string => `${workspaceId}\u0000${id}`;
  const envIds = textArray([...new Set(rows.map((r) => r.environment_id))]);
  const connIds = textArray([...new Set(rows.flatMap((r) => (r.connection_id ? [r.connection_id] : [])))]);

  for (const c of await db.query<{ id: string; workspace_id: string; status: "pending_verification" | "verified" | "failed" | "revoked" }>(
    "select id, workspace_id, status from platform.provider_connections where id = any($1::text[])",
    [connIds]
  ))
    facts.connections.set(key(c.workspace_id, c.id), { id: c.id, status: c.status });

  for (const a of await db.query<{ environment_id: string; workspace_id: string; autonomy_level: number }>(
    "select environment_id, workspace_id, autonomy_level from platform.environment_settings where environment_id = any($1::text[])",
    [envIds]
  ))
    facts.autonomy.set(key(a.workspace_id, a.environment_id), a.autonomy_level as AutonomyLevel);

  for (const workspaceId of new Set(rows.map((r) => r.workspace_id)))
    for (const i of await db.query<{ environment_id: string; n: number }>(
      `select environment_id, count(*)::int as n from platform.incidents
        where workspace_id = $1 and environment_id = any($2::text[]) and status <> 'resolved' group by environment_id`,
      [workspaceId, textArray(rows.filter((r) => r.workspace_id === workspaceId).map((r) => r.environment_id))]
    ))
      facts.incidents.set(key(workspaceId, i.environment_id), i.n);
  return facts;
}

function toEnvironment(r: StateRow, facts: Facts): SchedulableEnvironment {
  const key = `${r.workspace_id}\u0000`;
  const connection = r.connection_id ? facts.connections.get(`${key}${r.connection_id}`) : undefined;
  return {
    workspaceId: r.workspace_id,
    ...(r.project_id ? { projectId: r.project_id } : {}),
    environmentId: r.environment_id,
    class: r.env_class,
    provider: r.provider,
    region: r.region,
    // A connection id with no (or another tenant's) connection row is reported as no connection: it is not reconcilable.
    ...(connection ? { connection } : {}),
    autonomyLevel: facts.autonomy.get(`${key}${r.environment_id}`) ?? DEFAULT_AUTONOMY_LEVEL,
    ...(r.last_deploy_at ? { lastDeployAt: isoOrUndefined(r.last_deploy_at) } : {}),
    openIncidents: facts.incidents.get(`${key}${r.environment_id}`) ?? 0,
  };
}

/** How many ineligible due environments one claim parks. */
const PARK_PER_CLAIM = 200;

export function createPlatformState(db: Sql, config?: Partial<SchedulerConfig>): ReconcileStatePort {
  const cfg = resolveSchedulerConfig(config);

  const complete = async (environment: SchedulableEnvironment | ReconcileEnvironment, schedule: ReconcileSchedule): Promise<void> => {
    const rows = await db.query<{ environment_id: string }>(
      `update platform.reconcile_state
          set step_index = $3::int, next_run_at = $4::timestamptz, priority = $5::int, last_run_at = $6::timestamptz,
              last_changed_at = $7::timestamptz, last_graph_digest = $8, last_outcome = $9, consecutive_failures = $10::int,
              claimed_by = null, claimed_until = null, updated_at = $6::timestamptz
        where workspace_id = $1 and environment_id = $2
        returning environment_id`,
      [
        environment.workspaceId,
        environment.environmentId,
        schedule.stepIndex,
        schedule.nextRunAt,
        schedule.priority,
        schedule.lastRunAt ?? schedule.nextRunAt,
        schedule.lastChangedAt ?? null,
        schedule.lastGraphDigest ?? null,
        schedule.lastOutcome ?? null,
        schedule.consecutiveFailures,
      ]
    );
    if (rows.length === 0) throw new ReconcileError("tenant_mismatch", "Environment not found in this workspace.");
  };

  return {
    async claimDue({ now, limit, claimMs, holder, includeSandbox }) {
      const nowIso = now.toISOString();
      const n = Math.max(0, Math.trunc(limit));
      if (n === 0) return [];

      // Park a bounded number of due environments the controller must not reconcile, so they stop being rediscovered.
      const parked = await db.query<StateRow>(
        `select ${COLUMNS("s")} from platform.reconcile_state s
          where s.next_run_at <= $1::timestamptz and (s.claimed_until is null or s.claimed_until <= $1::timestamptz)
            and not ${eligibleSql("s", "$2")}
          order by s.next_run_at limit $3::bigint`,
        [nowIso, includeSandbox, PARK_PER_CLAIM]
      );
      if (parked.length > 0) {
        const facts = await factsFor(db, parked);
        for (const row of parked) {
          const environment = toEnvironment(row, facts);
          await complete(environment, scheduleAfterRun({ environment, previous: row.last_run_at ? toSchedule(row) : null, outcome: { kind: "ineligible" }, now, config: cfg }));
        }
      }

      const claimed = await db.query<StateRow>(
        `with picked as (
           select s.environment_id from platform.reconcile_state s
            where s.next_run_at <= $1::timestamptz and (s.claimed_until is null or s.claimed_until <= $1::timestamptz)
              and ${eligibleSql("s", "$5")}
            order by s.next_run_at - (s.priority * $6::bigint * interval '1 millisecond'), s.environment_id
            limit $2::bigint
            for update of s skip locked)
         update platform.reconcile_state t
            set claimed_by = $3, claimed_until = $1::timestamptz + ($4::bigint * interval '1 millisecond'), updated_at = $1::timestamptz
           from picked
          where t.environment_id = picked.environment_id
          returning ${COLUMNS("t")}`,
        [nowIso, n, holder, Math.trunc(claimMs), includeSandbox, cfg.priorityBoostMs]
      );
      const facts = await factsFor(db, claimed);
      const byId = new Map(claimed.map((r) => [r.environment_id, r]));
      const order = [...claimed].sort(
        (a, b) =>
          Date.parse(a.next_run_at) - a.priority * cfg.priorityBoostMs - (Date.parse(b.next_run_at) - b.priority * cfg.priorityBoostMs) ||
          (a.environment_id < b.environment_id ? -1 : 1)
      );
      return order.map((r): ClaimedEnvironment => ({ environment: toEnvironment(byId.get(r.environment_id) ?? r, facts), schedule: r.last_run_at ? toSchedule(r) : null }));
    },

    complete: ({ environment, schedule }) => complete(environment, schedule),

    async release({ workspaceId, environmentId }) {
      await db.query(
        "update platform.reconcile_state set claimed_by = null, claimed_until = null where workspace_id = $1 and environment_id = $2",
        [workspaceId, environmentId]
      );
    },

    /** A deploy finished at `at`: same semantics as `applyNudge`, as one statement so concurrent nudges cannot disagree. */
    async nudge({ workspaceId, environmentId, at }) {
      const soonMs = cfg.steps[0] + jitterMs(environmentId, cfg.steps[0], cfg.jitterFraction);
      await db.query(
        `update platform.reconcile_state
            set last_deploy_at = greatest(coalesce(last_deploy_at, $3::timestamptz), $3::timestamptz),
                priority = greatest(priority, 2),
                step_index = 0,
                next_run_at = least(next_run_at, $3::timestamptz + ($4::bigint * interval '1 millisecond'))
          where workspace_id = $1 and environment_id = $2 and (last_run_at is null or $3::timestamptz > last_run_at)`,
        [workspaceId, environmentId, at, soonMs]
      );
    },
  };
}

export interface RegisterEnvironmentInput {
  environment: ReconcileEnvironment;
  /** when the controller first looks at it; default: the moment of registration (due immediately) */
  now?: Date;
}

/**
 * Tell the controller an environment exists and what it is. Idempotent: the
 * descriptor (class, provider, region, connection) is refreshed, the schedule
 * and first-seen map are left alone. An environment id belongs to ONE workspace
 * for life: registering it under another is refused (`tenant_mismatch`).
 *
 * Call it when an environment is first deployed or connected, and again when
 * its connection changes; an environment that was never registered is never
 * scheduled.
 */
export async function registerEnvironment(db: Sql, input: RegisterEnvironmentInput): Promise<void> {
  const e = input.environment;
  const nowIso = (input.now ?? new Date()).toISOString();
  const rows = await db.query<{ environment_id: string }>(
    `insert into platform.reconcile_state (environment_id, workspace_id, project_id, env_class, provider, region, connection_id, next_run_at, registered_at, updated_at)
     select $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz, $8::timestamptz
      where not exists (select 1 from platform.reconcile_state x where x.environment_id = $1 and x.workspace_id <> $2)
     on conflict (environment_id) do update
        set project_id = excluded.project_id, env_class = excluded.env_class, provider = excluded.provider,
            region = excluded.region, connection_id = excluded.connection_id, updated_at = excluded.updated_at,
            -- a new connection, class or provider is a reason to look again soon (a parked environment is not stuck at 3 hours)
            next_run_at = case when platform.reconcile_state.connection_id is distinct from excluded.connection_id
                                 or platform.reconcile_state.env_class <> excluded.env_class
                                 or platform.reconcile_state.provider <> excluded.provider
                               then least(platform.reconcile_state.next_run_at, excluded.next_run_at) else platform.reconcile_state.next_run_at end,
            step_index = case when platform.reconcile_state.connection_id is distinct from excluded.connection_id
                                or platform.reconcile_state.env_class <> excluded.env_class
                                or platform.reconcile_state.provider <> excluded.provider
                              then 0 else platform.reconcile_state.step_index end
      where platform.reconcile_state.workspace_id = excluded.workspace_id
     returning environment_id`,
    [e.environmentId, e.workspaceId, e.projectId ?? null, e.class, e.provider, e.region, e.connection?.id ?? null, nowIso]
  );
  if (rows.length === 0) throw new ReconcileError("tenant_mismatch", "Environment not found in this workspace.");
}

/**
 * "Look at this environment soon": a person asked, or its connection was just
 * verified. Pulls the next run to `now` (never later than it already is), resets
 * the backoff ladder and raises its priority one point. Returns false when the
 * environment is not registered in this workspace.
 */
export async function requestReconcileNow(db: Sql, input: { workspaceId: string; environmentId: string; now?: Date }): Promise<boolean> {
  const rows = await db.query<{ environment_id: string }>(
    `update platform.reconcile_state
        set next_run_at = least(next_run_at, $3::timestamptz), step_index = 0, priority = greatest(priority, 1), updated_at = $3::timestamptz
      where workspace_id = $1 and environment_id = $2
      returning environment_id`,
    [input.workspaceId, input.environmentId, (input.now ?? new Date()).toISOString()]
  );
  return rows.length > 0;
}

/** The descriptor the controller holds for an environment, joined with its connection and autonomy; null when not registered. */
export async function loadPlatformEnvironment(db: Sql, workspaceId: string, environmentId: string): Promise<SchedulableEnvironment | null> {
  const rows = await db.query<StateRow>(`select ${COLUMNS("s")} from platform.reconcile_state s where s.workspace_id = $1 and s.environment_id = $2`, [workspaceId, environmentId]);
  if (rows.length === 0) return null;
  return toEnvironment(rows[0], await factsFor(db, rows));
}

