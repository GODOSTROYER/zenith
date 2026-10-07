/**
 * PROD-MIX follow-up on the real platform SQL store (migration 42): the producer output reader and the drift and
 * migration signals of the mixed run. PGlite always, real PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is set (the same
 * lanes as the other platform suites). The product store, the child launcher, the semantics store and the human review
 * opener are fakes, labelled as such; the cloud is never reached. Producer "observations" are rows written to the real
 * observation table the way the child's own observe step writes them.
 *
 * Proven here: the output record table (append-only, tenant scoped, a changed value is a conflict, no value column), the
 * observation window (only a real, present, error-free read between the child operation's creation and its receipt counts),
 * the reader end to end through `materializeIncoming` (blocked when nothing was read back, a review opened for the changed
 * parent digest when it was, never a start on a guess), and the signal reads (drift reports newer than the child operation,
 * release-run migration classes, tenant scoping) that the ordering rules act on at child start.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_MIGRATIONS, repos } from "@/lib/controlplane/db";
import * as outputRecords from "@/lib/controlplane/db/repos/mixed-output-records";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import { createPlatformReleaseStore } from "@/lib/controlplane/db/repos/release-pipelines";
import type { Sql } from "@/lib/controlplane/types";
import type { ProviderConnection } from "@/lib/credentials/types";
import { parentProposalInput } from "@/lib/execution/mixed/parent-plan";
import { adoptChildOperation, advanceChild, beginParent, observeChild, planMixed, type ChildLauncher, type MixedDeps } from "@/lib/execution/mixed/service";
import { joinedLauncher, materializeIncoming, openRunForParent, recordChildStart, syncChildOutcome, type JoinDeps } from "@/lib/execution/mixed/orchestration-join";
import { platformOutputRecordStore, productionWorldHooks } from "@/lib/execution/mixed/output-source";
import { platformOrderingSignals, readOrderingSignals, readRunSignals } from "@/lib/execution/mixed/signals";
import type { MixedParentPlan } from "@/lib/execution/mixed/types";
import type { MixedWorld } from "@/lib/execution/mixed/world";
import { MixedOrchestrationError, readMixedRun, refusingParentReviewPort, type MixedRunDeps } from "@/lib/execution/mixed-orchestration";
import { MemoryPreauthorizationStore } from "@/lib/execution/mixed-orchestration/preauthorization";
import { MemoryMixedRunStore } from "@/lib/execution/mixed-orchestration/run-store";
import type { SemanticsStore } from "@/lib/execution/semantics/store";
import type { DeployWorkflowInput } from "@/lib/workflows/types";
import { LANES, approve, openLane, seedApprovedOperation, seedAwaitingApproval, uid } from "./_support/harness";
import { DB, PARENT_ENV, PROJECT, WEB, connection, mixedGraph, refresh } from "../execution/mixed/_fixtures";

const ENVIRONMENTS = ["env-azure", "env-gcp", "env-aws"] as const;
const PROVIDER_OF: Record<string, "azure" | "gcp" | "aws"> = { "env-azure": "azure", "env-gcp": "gcp", "env-aws": "aws" };
const SEMANTICS = "9".repeat(64);
const HOST_VALUE = "db.internal.example";
const REFERENCE = { id: "db-host", producer: { address: DB, output: "endpoint", type: "endpoint" as const }, consumer: { address: WEB, input: "endpoint_db", type: "endpoint" as const } };
const dg = (c: string) => `sha256:${c.repeat(64)}`;

describe("migration inventory", () => {
  it("42 creates the append-only output record table with row level security and no anon access", () => {
    const migration = PLATFORM_MIGRATIONS.find((item) => item.name === "mixed_output_records");
    expect(migration?.version).toBe(42);
    expect(migration!.sql).toContain("platform.mixed_output_records");
    expect(migration!.sql).toContain("alter table platform.mixed_output_records enable row level security");
    expect(migration!.sql).toContain("Mixed output records are append-only");
    expect(migration!.sql).toContain("grant select,insert on table platform.mixed_output_records to service_role");
  });
});

class FakeLauncher implements ChildLauncher {
  constructor(private readonly db: Sql) {}
  async claim(workspaceId: string, operationId: string): Promise<"claimed" | "already_claimed"> {
    const rows = await this.db.query(
      `update platform.operations set status = 'running', lease_holder = $3, lease_until = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp()
        where workspace_id = $1 and id = $2 and status in ('approved','queued') returning id`, [workspaceId, operationId, `workflow:${operationId}`]);
    return rows.length ? "claimed" : "already_claimed";
  }
  async start(_input: DeployWorkflowInput): Promise<void> { /* the workflow start is a fake; nothing runs */ }
}

