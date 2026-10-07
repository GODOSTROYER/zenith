/**
 * PROD-MIX-03/04 on the real SQL store (migration 44): mixed run state is tenant scoped, versioned by
 * compare-and-set and written together with an append-only ledger; run identity is immutable; overdue runs are
 * found and ticked by the housekeeping sweep; output preauthorizations are bounded in SQL as well as in code,
 * immutable apart from their use count and one-way revocation, and their use count can never be exceeded
 * (also under concurrency). PGlite always; real PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_MIGRATIONS } from "@/lib/controlplane/db";
import { bindRepos } from "@/lib/controlplane/db/repos";
import { MixedOrchestrationError } from "@/lib/execution/mixed-orchestration/errors";
import { platformPreauthorizationStore } from "@/lib/execution/mixed-orchestration/platform";
import { createRunState, summarizeRun, type MixedRunState } from "@/lib/execution/mixed-orchestration/run";
import { platformMixedRunStore } from "@/lib/execution/mixed-orchestration/run-store";
import { sweepMixedRunDeadlines } from "@/lib/execution/mixed-orchestration/sweep";
import { housekeepingPass } from "@/lib/platform/housekeeping";
import { H, PARENT, world } from "../execution/fakes/mixed-fixture";
import { LANES, openLane, seedApprovedOperation, uid } from "./_support/harness";

describe("migration inventory", () => {
  it("44 creates the run, ledger and preauthorization tables with row level security and no anon access", () => {
    const migration = PLATFORM_MIGRATIONS.find((item) => item.name === "mixed_runs");
    expect(migration?.version).toBe(44);
    for (const table of ["mixed_runs", "mixed_run_events", "mixed_output_preauthorizations"]) {
      expect(migration!.sql).toContain(`platform.${table}`);
      expect(migration!.sql).toContain(`alter table platform.${table} enable row level security`);
    }
    expect(migration!.sql).toContain("Mixed run events are append-only");
    expect(migration!.sql).toContain("Output preauthorization bounds are immutable");
  });
});

describe.each(LANES)("mixed runs and output preauthorizations [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  let repos: ReturnType<typeof bindRepos>;
  beforeAll(async () => {
    ctx = await openLane(lane);
    repos = bindRepos(ctx.db);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });

  /** A run state for a seeded parent operation of a fresh workspace. */
  async function seededRun(over: { overdue?: boolean } = {}): Promise<{ ws: string; parent: string; state: MixedRunState }> {
    const { workspaceId, operation } = await seedApprovedOperation(ctx.db);
    const w = world();
    const past = Date.now() - 3_600_000;
    const state = over.overdue
      ? createRunState(w.view, { parentOperationId: PARENT, expiresAt: new Date(Date.now() - 60_000).toISOString(), childTimeoutMs: 600_000, now: new Date(past) })
      : w.state;
    // Relative to the real clock: the fixed fixture date would eventually make every run overdue.
    const expiresAt = over.overdue ? state.expiresAt : new Date(Date.now() + 86_400_000).toISOString();
    const scoped: MixedRunState = { ...structuredClone(state), workspaceId, parentOperationId: operation.id, expiresAt };
    return { ws: workspaceId, parent: operation.id, state: scoped };
  }

  it("creates one run per parent operation, reads it back and hides it from other workspaces", async () => {
    const { ws, parent, state } = await seededRun();
    const store = platformMixedRunStore(ctx.db);
    const created = await store.create(state, { kind: "run_created", data: { parentDigest: state.parentDigest } });
    expect(created.version).toBe(1);
    expect(created.state).toEqual(state);
    expect((await store.get(ws, parent))?.state).toEqual(state);
    expect(await store.get(`ws_${uid("other")}`, parent)).toBeNull();
    await expect(store.create(state, { kind: "run_created", data: {} })).rejects.toMatchObject({ code: "conflict" });
    expect(await store.events(`ws_${uid("other")}`, parent)).toEqual([]);
  });

  it("saves by compare-and-set and writes an ordered, append-only ledger with each state", async () => {
    const { ws, parent, state } = await seededRun();
    const store = platformMixedRunStore(ctx.db);
    const w = world();
    await store.create(state, { kind: "run_created", data: {} });
    const first = { ...structuredClone(state), seq: state.seq + 1 };
    const saved = await store.save(ws, parent, 1, first, { kind: "tick", data: { at: "t1" } });
    expect(saved.version).toBe(2);
    await expect(store.save(ws, parent, 1, { ...structuredClone(state), seq: state.seq + 2 }, { kind: "tick", data: {} })).rejects.toBeInstanceOf(MixedOrchestrationError);
    await expect(store.save(ws, parent, 1, { ...structuredClone(state), seq: state.seq + 2 }, { kind: "tick", data: {} })).rejects.toMatchObject({ code: "conflict" });
    await store.save(ws, parent, 2, { ...structuredClone(first), seq: first.seq + 1 }, { kind: "cancel", data: {} });
    const events = await store.events(ws, parent);
    expect(events.map((event) => [event.seq, event.kind])).toEqual([[0, "run_created"], [1, "tick"], [2, "cancel"]]);
    expect((await store.get(ws, parent))?.version).toBe(3);
    // A save naming the wrong parent or workspace cannot move another run.
    await expect(store.save(`ws_${uid("other")}`, parent, 3, first, { kind: "tick", data: {} })).rejects.toMatchObject({ code: "invalid_input" });
    expect(summarizeRun((await store.get(ws, parent))!.state).atomicity).toBe("none");
    expect(w.ids.db).toBeTruthy();
  });

  it("refuses to rewrite the ledger, delete a run, change its identity or skip a version", async () => {
    const { ws, parent, state } = await seededRun();
    const store = platformMixedRunStore(ctx.db);
    await store.create(state, { kind: "run_created", data: {} });
    await expect(ctx.db.query("update platform.mixed_run_events set kind = 'tick' where workspace_id = $1", [ws])).rejects.toThrow();
    await expect(ctx.db.query("delete from platform.mixed_run_events where workspace_id = $1", [ws])).rejects.toThrow();
    await expect(ctx.db.query("delete from platform.mixed_runs where workspace_id = $1", [ws])).rejects.toThrow();
    await expect(ctx.db.query("update platform.mixed_runs set environment_id = 'env-other', version = version + 1 where workspace_id = $1", [ws])).rejects.toThrow();
    await expect(ctx.db.query("update platform.mixed_runs set version = version + 2 where workspace_id = $1", [ws])).rejects.toThrow();
    expect((await store.get(ws, parent))?.version).toBe(1);
  });

  it("refuses a state that does not belong to the row it is stored in", async () => {
    const { ws, parent, state } = await seededRun();
    const { workspaceId: otherWs } = await seedApprovedOperation(ctx.db);
    const mismatched = { ...structuredClone(state), workspaceId: otherWs };
    await expect(repos.mixedRuns.create({ workspaceId: ws, parentOperationId: parent, environmentId: state.environmentId, parentDigest: state.parentDigest, desiredDigest: state.desiredDigest,
      state: mismatched, stateDigest: H("x"), open: true, nextDeadlineAt: null, event: { seq: 0, kind: "run_created", data: {} } })).rejects.toThrow();
    expect(await repos.mixedRuns.get(ws, parent)).toBeNull();
    // A parent operation that does not exist cannot own a run.
    await expect(repos.mixedRuns.create({ workspaceId: ws, parentOperationId: "op_missing", environmentId: state.environmentId, parentDigest: state.parentDigest, desiredDigest: state.desiredDigest,
      state: { ...structuredClone(state), parentOperationId: "op_missing" }, stateDigest: H("x"), open: true, nextDeadlineAt: null, event: { seq: 0, kind: "run_created", data: {} } })).rejects.toThrow();
  });

  it("finds overdue runs and the sweep ticks them without touching other tenants' runs that are not due", async () => {
    const due = await seededRun({ overdue: true });
    const fresh = await seededRun();
    const store = platformMixedRunStore(ctx.db);
    await store.create(due.state, { kind: "run_created", data: {} });
    await store.create(fresh.state, { kind: "run_created", data: {} });
    const keys = await repos.mixedRuns.listDue(new Date(), 500);
    expect(keys).toContainEqual({ workspaceId: due.ws, parentOperationId: due.parent });
    expect(keys).not.toContainEqual({ workspaceId: fresh.ws, parentOperationId: fresh.parent });
    const result = await sweepMixedRunDeadlines(ctx.db, { limit: 500 });
    expect(result.swept).toBeGreaterThanOrEqual(1);
    const ticked = (await store.get(due.ws, due.parent))!;
    expect(Object.values(ticked.state.children).every((child) => child.status === "expired")).toBe(true);
    expect(summarizeRun(ticked.state)).toMatchObject({ expired: true, outcome: "nothing_applied", atomicity: "none" });
    expect((await repos.mixedRuns.listDue(new Date(), 500))).not.toContainEqual({ workspaceId: due.ws, parentOperationId: due.parent });
    expect((await store.get(fresh.ws, fresh.parent))?.version).toBe(1);
  });

  it("the housekeeping pass advances overdue mixed runs (timeout and expiry reach a run with no executor)", async () => {
    const due = await seededRun({ overdue: true });
    const store = platformMixedRunStore(ctx.db);
    await store.create(due.state, { kind: "run_created", data: {} });
    let ran = false;
    for (let attempt = 0; attempt < 10 && !ran; attempt++) {
      ran = (await housekeepingPass(ctx.db, { limit: 500 })).ran;
      if (!ran) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(ran).toBe(true);
    const after = (await store.get(due.ws, due.parent))!;
    expect(Object.values(after.state.children).every((child) => child.status === "expired")).toBe(true);
    expect((await store.events(due.ws, due.parent)).map((event) => event.kind)).toEqual(["run_created", "tick"]);
  });

  describe("output preauthorizations", () => {
    async function row(over: Record<string, unknown> = {}) {
      const { workspaceId, operation } = await seedApprovedOperation(ctx.db);
      const now = new Date();
      return {
        workspaceId, parent: operation.id,
        input: {
          id: uid("mop"), workspaceId, environmentId: "env-mix", parentOperationId: operation.id, createdBy: "alice", createdByName: "Alice", desiredDigest: H("desired"), referenceId: "db-host",
          contractDigest: H("contract"), consumerSubplanDigest: H("consumer"), producerSubplanDigest: H("producer"), valueType: "endpoint" as const, maxUses: 3,
          expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), createdAt: now.toISOString(), ...over,
        },
      };
    }

    it("stores a precise grant, hides it from other workspaces and lists active ones", async () => {
      const { workspaceId, parent, input } = await row();
      const created = await repos.mixedOutputPreauthorizations.create(input);
      expect(created).toMatchObject({ id: input.id, uses: 0, status: "active", maxUses: 3, parentOperationId: parent, referenceId: "db-host" });
      expect(await repos.mixedOutputPreauthorizations.get(`ws_${uid("other")}`, input.id)).toBeNull();
      expect((await repos.mixedOutputPreauthorizations.list(workspaceId, { parentOperationId: parent, activeOnly: true })).map((item) => item.id)).toEqual([input.id]);
      expect(await repos.mixedOutputPreauthorizations.list(workspaceId, { parentOperationId: "op_other" })).toEqual([]);
    });

    const bounds: [string, Record<string, unknown>][] = [
      ["more than ten uses", { maxUses: 11 }],
      ["no uses", { maxUses: 0 }],
      ["a secret type without a vault reference", { valueType: "secret_ref" }],
      ["a vault reference on a non-secret type", { secretRef: "vault:project/service/password" }],
      ["a reference that is not a vault reference", { valueType: "secret_ref", secretRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:x" }],
      ["an unknown value type", { valueType: "wildcard" }],
      ["a malformed digest", { contractDigest: "not-a-digest" }],
      ["a lifetime over seven days", { expiresAt: new Date(Date.now() + 8 * 24 * 3_600_000).toISOString() }],
      ["an expiry before creation", { expiresAt: new Date(Date.now() - 3_600_000).toISOString() }],
    ];
    it.each(bounds)("refuses %s in SQL", async (_label, over) => {
      const { input } = await row(over);
      await expect(repos.mixedOutputPreauthorizations.create(input as never)).rejects.toThrow();
    });

    it("refuses a parent operation that does not exist", async () => {
      const { input } = await row({ parentOperationId: "op_missing" });
      await expect(repos.mixedOutputPreauthorizations.create(input)).rejects.toThrow();
    });

    it("accepts a secret grant with an exact vault reference and an optional value pin", async () => {
      const { input } = await row({ valueType: "secret_ref", secretRef: "vault:project/service/password", valueDigest: H("pinned") });
      expect(await repos.mixedOutputPreauthorizations.create(input)).toMatchObject({ valueType: "secret_ref", secretRef: "vault:project/service/password", valueDigest: H("pinned") });
    });

    it("never lets uses exceed the bound, even under concurrent reservation", async () => {
      const { workspaceId, input } = await row({ maxUses: 3 });
      await repos.mixedOutputPreauthorizations.create(input);
      const other = bindRepos(ctx.db2).mixedOutputPreauthorizations;
      const attempts = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? other : repos.mixedOutputPreauthorizations).reserveUse({ workspaceId, id: input.id, now: new Date() })));
      expect(attempts.filter((item) => item !== null)).toHaveLength(3);
      expect((await repos.mixedOutputPreauthorizations.get(workspaceId, input.id))?.uses).toBe(3);
      expect(await repos.mixedOutputPreauthorizations.reserveUse({ workspaceId, id: input.id, now: new Date() })).toBeNull();
    });

    it("reserves nothing after expiry, revocation or from another workspace; revocation is one way", async () => {
      const { workspaceId, input } = await row();
      await repos.mixedOutputPreauthorizations.create(input);
      const store = platformPreauthorizationStore(ctx.db);
      expect(await store.reserveUse({ workspaceId: `ws_${uid("other")}`, id: input.id, now: new Date() })).toBeNull();
      expect(await store.reserveUse({ workspaceId, id: input.id, now: new Date(Date.parse(input.expiresAt) + 1) })).toBeNull();
      const revoked = await store.revoke({ workspaceId, id: input.id, revokedBy: "alice", reason: "done", at: new Date() });
      expect(revoked).toMatchObject({ status: "revoked", revokedBy: "alice", revokedReason: "done" });
      expect(await store.reserveUse({ workspaceId, id: input.id, now: new Date() })).toBeNull();
      await expect(ctx.db.query("update platform.mixed_output_preauthorizations set status = 'active', revoked_at = null where id = $1", [input.id])).rejects.toThrow();
      expect(await store.revoke({ workspaceId: `ws_${uid("other")}`, id: input.id, revokedBy: "mallory", at: new Date() })).toBeNull();
    });

    it("keeps every bound immutable and the use count monotonic", async () => {
      const { workspaceId, input } = await row();
      await repos.mixedOutputPreauthorizations.create(input);
      await repos.mixedOutputPreauthorizations.reserveUse({ workspaceId, id: input.id, now: new Date() });
      for (const statement of [
        "update platform.mixed_output_preauthorizations set desired_digest = $2 where id = $1",
        "update platform.mixed_output_preauthorizations set max_uses = 10 where id = $1",
        "update platform.mixed_output_preauthorizations set reference_id = 'other' where id = $1",
        "update platform.mixed_output_preauthorizations set expires_at = expires_at + interval '1 hour' where id = $1",
        "update platform.mixed_output_preauthorizations set uses = uses - 1 where id = $1",
        "delete from platform.mixed_output_preauthorizations where id = $1",
      ]) {
        await expect(ctx.db.query(statement, statement.includes("$2") ? [input.id, H("widened")] : [input.id])).rejects.toThrow();
      }
      expect((await repos.mixedOutputPreauthorizations.get(workspaceId, input.id))).toMatchObject({ uses: 1, maxUses: 3, desiredDigest: H("desired") });
    });
  });
});
