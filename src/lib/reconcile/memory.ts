/**
 * In-memory implementation of the store, schedule-state, guard and signal
 * ports. It exists for tests and for `ZENITH_RECONCILE_MEMORY=1` (local
 * development, route smoke tests). It is NOT a production store: nothing is
 * durable, it is single-process, and its "transaction" is one synchronous
 * commit. A serverless deployment must wire the platform-store adapter.
 *
 * It enforces the same tenancy rule the SQL store does: an environment id
 * belongs to the first workspace that used it, and every method refuses a
 * different one (`tenant_mismatch`).
 *
 * The production `reconcile_state` table it stands in for:
 *
 *   platform.reconcile_state (
 *     environment_id    text primary key,
 *     workspace_id      text not null,
 *     step_index        int  not null default 0,
 *     next_run_at       timestamptz not null,
 *     priority          int  not null default 0,
 *     last_run_at       timestamptz,
 *     last_changed_at   timestamptz,
 *     last_graph_digest text,
 *     last_outcome      text,
 *     consecutive_failures int not null default 0,
 *     claimed_by        text,
 *     claimed_until     timestamptz,
 *     finding_since     jsonb not null default '{}',   -- written by ReconcileStore.commit
 *     updated_at        timestamptz not null default now()
 *   );
 *   create index on platform.reconcile_state (next_run_at) where claimed_until is null;
 */
import type { DriftReport, Observation, ResourceGraph, RuntimeState } from "@/lib/resources/types";
import { ReconcileError } from "./errors";
import type { EnvironmentGuard, GuardResult, HeldLease, ReconcilePassPorts, ReconcileSignalsPort } from "./pass-types";
import { applyNudge, DEFAULT_SCHEDULER_CONFIG, eligibility, priorityOf, selectDue, type ClaimedEnvironment, type ReconcileSchedule, type ReconcileStatePort, type SchedulerConfig } from "./scheduler";
import type {
  PreviousReconcile,
  ReconcileCommit,
  ReconcileEnvironment,
  ReconcileEvent,
  ReconcilePorts,
  ReconcileStore,
  RepairBroker,
  RepairOperationRef,
  SchedulableEnvironment,
  StoredResourceRef,
  StoredResourceStatus,
} from "./types";

export interface MemoryOperation extends RepairOperationRef {
  workspaceId: string;
  environmentId: string;
}

export interface MemoryBackendInit {
  now?: () => Date;
  /** scheduler config used by `claimDue`/`nudge` (must match the pass's) */
  scheduler?: Partial<SchedulerConfig>;
}

export class MemoryReconcileBackend {
  now: () => Date;
  private readonly scheduler: SchedulerConfig;

  readonly environments = new Map<string, SchedulableEnvironment>();
  readonly graphs = new Map<string, ResourceGraph>();
  private readonly owners = new Map<string, string>();
  private readonly resourceRows = new Map<string, Map<string, StoredResourceRef>>();

  readonly observations: { workspaceId: string; environmentId: string; resourceId: string; observation: Observation }[] = [];
  readonly runtime = new Map<string, RuntimeState>();
  readonly reports = new Map<string, DriftReport[]>();
  readonly findingSince = new Map<string, Record<string, string>>();
  readonly events: ReconcileEvent[] = [];
  readonly operations: MemoryOperation[] = [];
  readonly schedules = new Map<string, ReconcileSchedule>();
  readonly claims = new Map<string, { holder: string; until: number }>();
  readonly deploys: { workspaceId: string; environmentId: string; at: string }[] = [];
  /** environments whose `env:<id>` lease is held by a deploy/apply (tests toggle this) */
  readonly mutating = new Set<string>();
  private readonly leases = new Set<string>();

  constructor(init: MemoryBackendInit = {}) {
    this.now = init.now ?? (() => new Date());
    this.scheduler = { ...DEFAULT_SCHEDULER_CONFIG, ...(init.scheduler ?? {}) };
  }

  /* ------------------------------ seeding ------------------------------ */

  /** Register an environment, optionally with its deployed graph and stored rows. */
  addEnvironment(env: SchedulableEnvironment, graph?: ResourceGraph, status: StoredResourceStatus = "active"): this {
    this.assertTenant(env);
    this.environments.set(env.environmentId, env);
    if (graph) {
      this.graphs.set(env.environmentId, graph);
      this.seedResources(env, graph, status);
    }
    return this;
  }