describe.each(LANES)("mixed follow-up: producer outputs and ordering signals [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx.close(); });
  const db = () => ctx.db;
  const clock = async (): Promise<string> => new Date((await db().query<{ t: unknown }>("select clock_timestamp() as t"))[0].t as string).toISOString();

  interface Scenario {
    ws: string;
    plan: MixedParentPlan;
    deps: MixedDeps;
    join: JoinDeps;
    launcher: FakeLauncher;
    reviews: { review: { requiredParentDigest: string; childSetDigest: string; consumers: { childId: string }[] } }[];
    parentOperationId: string;
    childOperations: Record<string, string>;
    producer: string;
    consumer: string;
  }

  /** A running parent with every child adopted and the run open; references optional. */
  async function scenario(options: { references: boolean }): Promise<Scenario> {
    const ws = uid("ws");
    const conns: Record<string, ProviderConnection> = {};
    for (const env of ENVIRONMENTS) conns[env] = connection(PROVIDER_OF[env], { workspaceId: ws });
    const graphFor = (env: string) => { const graph = mixedGraph(); graph.nodes = graph.nodes.filter((node) => node.provider === PROVIDER_OF[env]); refresh(graph); return graph; };
    const base: MixedWorld = {
      parentGraph: async () => ({ projectId: PROJECT, graph: mixedGraph() }),
      childEnvironment: async (_ws, env) => ({ projectId: PROJECT, connection: conns[env] }),
      childGraph: async (_ws, env) => graphFor(env),
      childStartInput: async (workspaceId, op) => ({ operationId: op.id, workspaceId, projectId: op.projectId, environmentId: op.environmentId, revisionId: `rev-${op.environmentId}`, deploymentId: `dep-${op.id}`, connectionId: "product-connection", preApproved: true, build: false }),
      connections: async (_ws, ids) => new Map(ids.map((id) => [id, Object.values(conns).find((c) => c.id === id) ?? null])),
    };
    // The production hooks over the real store: the producer output reader and the signal reads under test.
    const world: MixedWorld = { ...base, ...productionWorldHooks(db()), orderingSignals: platformOrderingSignals(db()) };
    const store = { get: async (workspaceId: string, operationId: string, planDigest: string) => ({ workspaceId, operationId, planDigest, semantics: { digest: SEMANTICS }, createdAt: new Date().toISOString() }), record: async () => { throw new Error("fake store is read-only"); } } as unknown as SemanticsStore;
    const deps: MixedDeps = { sql: db(), world, semantics: store, referencesReady: async () => typeof world.childTypedOutputs === "function" };
    const planned = await planMixed(deps, { workspaceId: ws, parentEnvironmentId: PARENT_ENV, childEnvironmentIds: [...ENVIRONMENTS], createdBy: "user-planner", ...(options.references ? { references: [REFERENCE] } : {}) });
    const plan = planned.stored.plan;
    const seeded = await seedAwaitingApproval(db(), { workspaceId: ws, proposal: { capability: "deployment.deploy", scope: { workspaceId: ws, projectId: PROJECT, environmentId: PARENT_ENV }, input: parentProposalInput(plan) } });
    await plans.attachParentOperation(db(), { workspaceId: ws, planId: plan.parentPlanId, operationId: seeded.operation.id });
    await approve(db(), seeded);
    const childOperations: Record<string, string> = {};
    for (const child of plan.children) {
      const op = await seedApprovedOperation(db(), ws, { proposal: { capability: "deployment.deploy", scope: { workspaceId: ws, projectId: PROJECT, environmentId: child.childEnvironmentId }, input: { revisionId: `rev-${child.childEnvironmentId}`, deploymentId: `dep-${child.childEnvironmentId}` } } });
      childOperations[child.partitionId] = op.operation.id;
      await adoptChildOperation(deps, { workspaceId: ws, planId: plan.parentPlanId, partitionId: child.partitionId, operationId: op.operation.id });
    }
    await db().query("update platform.operations set status = 'running', lease_holder = 'workflow:parent', lease_until = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp() where workspace_id = $1 and id = $2", [ws, seeded.operation.id]);
    await beginParent(deps, { workspaceId: ws, planId: plan.parentPlanId });
    const run: MixedRunDeps = { runs: new MemoryMixedRunStore(), preauthorizations: new MemoryPreauthorizationStore(), roles: {} as MixedRunDeps["roles"], teardownApprovals: { lookup: async () => null }, parentReview: refusingParentReviewPort, now: () => new Date() };
    const reviews: Scenario["reviews"] = [];
    // Labelled fake: the production opener proposes through the capability broker.
    const join: JoinDeps = { sql: db(), world, run, reviews: { open: async (input) => { reviews.push(input as never); return { operationId: "op-review-fake" }; } } };
    await openRunForParent(join, { workspaceId: ws, parentOperationId: seeded.operation.id, plan });
    const producer = plan.children.find((child) => child.nodes.some((node) => node.address === DB))!.partitionId;
    const consumer = plan.children.find((child) => child.nodes.some((node) => node.address === WEB))!.partitionId;
    return { ws, plan, deps, join, launcher: new FakeLauncher(db()), reviews, parentOperationId: seeded.operation.id, childOperations, producer, consumer };
  }

  const scope = (s: Scenario, partitionId: string) => ({ workspaceId: s.ws, parentOperationId: s.parentOperationId, plan: s.plan, partitionId });

  /** Claim and start the producer through the join's launcher (records the run's `start`). */
  async function startProducer(s: Scenario): Promise<void> {
    const result = await advanceChild(s.deps, joinedLauncher(s.join, s.launcher, { workspaceId: s.ws, parentOperationId: s.parentOperationId, plan: s.plan }), { workspaceId: s.ws, operationId: s.parentOperationId, planId: s.plan.parentPlanId, partitionId: s.producer });
    expect(result.state).toBe("started");
  }

  /** The producing child's own post-apply observation, written the way its observe step writes it. */
  async function seedObservation(s: Scenario, over: { value?: string; simulated?: boolean; presence?: "present" | "missing"; error?: string; at?: string } = {}): Promise<void> {
    const node = mixedGraph().nodes.find((candidate) => candidate.address === DB)!;
    const row = await repos.resources.upsertDesired(db(), { workspaceId: s.ws, projectId: PROJECT, environmentId: "env-azure", node, status: "active" });
    const at = over.at ?? (await clock());
    await repos.observations.appendObservation(db(), {
      workspaceId: s.ws, resourceId: row.id,
      observation: {
        address: DB, externalId: "azure-db-1", presence: over.presence ?? "present", observedAt: at, source: "azure.postgres@1", simulated: over.simulated ?? false, ...(over.error ? { error: over.error } : {}),
        attributes: { endpoint: { state: "known", value: over.value ?? HOST_VALUE, observedAt: at } },
      },
    });
  }

  async function finishProducer(s: Scenario): Promise<void> {
    await db().query("update platform.operations set status = 'succeeded', plan_digest = $3, finished_at = clock_timestamp(), lease_holder = null, lease_until = null where workspace_id = $1 and id = $2",
      [s.ws, s.childOperations[s.producer], "a".repeat(64)]);
    const observed = await observeChild(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: s.producer });
    expect(observed.state).toBe("succeeded");
    await syncChildOutcome(s.join, { ...scope(s, s.producer), state: "succeeded", receipt: observed.receipt! });
  }

  describe("the producer output reader through materializeIncoming", () => {
    it("blocks the consumer with a fixed reason when nothing was read back through the producer's session", async () => {
      const s = await scenario({ references: true });
      await startProducer(s);
      await finishProducer(s);
      expect(await materializeIncoming(s.join, scope(s, s.consumer))).toEqual({ state: "blocked", reason: "outputs_unavailable" });
      expect(await outputRecords.listOutputs(db(), s.ws, s.plan.parentPlanId)).toEqual([]);
      expect(s.reviews).toEqual([]);
    });

    it("blocks when the only observation was taken after the producer's receipt (a later reconcile is not the apply's read-back)", async () => {
      const s = await scenario({ references: true });
      await startProducer(s);
      await finishProducer(s);
      await seedObservation(s);
      expect(await materializeIncoming(s.join, scope(s, s.consumer))).toEqual({ state: "blocked", reason: "outputs_unavailable" });
    });

    it("records the read-back with provenance and, because the parent digest changes, opens the review of exactly that digest instead of starting", async () => {
      const s = await scenario({ references: true });
      await startProducer(s);
      await seedObservation(s);
      await finishProducer(s);
      const result = await materializeIncoming(s.join, scope(s, s.consumer));
      expect(result).toEqual({ state: "waiting", reviewOperationId: "op-review-fake" });
      expect(s.reviews).toHaveLength(1);
      const review = s.reviews[0].review;
      expect(review.requiredParentDigest).not.toBe(s.plan.parentDigest);
      expect(review.childSetDigest).toBe(s.plan.childSetDigest);
      expect(review.consumers.map((consumer) => consumer.childId)).toEqual([s.consumer]);
      const [row, ...rest] = await outputRecords.listOutputs(db(), s.ws, s.plan.parentPlanId);
      expect(rest).toEqual([]);
      const receipt = (await plans.getReceipt(db(), s.ws, s.plan.parentPlanId, s.producer))!;
      expect(row).toMatchObject({
        referenceId: "db-host", receiptDigest: receipt.receiptDigest, producerPartitionId: s.producer, consumerPartitionId: s.consumer, producerOperationId: s.childOperations[s.producer],
        producerAddress: DB, producerOutput: "endpoint", valueType: "endpoint", source: "observation",
      });
      expect(row.valueDigest).toMatch(/^[a-f0-9]{64}$/);
      // The table has no place for a value: scan the whole row as stored.
      const raw = JSON.stringify((await db().query("select * from platform.mixed_output_records where workspace_id = $1", [s.ws])));
      expect(raw).not.toContain(HOST_VALUE);
      // The consumer was NOT rebound or started: the run still shows it pending with the reference unmaterialized.
      const state = (await readMixedRun(s.join.run, s.ws, s.parentOperationId))!.state;
      expect(state.children[s.consumer].status).toBe("pending");
      expect(state.children[s.consumer].incoming.every((entry) => entry.materialized)).toBe(false);
    });

    it("ignores observations that are not real reads of the producer (simulated, missing, errored)", async () => {
      const s = await scenario({ references: true });
      await startProducer(s);
      await seedObservation(s, { value: "sim.example", simulated: true });
      await seedObservation(s, { value: "gone.example", presence: "missing" });
      await seedObservation(s, { value: "err.example", error: "AccessDenied" });
      await finishProducer(s);
      expect(await materializeIncoming(s.join, scope(s, s.consumer))).toEqual({ state: "blocked", reason: "outputs_unavailable" });
    });

    it("uses the newest real observation inside the window", async () => {
      const s = await scenario({ references: true });
      await startProducer(s);
      await seedObservation(s, { value: "first.example" });
      await seedObservation(s, { value: HOST_VALUE });
      await finishProducer(s);
      const window = await outputRecords.readProducerObservation(db(), { workspaceId: s.ws, environmentId: "env-azure", operationId: s.childOperations[s.producer], address: DB, notAfter: (await clock()) });
      expect(window?.attributes.endpoint).toMatchObject({ state: "known", value: HOST_VALUE });
      // Another workspace's read of the same environment and operation finds nothing.
      expect(await outputRecords.readProducerObservation(db(), { workspaceId: uid("ws"), environmentId: "env-azure", operationId: s.childOperations[s.producer], address: DB, notAfter: (await clock()) })).toBeNull();
    });
  });

  describe("the output record table", () => {
    const input = (s: Scenario, over: Partial<Omit<outputRecords.MixedOutputRecord, "recordedAt">> = {}): Omit<outputRecords.MixedOutputRecord, "recordedAt"> => ({
      workspaceId: s.ws, planId: s.plan.parentPlanId, referenceId: "db-host", receiptDigest: "c".repeat(64), producerPartitionId: s.producer, consumerPartitionId: s.consumer,
      producerOperationId: s.childOperations[s.producer], producerAddress: DB, producerOutput: "endpoint", valueType: "endpoint", valueDigest: "d".repeat(64), source: "observation",
      sourceDigest: "e".repeat(64), observedAt: new Date().toISOString(), ...over,
    });

    it("is idempotent for the same value, a conflict for a different one, append-only and tenant scoped", async () => {
      const s = await scenario({ references: true });
      const first = await outputRecords.recordOutput(db(), input(s));
      expect(first.created).toBe(true);
      expect((await outputRecords.recordOutput(db(), input(s))).created).toBe(false);
      await expect(outputRecords.recordOutput(db(), input(s, { valueDigest: "f".repeat(64) }))).rejects.toMatchObject({ code: "conflict" });
      await expect(db().query("update platform.mixed_output_records set value_digest = $2 where workspace_id = $1", [s.ws, "f".repeat(64)])).rejects.toThrow(/append-only/);
      await expect(db().query("delete from platform.mixed_output_records where workspace_id = $1", [s.ws])).rejects.toThrow(/append-only/);
      // a foreign workspace cannot see it, and cannot write against this plan
      expect(await outputRecords.getOutput(db(), uid("ws"), s.plan.parentPlanId, "db-host", "c".repeat(64))).toBeNull();
      await expect(outputRecords.recordOutput(db(), input(s, { workspaceId: uid("ws") }))).rejects.toMatchObject({ code: "not_found" });
      expect(await outputRecords.listOutputs(db(), uid("ws"), s.plan.parentPlanId)).toEqual([]);
    });

    it("keeps the secret shape in the database: a secret type needs a vault reference and version digest, other types may not carry one", async () => {
      const s = await scenario({ references: true });
      await expect(outputRecords.recordOutput(db(), input(s, { valueType: "secret_ref" }))).rejects.toMatchObject({ code: "invalid_input" });
      await expect(outputRecords.recordOutput(db(), input(s, { secretRef: "vault:p/s/k", secretVersionDigest: "a".repeat(64) }))).rejects.toMatchObject({ code: "invalid_input" });
      await expect(outputRecords.recordOutput(db(), input(s, { valueType: "secret_ref", secretRef: "not-a-vault-ref", secretVersionDigest: "a".repeat(64) }))).rejects.toMatchObject({ code: "invalid_input" });
      const ok = await outputRecords.recordOutput(db(), input(s, { referenceId: "db-secret", valueType: "secret_ref", secretRef: "vault:p/s/k", secretVersionDigest: "a".repeat(64) }));
      expect(ok.record).toMatchObject({ secretRef: "vault:p/s/k", secretVersionDigest: "a".repeat(64) });
      // the platform store adapter is what the production reader uses
      const store = platformOutputRecordStore(db());
      expect(await store.get(s.ws, s.plan.parentPlanId, "db-secret", "c".repeat(64))).toMatchObject({ valueType: "secret_ref" });
    });
  });

  describe("drift and migration signals", () => {
    const driftReport = (computedAt: string, findings: object[] = [{ address: DB, class: "changed", severity: "high", repairable: true, autoRepairEligible: false, explanation: "differs" }]) => ({
      environmentId: "env-azure", graphDigest: "a".repeat(64), computedAt, findings: findings as never, unobserved: [] as string[], simulated: false,
    });
    const releaseRun = (s: Scenario, klass: "none" | "expand" | "data" | "contract" | "unclassified", over: { state?: "planned" | "refused" | "rolled_back"; partition?: string; environment?: string } = {}) =>
      createPlatformReleaseStore(db()).insertRun({
        id: uid("rel"), workspaceId: s.ws, environmentId: over.environment ?? "env-azure", operationId: s.childOperations[over.partition ?? s.producer], requestedBy: "alice", serviceAddress: `container_service/${uid("svc")}`, kind: "deploy", state: "planned",
        imageUri: `registry.example.test/web@${dg("3")}`, imageDigest: dg("3"), provenance: { level: "none" }, migration: { class: klass, status: klass === "none" ? "none" : "pending_approval", findings: [] },
        rollout: { strategy: "rolling", steps: [100], bakeSec: 0, percent: 0 },
      } as never);

    it("reads unresolved drift newer than the child operation, and ignores a report from before it", async () => {
      const s = await scenario({ references: false });
      const children = s.plan.children.map((child) => ({ partitionId: child.partitionId, childEnvironmentId: child.childEnvironmentId, childOperationId: s.childOperations[child.partitionId] }));
      expect((await readOrderingSignals(db(), s.ws, children)).drift).toEqual([]);
      // before the child operation was created: says nothing about this child
      await repos.drift.insert(db(), { workspaceId: s.ws, report: driftReport("2020-01-01T00:00:00.000Z") });
      expect((await readOrderingSignals(db(), s.ws, children)).drift).toEqual([]);
      // without an operation to bound it, the newest report counts
      expect((await readOrderingSignals(db(), s.ws, children.map(({ childOperationId: _op, ...rest }) => rest))).drift).toEqual([{ childId: s.producer, klass: "unauthorized_change" }]);
      await repos.drift.insert(db(), { workspaceId: s.ws, report: driftReport(await clock()) });
      expect((await readOrderingSignals(db(), s.ws, children)).drift).toEqual([{ childId: s.producer, klass: "unauthorized_change" }]);
      // another workspace sees none of it
      expect((await readOrderingSignals(db(), uid("ws"), children)).drift).toEqual([]);
    });

    it("reads data, contract and unclassified migrations of the child operation, and calls contract and unclassified the ones that go after dependents", async () => {
      const s = await scenario({ references: false });
      const children = s.plan.children.map((child) => ({ partitionId: child.partitionId, childEnvironmentId: child.childEnvironmentId, childOperationId: s.childOperations[child.partitionId] }));
      await releaseRun(s, "none");
      await releaseRun(s, "expand", { partition: s.consumer, environment: "env-gcp" });
      expect(await readOrderingSignals(db(), s.ws, children)).toMatchObject({ migrationChildIds: [], contractMigrationChildIds: [] });
      await releaseRun(s, "data", { partition: s.consumer, environment: "env-gcp" });
      expect(await readOrderingSignals(db(), s.ws, children)).toMatchObject({ migrationChildIds: [s.consumer], contractMigrationChildIds: [] });
      const third = s.plan.children.find((child) => child.partitionId !== s.producer && child.partitionId !== s.consumer)!;
      await releaseRun(s, "contract", { partition: third.partitionId, environment: third.childEnvironmentId });
      const signals = await readOrderingSignals(db(), s.ws, children);
      expect(signals.migrationChildIds).toEqual([s.consumer, third.partitionId].sort());
      expect(signals.contractMigrationChildIds).toEqual([third.partitionId]);
      expect((await readOrderingSignals(db(), uid("ws"), children)).migrationChildIds).toEqual([]);
    });

    it("resolves a stored run's children and operations for the teardown route", async () => {
      const s = await scenario({ references: false });
      await repos.drift.insert(db(), { workspaceId: s.ws, report: driftReport(await clock(), [{ address: DB, class: "missing", severity: "high", repairable: true, autoRepairEligible: false, explanation: "gone" }]) });
      const signals = await readRunSignals(db(), s.ws, s.plan.parentPlanId, s.plan);
      expect(signals.drift).toEqual([{ childId: s.producer, klass: "unauthorized_change" }]);
    });

    it("refuses to start a consumer while its producer has unresolved drift, and starts it once the drift report is clean", async () => {
      const s = await scenario({ references: false });
      await startProducer(s);
      await finishProducer(s);
      await repos.drift.insert(db(), { workspaceId: s.ws, report: driftReport(await clock()) });
      let failure: unknown;
      try { await recordChildStart(s.join, scope(s, s.consumer)); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(MixedOrchestrationError);
      expect((failure as MixedOrchestrationError).code).toBe("ordering_blocked");
      expect((failure as MixedOrchestrationError).detail).toContain(`producer_drift_unresolved:${s.producer}`);
      expect((await readMixedRun(s.join.run, s.ws, s.parentOperationId))!.state.children[s.consumer].status).toBe("pending");
      // A clean (newer) report clears it: nothing else changed.
      await repos.drift.insert(db(), { workspaceId: s.ws, report: driftReport(await clock(), []) });
      await recordChildStart(s.join, scope(s, s.consumer));
      expect((await readMixedRun(s.join.run, s.ws, s.parentOperationId))!.state.children[s.consumer].status).toBe("running");
    });
  });
});
