/**
 * The platform-store adapter of the reconciliation controller, against the real
 * control-store schema (PGlite always; real PostgreSQL too when
 * ZENITH_TEST_PLATFORM_PG_URL is set, via the control-store harness).
 *
 * What is proven here is that the ports the controller is coded against are
 * backed by the real tables with the real tenancy, atomicity and fencing rules:
 * the commit, the claim, the guard, the signals. The fake "cloud" is the same
 * scripted World the in-memory tests use; nothing here talks to a provider.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LeaseLostError } from "@/lib/controlplane/types";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { acquire, release } from "@/lib/controlplane/db/repos/leases";
import {
  RECONCILER_PRINCIPAL,
  reconcileEnvironment,
  reconcileObserveOnce,
  reconcilePass,
  type ReconcileEnvironment,
  type SchedulableEnvironment,
} from "@/lib/reconcile";
import { createPlatformReconcilePorts, createPlatformState, createPlatformStore, loadGraphFromStore, loadPlatformEnvironment, registerEnvironment, requestReconcileNow } from "@/lib/reconcile/platform";
import { LANES, openLane, seedApprovedOperation, uid, type Lane } from "../controlplane/_support/harness";
import { FakeBroker, HOUR, MIN, SESSION_CANARY, World, graph } from "./_support";

const AWS = {
  provider: "aws" as const,
  mode: "aws_assume_role" as const,
  accountId: "123456789012",
  observeRoleArn: "arn:aws:iam::123456789012:role/zenith-observe",
  deployRoleArn: "arn:aws:iam::123456789012:role/zenith-deploy",
  externalId: "ext-1",
  region: "us-east-1",
};

interface Seeded {
  env: SchedulableEnvironment;
  connectionId: string;
}

describe.each(LANES)("reconcile platform adapter [$name]", (lane: Lane) => {
  let db: PlatformDbHandle;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const opened = await openLane(lane);
    db = opened.db;
    close = opened.close;
  }, 60_000);
  afterAll(async () => {
    await close();
  });

  /** A workspace with a verified connection, an environment with the fixture graph stored as `active` resources, registered with the controller. */
  async function seed(over: { workspaceId?: string; status?: "active" | "planned"; verified?: boolean; class?: SchedulableEnvironment["class"]; provider?: SchedulableEnvironment["provider"]; register?: boolean; nodes?: number } = {}): Promise<Seeded> {
    const workspaceId = over.workspaceId ?? uid("ws");
    const environmentId = uid("env");
    const conn = await repos.connections.create(db, { workspaceId, config: AWS, createdBy: "user_1" });
    if (over.verified !== false) await repos.connections.recordVerification(db, { workspaceId, id: conn.id, ok: true });
    const g = graph();
    for (const node of g.nodes.slice(0, over.nodes ?? g.nodes.length))
      if (node.ownership !== "external") await repos.resources.upsertDesired(db, { workspaceId, projectId: "proj_1", environmentId, node, status: over.status ?? "active" });
    const env: SchedulableEnvironment = {
      workspaceId,
      projectId: "proj_1",
      environmentId,
      class: over.class ?? "production",
      provider: over.provider ?? "aws",
      region: "us-east-1",
      connection: { id: conn.id, status: over.verified === false ? "pending_verification" : "verified" },
      autonomyLevel: 3,
    };
    if (over.register !== false) await registerEnvironment(db, { environment: env });
    return { env, connectionId: conn.id };
  }

  const portsFor = (world: World, broker = new FakeBrokerSql()) =>
    createPlatformReconcilePorts({
      db,
      broker,
      driverFor: world.driverFor,
      startRepair: async () => undefined,
      withObserveSession: async (_r, fn) => fn({ token: SESSION_CANARY }),
    });

  /** The broker for this suite: records proposals and creates NO operation (the store-backed ledger is asserted separately). */
  class FakeBrokerSql {
    readonly proposals: unknown[] = [];
    async propose(p: unknown) {
      this.proposals.push(p);
      return { outcome: "require_approval" as const, operationId: uid("op") };
    }
  }

  describe("store", () => {
    it("retains old uncertain repairs and other scoped mutations beyond every cooldown", async () => {
      const { env } = await seed();
      const web = await repos.resources.getByAddress(db, env.workspaceId, env.environmentId, "log_group/web");
      const repair = await seedApprovedOperation(db, env.workspaceId, { requester: RECONCILER_PRINCIPAL, proposal: { capability: "drift.repair", scope: { workspaceId: env.workspaceId, projectId: env.projectId, environmentId: env.environmentId, resourceId: web?.id } } });
      const mutation = await seedApprovedOperation(db, env.workspaceId, { proposal: { capability: "deployment.deploy", scope: { workspaceId: env.workspaceId, projectId: env.projectId, environmentId: env.environmentId } } });
      await db.query("update platform.operations set status='uncertain', created_at=clock_timestamp() - interval '1 year' where id=any($1::text[])", [`{${repair.operation.id},${mutation.operation.id}}`]);
      const refs = await createPlatformStore(db).listRepairOperations(env, new Date(Date.now() - HOUR).toISOString());
      expect(refs).toContainEqual(expect.objectContaining({ operationId: repair.operation.id, status: "uncertain", resourceId: web?.id }));
      expect(refs).toContainEqual(expect.objectContaining({ operationId: mutation.operation.id, status: "uncertain", blocksEnvironment: true }));
      const world = new World().allPresent(graph()).patch("log_group/web", { presence: "missing" });
      const broker = new FakeBrokerSql();
      const result = await reconcileEnvironment({ environment: env, graph: (await loadGraphFromStore(db, env)) ?? graph(), ports: portsFor(world, broker) });
      expect(result.repairs.find((r) => r.address === "log_group/web")).toMatchObject({ reason: "repair_uncertain" });
      expect(broker.proposals).toEqual([]);
    });

    it("refuses proposals when the bounded operations inventory would be incomplete", async () => {
      const { env } = await seed();
      const seeded = await seedApprovedOperation(db, env.workspaceId, { proposal: { capability: "drift.repair", scope: { workspaceId: env.workspaceId, environmentId: env.environmentId } } });
      await db.query(`insert into platform.operations (id,workspace_id,environment_id,capability,principal,status,proposal,proposal_digest,input_digest,correlation_id,expires_at)
        select id || '-bound-' || n::text, workspace_id, environment_id, capability, principal, status, proposal, proposal_digest, input_digest, correlation_id, expires_at
        from platform.operations cross join generate_series(1,500) n where id=$1`, [seeded.operation.id]);
      await expect(createPlatformStore(db).listRepairOperations(env, new Date(0).toISOString())).rejects.toMatchObject({ code: "platform_store_unavailable" });
      const world = new World().allPresent(graph()).patch("log_group/web", { presence: "missing" });
      const broker = new FakeBrokerSql();
      await expect(reconcileEnvironment({ environment: env, graph: (await loadGraphFromStore(db, env)) ?? graph(), ports: portsFor(world, broker) })).rejects.toMatchObject({ code: "platform_store_unavailable" });
      expect(broker.proposals).toEqual([]);
    });
    it("commits observations, runtime, the report, events and the first-seen map together, and reads them back", async () => {
      const { env } = await seed();
      const world = new World();
      const g = graph();
      world.allPresent(g);
      world.patch("log_group/web", { presence: "missing" });
      const ports = portsFor(world);

      const loaded = await loadGraphFromStore(db, env);
      expect(loaded?.nodes.map((n) => n.address)).toEqual(g.nodes.filter((n) => n.ownership !== "external").map((n) => n.address));
      expect(loaded?.environmentId).toBe(env.environmentId);

      const first = await reconcileEnvironment({ environment: env, graph: loaded ?? g, ports });
      expect(first.status).toBe("reconciled");
      expect(first.detected).toBe(1);

      // observed, runtime, report: all stored, all tenant-scoped
      const web = await repos.resources.getByAddress(db, env.workspaceId, env.environmentId, "log_group/web");
      expect(await repos.observations.latestObservation(db, env.workspaceId, web?.id ?? "")).toMatchObject({ presence: "missing", address: "log_group/web" });
      const svc = await repos.resources.getByAddress(db, env.workspaceId, env.environmentId, "container_service/web");
      expect(await repos.observations.getRuntime(db, env.workspaceId, svc?.id ?? "")).toMatchObject({ health: "healthy" });
      const report = await repos.drift.latest(db, env.workspaceId, env.environmentId);
      expect(report?.findings.map((f) => `${f.class}:${f.address}`)).toEqual(["missing:log_group/web"]);
      const stored = await createPlatformStore(db).loadPrevious(env);
      expect(stored?.report.graphDigest).toBe(loaded?.graphDigest);
      expect(Object.keys(stored?.findingSince ?? {})).toEqual(["missing|log_group/web"]);

      const events = await repos.events.list(db, env.workspaceId, { environmentId: env.environmentId });
      const detected = events.filter((e) => e.type === "drift.detected");
      expect(detected).toHaveLength(1);
      expect(detected[0]).toMatchObject({ actor: RECONCILER_PRINCIPAL, resourceId: web?.id, data: { address: "log_group/web", class: "missing", transition: "new" } });

      // a second pass after the fix clears it, on the same correlation id, and finds the first-seen map in the database
      world.patch("log_group/web", { presence: "present", attrs: { size: "small" } });
      const second = await reconcileEnvironment({ environment: env, graph: loaded ?? g, ports });
      expect(second.cleared).toBe(1);
      const after = await repos.events.list(db, env.workspaceId, { environmentId: env.environmentId });
      const cleared = after.find((e) => e.type === "drift.cleared");
      expect(cleared?.correlationId).toBe(detected[0].correlationId);
      expect((await createPlatformStore(db).loadPrevious(env))?.findingSince).toEqual({});
    });

    it("another workspace can neither read, write nor reconcile the environment", async () => {
      const { env } = await seed();
      const world = new World().allPresent(graph());
      const ports = portsFor(world);
      const intruder: ReconcileEnvironment = { ...env, workspaceId: uid("ws") };
      const loaded = await loadGraphFromStore(db, env);
      expect(await loadGraphFromStore(db, intruder)).toBeNull();
      expect(await createPlatformStore(db).listResources(intruder)).toEqual([]);
      const r = await reconcileEnvironment({ environment: intruder, graph: loaded ?? graph(), ports });
      expect(r.status).toBe("nothing_to_reconcile"); // it sees no rows of its own: nothing can be read or written through it
      expect(await repos.drift.latest(db, intruder.workspaceId, env.environmentId)).toBeNull();
      expect(await repos.drift.latest(db, env.workspaceId, env.environmentId)).toBeNull(); // and the owner's record is untouched
    });

    it("a commit with a stale fence writes nothing", async () => {
      const { env } = await seed();
      const scope = `reconcile:${env.environmentId}`;
      const lease = await acquire(db, { scope, holder: "reconcile-pass:old", ttlMs: 60_000, workspaceId: env.workspaceId });
      expect(lease).not.toBeNull();
      await release(db, lease ?? { scope, holder: "reconcile-pass:old", fenceToken: 0 });
      const taken = await acquire(db, { scope, holder: "reconcile-pass:new", ttlMs: 60_000, workspaceId: env.workspaceId });
      expect(taken?.fenceToken).toBeGreaterThan(lease?.fenceToken ?? 0);

      const world = new World().allPresent(graph());
      const loaded = await loadGraphFromStore(db, env);
      await expect(reconcileEnvironment({ environment: env, graph: loaded ?? graph(), ports: portsFor(world), fence: { scope, token: lease?.fenceToken ?? 0 } })).rejects.toBeInstanceOf(LeaseLostError);
      expect(await repos.drift.latest(db, env.workspaceId, env.environmentId)).toBeNull();
      const web = await repos.resources.getByAddress(db, env.workspaceId, env.environmentId, "log_group/web");
      expect(await repos.observations.latestObservation(db, env.workspaceId, web?.id ?? "")).toBeNull();
      if (taken) await release(db, taken);
    });

    it("lists drift.repair operations: open ones, recent terminal ones, and who proposed them", async () => {
      const { env } = await seed();
      const web = await repos.resources.getByAddress(db, env.workspaceId, env.environmentId, "log_group/web");
      const propose = (principal = RECONCILER_PRINCIPAL) =>
        seedApprovedOperation(db, env.workspaceId, {
          requester: principal,
          proposal: { capability: "drift.repair", scope: { workspaceId: env.workspaceId, projectId: "proj_1", environmentId: env.environmentId, resourceId: web?.id }, summary: "Repair", details: [] },
        });
      const mine = await propose();
      const theirs = await propose({ kind: "user", id: "user_9", name: "Alice" });
      await db.query("update platform.operations set status = 'succeeded', finished_at = clock_timestamp() where id = $1", [theirs.operation.id]);
      const old = await propose();
      await db.query("update platform.operations set status = 'succeeded', created_at = clock_timestamp() - interval '3 hours' where id = $1", [old.operation.id]);

      const refs = await createPlatformStore(db).listRepairOperations(env, new Date(Date.now() - HOUR).toISOString());
      const byId = new Map(refs.map((r) => [r.operationId, r]));
      expect(byId.get(mine.operation.id)).toMatchObject({ status: "approved", byReconciler: true, resourceId: web?.id });
      expect(byId.get(theirs.operation.id)).toMatchObject({ status: "succeeded", byReconciler: false });
      expect(byId.has(old.operation.id)).toBe(false); // terminal and older than the window

      // another workspace sees none of them
      expect(await createPlatformStore(db).listRepairOperations({ ...env, workspaceId: uid("ws") }, new Date(0).toISOString())).toEqual([]);
    });

    it("a full reconciliation proposes through the broker against the stored ledger and never re-proposes an open one", async () => {
      const { env } = await seed();
      const world = new World().allPresent(graph());
      world.patch("log_group/web", { presence: "missing" });
      const broker = new FakeBrokerSql();
      const ports = createPlatformReconcilePorts({ db, broker: broker as unknown as FakeBroker, driverFor: world.driverFor, startRepair: async () => undefined, withObserveSession: async (_r, fn) => fn(undefined) });
      const loaded = await loadGraphFromStore(db, env);
      const first = await reconcileEnvironment({ environment: env, graph: loaded ?? graph(), ports });
      expect(first.repairs.filter((d) => d.status === "proposed")).toHaveLength(1);
      expect(broker.proposals).toHaveLength(1);
      // the fake broker created no operation, so nothing is open in the ledger: a real broker's operation would be, and is covered above
      const web = await repos.resources.getByAddress(db, env.workspaceId, env.environmentId, "log_group/web");
      await seedApprovedOperation(db, env.workspaceId, {
        requester: RECONCILER_PRINCIPAL,
        proposal: { capability: "drift.repair", scope: { workspaceId: env.workspaceId, projectId: "proj_1", environmentId: env.environmentId, resourceId: web?.id }, summary: "Repair", details: [] },
      });
      const again = await reconcileEnvironment({ environment: env, graph: loaded ?? graph(), ports });
      expect(again.repairs.find((d) => d.address === "log_group/web")).toMatchObject({ reason: "repair_open" });
      expect(broker.proposals).toHaveLength(1);
    });
  });

  describe("state: registration, claims, schedules", () => {
    it("registration is idempotent, refreshes the descriptor, and an environment belongs to one workspace for life", async () => {
      const { env } = await seed({ register: false });
      await registerEnvironment(db, { environment: env });
      await registerEnvironment(db, { environment: { ...env, region: "eu-west-1" } });
      expect(await loadPlatformEnvironment(db, env.workspaceId, env.environmentId)).toMatchObject({ region: "eu-west-1", class: "production", provider: "aws", autonomyLevel: 1 /* store default */, connection: { status: "verified" } });
      await expect(registerEnvironment(db, { environment: { ...env, workspaceId: uid("ws") } })).rejects.toMatchObject({ code: "tenant_mismatch" });
      expect(await loadPlatformEnvironment(db, uid("ws"), env.environmentId)).toBeNull();
    });

    it("a changed connection (or class/provider) brings a parked environment forward; an unchanged registration touches nothing; reconcile-now works and is tenant-scoped", async () => {
      const { env } = await seed();
      const later = new Date(Date.now() + 3 * HOUR);
      await db.query("update platform.reconcile_state set next_run_at = $2::timestamptz, step_index = 3 where environment_id = $1", [env.environmentId, later.toISOString()]);
      const row = async () => (await db.query<{ next_run_at: string; step_index: number }>("select next_run_at, step_index from platform.reconcile_state where environment_id = $1", [env.environmentId]))[0];

      await registerEnvironment(db, { environment: env }); // same descriptor
      expect(await row()).toMatchObject({ step_index: 3 });
      expect(Date.parse((await row()).next_run_at)).toBe(later.getTime());

      const conn2 = await repos.connections.create(db, { workspaceId: env.workspaceId, config: AWS, createdBy: "user_1" });
      await registerEnvironment(db, { environment: { ...env, connection: { id: conn2.id, status: "pending_verification" } } });
      expect(await row()).toMatchObject({ step_index: 0 });
      expect(Date.parse((await row()).next_run_at)).toBeLessThan(later.getTime());

      await db.query("update platform.reconcile_state set next_run_at = $2::timestamptz, step_index = 3 where environment_id = $1", [env.environmentId, later.toISOString()]);
      expect(await requestReconcileNow(db, { workspaceId: uid("ws"), environmentId: env.environmentId })).toBe(false);
      expect(await row()).toMatchObject({ step_index: 3 });
      expect(await requestReconcileNow(db, { workspaceId: env.workspaceId, environmentId: env.environmentId })).toBe(true);
      expect(await row()).toMatchObject({ step_index: 0 });
      expect(Date.parse((await row()).next_run_at)).toBeLessThan(later.getTime());
    });

    it("claims due environments best-first, atomically, and a claim expires", async () => {
      const a = await seed();
      const b = await seed();
      const state = createPlatformState(db);
      const now = new Date();
      const claim = (limit: number, at = now) => state.claimDue({ now: at, limit, claimMs: 60_000, holder: "h", includeSandbox: false });
      // other tests' environments share the schema on Postgres: look only at ours
      const ours = new Set([a.env.environmentId, b.env.environmentId]);
      const first = (await claim(1000)).filter((c) => ours.has(c.environment.environmentId));
      expect(first.map((c) => c.environment.environmentId).sort()).toEqual([...ours].sort());
      expect(first[0].schedule).toBeNull(); // never scheduled: due immediately
      expect(first[0].environment).toMatchObject({ workspaceId: expect.any(String), class: "production", autonomyLevel: 1, openIncidents: 0, connection: { status: "verified" } });
      // claimed: a second claim sees neither
      expect((await claim(1000)).filter((c) => ours.has(c.environment.environmentId))).toEqual([]);
      // released: due again
      await state.release({ workspaceId: a.env.workspaceId, environmentId: a.env.environmentId });
      expect((await claim(1000)).filter((c) => ours.has(c.environment.environmentId)).map((c) => c.environment.environmentId)).toEqual([a.env.environmentId]);
      // expired: due again
      const later = new Date(now.getTime() + 2 * MIN);
      expect((await claim(1000, later)).filter((c) => ours.has(c.environment.environmentId)).map((c) => c.environment.environmentId).sort()).toEqual([...ours].sort());
    });

    it("never claims a sandbox environment (unless configured) or one without a verified connection, and parks it", async () => {
      const sandbox = await seed({ class: "sandbox", provider: "sandbox" });
      const unverified = await seed({ verified: false });
      const state = createPlatformState(db);
      const ours = new Set([sandbox.env.environmentId, unverified.env.environmentId]);
      const now = new Date();
      const claimed = (await state.claimDue({ now, limit: 1000, claimMs: 60_000, holder: "h", includeSandbox: false })).filter((c) => ours.has(c.environment.environmentId));
      expect(claimed).toEqual([]);
      const rows = await db.query<{ environment_id: string; step_index: number; last_outcome: string; next_run_at: string }>(
        "select environment_id, step_index, last_outcome, next_run_at from platform.reconcile_state where environment_id = any($1::text[])",
        [`{${[...ours].map((i) => `"${i}"`).join(",")}}`]
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r).toMatchObject({ step_index: 3, last_outcome: "ineligible" });
        expect(Date.parse(r.next_run_at)).toBeGreaterThanOrEqual(now.getTime() + 180 * MIN);
      }
      // a sandbox IS claimed when the pass is configured to include it
      const again = await seed({ class: "sandbox", provider: "sandbox" });
      const included = (await state.claimDue({ now: new Date(Date.now() + 1000), limit: 1000, claimMs: 60_000, holder: "h", includeSandbox: true })).filter((c) => c.environment.environmentId === again.env.environmentId);
      expect(included).toHaveLength(1);
    });

    it("orders by next run minus priority, and surfaces open incidents and autonomy", async () => {
      const slow = await seed();
      const fast = await seed();
      await repos.incidents.openIncident(db, { workspaceId: fast.env.workspaceId, environmentId: fast.env.environmentId, title: "5xx", severity: "high", source: "test", correlationId: uid("corr") });
      await repos.settings.putEnvironmentSettings(db, { workspaceId: fast.env.workspaceId, environmentId: fast.env.environmentId, autonomyLevel: 4, updatedBy: "user_1" });
      const state = createPlatformState(db);
      const now = new Date();
      // both are due: `slow` 40 min overdue, `fast` 35 min overdue but priority 2 (worth 20 min)
      await db.query("update platform.reconcile_state set next_run_at = $2::timestamptz, priority = 0 where environment_id = $1", [slow.env.environmentId, new Date(now.getTime() - 40 * MIN).toISOString()]);
      await db.query("update platform.reconcile_state set next_run_at = $2::timestamptz, priority = 2 where environment_id = $1", [fast.env.environmentId, new Date(now.getTime() - 35 * MIN).toISOString()]);
      const claimed = (await state.claimDue({ now, limit: 1000, claimMs: 60_000, holder: "h", includeSandbox: false })).filter((c) => [slow.env.environmentId, fast.env.environmentId].includes(c.environment.environmentId));
      expect(claimed.map((c) => c.environment.environmentId)).toEqual([fast.env.environmentId, slow.env.environmentId]);
      expect(claimed[0].environment).toMatchObject({ openIncidents: 1, autonomyLevel: 4 });
      expect(claimed[1].environment).toMatchObject({ openIncidents: 0 });
      // released, the limit bounds the claim (on a shared schema the one claimed may be another suite's environment)
      for (const c of claimed) await state.release({ workspaceId: c.environment.workspaceId, environmentId: c.environment.environmentId });
      expect(await state.claimDue({ now, limit: 1, claimMs: 60_000, holder: "h", includeSandbox: false })).toHaveLength(1);
    });

    it("complete persists the schedule and releases the claim; release keeps the schedule; both are tenant-scoped", async () => {
      const { env } = await seed();
      const state = createPlatformState(db);
      const now = new Date();
      await state.claimDue({ now, limit: 1000, claimMs: 60_000, holder: "h", includeSandbox: false });
      const schedule = { workspaceId: env.workspaceId, environmentId: env.environmentId, stepIndex: 2, nextRunAt: new Date(now.getTime() + HOUR).toISOString(), priority: 0, lastRunAt: now.toISOString(), lastChangedAt: now.toISOString(), lastGraphDigest: "d".repeat(64), lastOutcome: "reconciled" as const, consecutiveFailures: 0 };
      await state.complete({ environment: env, schedule });
      const row = (await db.query<Record<string, unknown>>("select * from platform.reconcile_state where environment_id = $1", [env.environmentId]))[0];
      expect(row).toMatchObject({ step_index: 2, last_outcome: "reconciled", last_graph_digest: "d".repeat(64), claimed_by: null, claimed_until: null, consecutive_failures: 0 });
      const due = await state.claimDue({ now: new Date(now.getTime() + 2 * HOUR), limit: 1000, claimMs: 60_000, holder: "h", includeSandbox: false });
      const mine = due.find((c) => c.environment.environmentId === env.environmentId);
      expect(mine?.schedule).toMatchObject({ stepIndex: 2, lastOutcome: "reconciled", nextRunAt: schedule.nextRunAt });
      await expect(state.complete({ environment: { ...env, workspaceId: uid("ws") }, schedule })).rejects.toMatchObject({ code: "tenant_mismatch" });
    });

    it("a deploy nudge resets the ladder and pulls the next run forward, once, in one statement", async () => {
      const { env } = await seed();
      const state = createPlatformState(db);
      const now = new Date();
      await state.claimDue({ now, limit: 1000, claimMs: 1, holder: "h", includeSandbox: false });
      await state.complete({ environment: env, schedule: { workspaceId: env.workspaceId, environmentId: env.environmentId, stepIndex: 3, nextRunAt: new Date(now.getTime() + 180 * MIN).toISOString(), priority: 0, lastRunAt: now.toISOString(), consecutiveFailures: 0 } });
      const at = new Date(now.getTime() + 10 * MIN).toISOString();
      await state.nudge({ workspaceId: env.workspaceId, environmentId: env.environmentId, at });
      const after = (await db.query<{ step_index: number; next_run_at: string; priority: number; last_deploy_at: string }>("select step_index, next_run_at, priority, last_deploy_at from platform.reconcile_state where environment_id = $1", [env.environmentId]))[0];
      expect(after.step_index).toBe(0);
      expect(after.priority).toBe(2);
      expect(Date.parse(after.last_deploy_at)).toBe(Date.parse(at));
      expect(Date.parse(after.next_run_at)).toBeGreaterThanOrEqual(Date.parse(at) + 5 * MIN);
      expect(Date.parse(after.next_run_at)).toBeLessThan(Date.parse(at) + 6 * MIN + 1);
      await state.nudge({ workspaceId: env.workspaceId, environmentId: env.environmentId, at });
      expect((await db.query<{ next_run_at: string }>("select next_run_at from platform.reconcile_state where environment_id = $1", [env.environmentId]))[0].next_run_at).toBe(after.next_run_at);
      // a deploy this run already saw changes nothing
      await state.nudge({ workspaceId: env.workspaceId, environmentId: env.environmentId, at: new Date(now.getTime() - MIN).toISOString() });
      expect((await db.query<{ step_index: number }>("select step_index from platform.reconcile_state where environment_id = $1", [env.environmentId]))[0].step_index).toBe(0);
      // another workspace's nudge finds nothing to change
      await state.nudge({ workspaceId: uid("ws"), environmentId: env.environmentId, at: new Date(now.getTime() + 20 * MIN).toISOString() });
      expect((await db.query<{ next_run_at: string }>("select next_run_at from platform.reconcile_state where environment_id = $1", [env.environmentId]))[0].next_run_at).toBe(after.next_run_at);
    });
  });

  describe("guard and signals", () => {
    it("runs the work under the reconcile lease with its fence, and releases it after", async () => {
      const { env } = await seed();
      const ports = portsFor(new World());
      let seen: { scope: string; token: number } | undefined;
      const r = await ports.guard.run(env, async (held) => {
        seen = held.fence;
        expect(held.signal?.aborted).toBe(false);
        // while it runs, a second pass is refused
        expect(await ports.guard.run(env, async () => "nested")).toEqual({ ran: false, reason: "reconcile_lease_held" });
        return "done";
      });
      expect(r).toEqual({ ran: true, value: "done" });
      expect(seen?.scope).toBe(`reconcile:${env.environmentId}`);
      expect(await repos.leases.current(db, `reconcile:${env.environmentId}`)).toBeNull(); // released
      expect(await ports.guard.run(env, async () => 1)).toEqual({ ran: true, value: 1 });
    });

    it("is refused while a mutation holds the environment, and while the Temporal reconcile workflow holds the same scope", async () => {
      const { env } = await seed();
      const ports = portsFor(new World());
      const deploy = await acquire(db, { scope: `env:${env.environmentId}`, holder: "op:deploy", ttlMs: 60_000, workspaceId: env.workspaceId });
      expect(await ports.guard.run(env, async () => 1)).toEqual({ ran: false, reason: "mutation_in_flight" });
      if (deploy) await release(db, deploy);
      const wf = await acquire(db, { scope: `reconcile:${env.environmentId}`, holder: `reconcile-${env.environmentId}`, ttlMs: 60_000, workspaceId: env.workspaceId });
      expect(await ports.guard.run(env, async () => 1)).toEqual({ ran: false, reason: "reconcile_lease_held" });
      if (wf) await release(db, wf);
    });

    it("reports environments whose deploy finished recently, and only succeeded deploys", async () => {
      const { env } = await seed();
      const deploy = async (capability: string, status: string) => {
        const op = await seedApprovedOperation(db, env.workspaceId, { proposal: { capability, scope: { workspaceId: env.workspaceId, projectId: "proj_1", environmentId: env.environmentId }, summary: "x", details: [] } });
        await db.query("update platform.operations set status = $2, finished_at = clock_timestamp() where id = $1", [op.operation.id, status]);
      };
      await deploy("deployment.deploy", "failed");
      await deploy("service.restart", "succeeded");
      const ports = portsFor(new World());
      const since = new Date(Date.now() - 5 * MIN);
      expect((await ports.signals?.deploysSince({ since, limit: 500 }))?.filter((d) => d.environmentId === env.environmentId)).toEqual([]);
      await deploy("deployment.deploy", "succeeded");
      const hits = (await ports.signals?.deploysSince({ since, limit: 500 }))?.filter((d) => d.environmentId === env.environmentId) ?? [];
      expect(hits).toHaveLength(1);
      expect(hits[0].workspaceId).toBe(env.workspaceId);
      expect((await ports.signals?.deploysSince({ since: new Date(Date.now() + HOUR), limit: 500 }))?.filter((d) => d.environmentId === env.environmentId)).toEqual([]);
    });
  });

  describe("the pass over the real store", () => {
    it("reconciles what is due, persists its schedule, reports drift and stays quiet the second time", async () => {
      const a = await seed();
      const b = await seed({ status: "planned" });
      const world = new World().allPresent(graph());
      world.patch("log_group/web", { presence: "missing" });
      const broker = new FakeBrokerSql();
      const ports = createPlatformReconcilePorts({ db, broker: broker as unknown as FakeBroker, driverFor: world.driverFor, startRepair: async () => undefined, withObserveSession: async (_r, fn) => fn(undefined) });
      const r = await reconcilePass({ ports, maxEnvironments: 500 });
      // (on a shared Postgres schema other suites' environments may also be claimed; ours must be among them)
      expect(r.failed).toBe(0);
      expect(r.reconciled).toBeGreaterThanOrEqual(1);
      expect(await repos.drift.latest(db, a.env.workspaceId, a.env.environmentId)).toMatchObject({ findings: [expect.objectContaining({ class: "missing", address: "log_group/web" })] });
      expect(await repos.drift.latest(db, b.env.workspaceId, b.env.environmentId)).toBeNull(); // planned: not deployed, not drift
      const row = (await db.query<{ step_index: number; last_outcome: string; claimed_until: string | null }>("select step_index, last_outcome, claimed_until from platform.reconcile_state where environment_id = $1", [a.env.environmentId]))[0];
      expect(row).toMatchObject({ step_index: 0, last_outcome: "reconciled", claimed_until: null });
      const b2 = (await db.query<{ last_outcome: string }>("select last_outcome from platform.reconcile_state where environment_id = $1", [b.env.environmentId]))[0];
      expect(b2.last_outcome).toBe("nothing_to_reconcile");
      expect((await reconcilePass({ ports, maxEnvironments: 500 })).claimed).toBeLessThanOrEqual(r.claimed); // nothing of ours is due again
      expect((await repos.events.list(db, a.env.workspaceId, { environmentId: a.env.environmentId })).filter((e) => e.type === "drift.detected")).toHaveLength(1);
    });

    it("the Temporal activity body reconciles one environment by id and answers counts only", async () => {
      const { env } = await seed();
      const world = new World().allPresent(graph());
      world.patch("log_group/web", { presence: "missing" });
      world.patch("network/main", { throws: new Error("socket hang up") });
      const broker = new FakeBrokerSql();
      const ports = createPlatformReconcilePorts({ db, broker: broker as unknown as FakeBroker, driverFor: world.driverFor, startRepair: async () => undefined, withObserveSession: async (_r, fn) => fn(undefined) });
      const deps = { ports, loadEnvironment: (w: string, e: string) => loadPlatformEnvironment(db, w, e), loadGraph: (e: ReconcileEnvironment) => loadGraphFromStore(db, e) };

      const observeOnly = await reconcileObserveOnce({ workspaceId: env.workspaceId, environmentId: env.environmentId }, deps);
      expect(observeOnly).toEqual({ drift: 1, unknown: 1, status: "reconciled", repairsProposed: 0 });
      expect(broker.proposals).toHaveLength(0); // allowAutoRepair defaults to false: observe and report only

      const withRepair = await reconcileObserveOnce({ workspaceId: env.workspaceId, environmentId: env.environmentId, autoRepair: true }, deps);
      expect(withRepair).toMatchObject({ drift: 1, unknown: 1, repairsProposed: 1 });

      await expect(reconcileObserveOnce({ workspaceId: uid("ws"), environmentId: env.environmentId }, deps)).rejects.toMatchObject({ code: "invalid_input" });
      const ghost = uid("env");
      await expect(reconcileObserveOnce({ workspaceId: env.workspaceId, environmentId: ghost }, deps)).rejects.toMatchObject({ code: "invalid_input" });
    });
  });
});