  /** One stored row per graph node (the ids are deterministic so tests can name them). */
  seedResources(env: ReconcileEnvironment, graph: ResourceGraph, status: StoredResourceStatus = "active"): void {
    this.assertTenant(env);
    const rows = this.resourceRows.get(env.environmentId) ?? new Map<string, StoredResourceRef>();
    for (const node of graph.nodes)
      rows.set(node.address, { id: `res:${env.environmentId}:${node.address}`, address: node.address, ownership: node.ownership, status, ...(node.externalRef ? { externalId: node.externalRef } : {}) });
    this.resourceRows.set(env.environmentId, rows);
  }

  setResourceStatus(environmentId: string, address: string, patch: Partial<StoredResourceRef>): void {
    const row = this.resourceRows.get(environmentId)?.get(address);
    if (row) this.resourceRows.get(environmentId)?.set(address, { ...row, ...patch });
  }

  resourceId = (environmentId: string, address: string): string | undefined => this.resourceRows.get(environmentId)?.get(address)?.id;

  reportsOf = (environmentId: string): DriftReport[] => this.reports.get(environmentId) ?? [];
  eventsOf = (environmentId: string, type?: ReconcileEvent["type"]): ReconcileEvent[] => this.events.filter((e) => e.environmentId === environmentId && (!type || e.type === type));

  private assertTenant(env: { workspaceId: string; environmentId: string }): void {
    const owner = this.owners.get(env.environmentId);
    if (owner === undefined) this.owners.set(env.environmentId, env.workspaceId);
    else if (owner !== env.workspaceId) throw new ReconcileError("tenant_mismatch", "Environment not found in this workspace.");
  }

  /* ------------------------------- store ------------------------------- */

  readonly store: ReconcileStore = {
    listResources: async (env) => {
      this.assertTenant(env);
      return [...(this.resourceRows.get(env.environmentId)?.values() ?? [])].map((r) => ({ ...r }));
    },
    loadPrevious: async (env): Promise<PreviousReconcile | null> => {
      this.assertTenant(env);
      const reports = this.reports.get(env.environmentId);
      const report = reports?.[reports.length - 1];
      return report ? { report, findingSince: { ...(this.findingSince.get(env.environmentId) ?? {}) } } : null;
    },
    commit: async (commit: ReconcileCommit) => {
      const env = commit.environment;
      this.assertTenant(env);
      const known = this.resourceRows.get(env.environmentId);
      for (const o of commit.observations) {
        if (![...(known?.values() ?? [])].some((r) => r.id === o.resourceId)) throw new ReconcileError("tenant_mismatch", "Resource not found in this workspace.");
        this.observations.push({ workspaceId: env.workspaceId, environmentId: env.environmentId, resourceId: o.resourceId, observation: o.observation });
      }
      for (const r of commit.runtime) {
        const prev = this.runtime.get(r.resourceId);
        if (!prev || Date.parse(prev.observedAt) <= Date.parse(r.runtime.observedAt)) this.runtime.set(r.resourceId, r.runtime);
      }
      this.reports.set(env.environmentId, [...(this.reports.get(env.environmentId) ?? []), commit.report].slice(-50));
      this.findingSince.set(env.environmentId, { ...commit.findingSince });
      this.appendNow(commit.events);
    },
    appendEvents: async (env, events) => {
      this.assertTenant(env);
      this.appendNow(events);
    },
    listRepairOperations: async (env, sinceIso) => {
      this.assertTenant(env);
      const since = Date.parse(sinceIso);
      const terminal = new Set(["rejected", "denied", "succeeded", "failed", "cancelled", "expired"]);
      return this.operations
        .filter((o) => o.workspaceId === env.workspaceId && o.environmentId === env.environmentId && (!terminal.has(o.status) || Date.parse(o.createdAt) >= since))
        .map(({ workspaceId: _w, environmentId: _e, ...ref }) => ref);
    },
  };

  private appendNow(events: ReconcileEvent[]): void {
    for (const e of events) if (!this.events.some((x) => x.id === e.id)) this.events.push(e);
  }

  /* -------------------------------- state ------------------------------ */

  readonly state: ReconcileStatePort = {
    claimDue: async ({ now, limit, claimMs, holder }) => {
      const t = now.getTime();
      const items = [...this.environments.values()]
        .filter((environment) => !((this.claims.get(environment.environmentId)?.until ?? 0) > t))
        .map((environment) => {
          const real = this.schedules.get(environment.environmentId) ?? null;
          // A never-scheduled environment is due immediately, ordered by its own priority and then by id.
          const schedule = real ?? { nextRunAt: new Date(0).toISOString(), priority: priorityOf(environment, now, this.scheduler), environmentId: environment.environmentId };
          return { environment, real, schedule };
        });
      const claimed: ClaimedEnvironment[] = selectDue(items, now, limit, this.scheduler).map((d) => ({ environment: d.environment, schedule: d.real }));
      for (const c of claimed) this.claims.set(c.environment.environmentId, { holder, until: t + claimMs });
      return claimed;
    },
    complete: async ({ environment, schedule }) => {
      this.assertTenant(environment);
      this.schedules.set(environment.environmentId, schedule);
      this.claims.delete(environment.environmentId);
    },
    release: async ({ workspaceId, environmentId }) => {
      this.assertTenant({ workspaceId, environmentId });
      this.claims.delete(environmentId);
    },
    nudge: async ({ workspaceId, environmentId, at }) => {
      this.assertTenant({ workspaceId, environmentId });
      const current = this.schedules.get(environmentId) ?? null;
      const next = applyNudge(current, { at, config: this.scheduler });
      if (next && next !== current) this.schedules.set(environmentId, next);
    },
  };

  /* ------------------------------- guard ------------------------------- */

  readonly guard: EnvironmentGuard = {
    run: async <T>(env: ReconcileEnvironment, fn: (held: HeldLease) => Promise<T>): Promise<GuardResult<T>> => {
      this.assertTenant(env);
      if (this.mutating.has(env.environmentId)) return { ran: false, reason: "mutation_in_flight" };
      const scope = `reconcile:${env.environmentId}`;
      if (this.leases.has(scope)) return { ran: false, reason: "reconcile_lease_held" };
      this.leases.add(scope);
      try {
        return { ran: true, value: await fn({}) };
      } finally {
        this.leases.delete(scope);
      }
    },
  };

  /** Hold or drop the `reconcile:<env>` lease as another pass would (tests). */
  holdLease(environmentId: string, held = true): void {
    if (held) this.leases.add(`reconcile:${environmentId}`);
    else this.leases.delete(`reconcile:${environmentId}`);
  }

  readonly signals: ReconcileSignalsPort = {
    deploysSince: async ({ since, limit }) => this.deploys.filter((d) => Date.parse(d.at) >= since.getTime()).slice(0, limit),
  };

  /* ------------------------------- wiring ------------------------------ */

  loadGraph = async (env: ReconcileEnvironment): Promise<ResourceGraph | null> => {
    this.assertTenant(env);
    return this.graphs.get(env.environmentId) ?? null;
  };

  /**
   * Full pass ports over this backend. `broker`, `startRepair` and
   * `withObserveSession` default to inert versions that never act: memory mode
   * has no cloud and no capability broker, and pretending otherwise would be a
   * lie (it would need to invent observations).
   */
  passPorts(overrides: Partial<Pick<ReconcilePorts, "broker" | "startRepair" | "withObserveSession" | "driverFor" | "log">> = {}): ReconcilePassPorts {
    const inertBroker: RepairBroker = { propose: async () => ({ outcome: "deny", reason: "no capability broker is wired in memory mode" }) };
    return {
      now: () => this.now(),
      store: this.store,
      state: this.state,
      guard: this.guard,
      signals: this.signals,
      loadGraph: this.loadGraph,
      loadEnvironment: async (workspaceId, environmentId) => {
        const environment = this.environments.get(environmentId);
        return environment?.workspaceId === workspaceId ? environment : null;
      },
      broker: overrides.broker ?? inertBroker,
      startRepair: overrides.startRepair ?? (async () => undefined),
      withObserveSession: overrides.withObserveSession ?? ((_request, fn) => fn(undefined)),
      ...(overrides.driverFor ? { driverFor: overrides.driverFor } : {}),
      ...(overrides.log ? { log: overrides.log } : {}),
    };
  }

  /** Why an environment would be skipped, exposed for tests and dev tooling. */
  eligibilityOf = (environmentId: string): ReturnType<typeof eligibility> | undefined => {
    const env = this.environments.get(environmentId);
    return env ? eligibility(env, this.scheduler) : undefined;
  };
}
