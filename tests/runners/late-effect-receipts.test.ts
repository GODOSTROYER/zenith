/** Signed protocol + actual SQL receipts. SDK/provider quiescence is not asserted. */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openPlatformDb, repos, type PlatformDbHandle } from "@/lib/controlplane/db";
import { assertPlatformSchemaCurrent } from "@/lib/controlplane/db/migrator";
import { digest, sha256Hex } from "@/lib/controlplane/digest";
import type { Sql } from "@/lib/controlplane/types";
import { createPlatformRunnerStore } from "@/lib/runners/db/pg-store";
import { createMemoryRunnerStore } from "@/lib/runners/memory-store";
import { queueOf, registryOf, type RunnerStore, type SettleOutcomeInput } from "@/lib/runners/ports";
import { assertPathAgent, authenticateAgentRequest, parseJsonBody } from "@/lib/runners/request-auth";
import { resultHandler, registerHandler } from "@/lib/runners/http";
import { createAesResultSealer } from "@/lib/runners/seal";
import { effectReceiptAad, sealAad, settleResult } from "@/lib/runners/service";
import { signEnvelope } from "@/lib/runners/signing";
import { AGENT_KINDS, MAX_RESULT_BODY_BYTES, type AgentKind } from "@/lib/runners/types";
import { log } from "@/lib/log";
import { createPlane, registerFakeAgent, teardownPlane, type FakeAgent } from "./_support";

const PG_URL = process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim();
const LANES = [{ name: "memory" as const }, { name: "pglite" as const }, ...(PG_URL ? [{ name: "postgres" as const }] : [])];
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const body = { status: "succeeded", result: { providerResult: "inert-private-outcome" }, finishedAt: "2026-10-03T00:00:00Z" };

describe.each(LANES)("agent effect receipts [$name]", lane => {
  let db: PlatformDbHandle | undefined, db2: PlatformDbHandle | undefined, observer: PlatformDbHandle | undefined;
  let store: RunnerStore, store2: RunnerStore;
  let memoryTime = Date.now();
  beforeAll(async () => {
    if (lane.name === "memory") { store = createMemoryRunnerStore({ now: () => memoryTime }); store2 = store; }
    else {
      db = await openPlatformDb({ kind: lane.name, url: lane.name === "postgres" ? PG_URL : undefined, migrate: true, max: 4 });
      // Exercise the canonical registry and checksums, never direct source DDL.
      await assertPlatformSchemaCurrent(db);
      expect((await db.query<{ version: number }>("select version from platform.schema_migrations where version=11"))[0]?.version).toBe(11);
      db2 = lane.name === "postgres" ? await openPlatformDb({ kind: "postgres", url: PG_URL, migrate: true, max: 4 }) : db;
      store = createPlatformRunnerStore(db); store2 = createPlatformRunnerStore(db2);
      if (lane.name === "postgres") observer = await openPlatformDb({ kind: "postgres", url: PG_URL, migrate: false, max: 1 });
    }
  }, 60_000);
  afterAll(async () => { await observer?.close(); if (db2 && db2 !== db) await db2.close(); await db?.close(); });
  afterEach(() => { teardownPlane(); vi.restoreAllMocks(); });

  async function passTime() {
    if (lane.name === "memory") memoryTime += 1200;
    else await new Promise(resolve => setTimeout(resolve, 1200));
  }
  async function fixture(kind: AgentKind, phase: "queued" | "claimed" | "running" = "running") {
    const plane = await createPlane("real", { now: lane.name === "memory" ? () => memoryTime : Date.now }, store);
    const workspaceId = id("ws"), operationId = id("op");
    if (db) {
      await repos.operations.create(db, { id: operationId, workspaceId, principal: { kind: "user", id: "fixture-admin", name: "Fixture" },
        proposal: { capability: "infrastructure.observe", scope: { workspaceId }, input: {}, summary: "Receipt fixture", details: [], risk: "low" } });
      await db.query("update platform.operations set status='uncertain',finished_at=clock_timestamp() where workspace_id=$1 and id=$2", [workspaceId, operationId]);
    }
    const agent = await registerFakeAgent(plane, registerHandler(kind), { kind, workspaceId });
    const jobId = id(kind === "runner" ? "job" : "mreq"), queue = queueOf(store, kind);
    const envelope = await signEnvelope(plane.signer, AGENT_KINDS[kind].jobTyp, { jti: jobId, ws: workspaceId, aud: `${kind}:${agent.id}`, op: operationId, timeoutSec: 1 });
    await queue.enqueue({ id: jobId, workspaceId, agentId: agent.id, operationId, kind: kind === "runner" ? "aws.http" : "service.status", capability: "infrastructure.observe", envelope, ttlMs: 1000 });
    if (phase !== "queued") {
      expect((await queue.claimNext({ workspaceId, agentId: agent.id, leaseMs: 1000 })).map(j => j.id)).toEqual([jobId]);
      if (phase === "running") expect(await queue.markRunning({ workspaceId, agentId: agent.id, jobId, leaseMs: 1000 })).toBe(true);
    }
    return { plane, agent, queue, workspaceId, operationId, jobId, kind, envelope };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const post = (f: Fixture, value: unknown = body, agent: FakeAgent = f.agent) => agent.post(resultHandler(f.kind), `/jobs/${f.jobId}/result`, value, {}, { jti: f.jobId });
  async function authenticated(f: Fixture, value: unknown, backing = store) {
    const req = f.agent.request("POST", f.agent.path(`/jobs/${f.jobId}/result`), JSON.stringify(value));
    const auth = await authenticateAgentRequest(req, f.kind, { store: backing, now: f.plane.rt.now }, { maxBodyBytes: MAX_RESULT_BODY_BYTES });
    assertPathAgent(auth.agent, f.agent.id);
    return { auth, rt: { ...f.plane.rt, store: backing } };
  }
  async function independentPost(f: Fixture, value: unknown, backing = store2) {
    const { auth, rt } = await authenticated(f, value, backing);
    return settleResult(rt, auth.agent, f.jobId, parseJsonBody(auth.body));
  }
  async function unchangedOperation(f: Fixture) {
    if (db) expect((await repos.operations.get(db, f.workspaceId, f.operationId))?.status).toBe("uncertain");
  }
  async function receiptInput(f: Fixture): Promise<SettleOutcomeInput> {
    const { auth } = await authenticated(f, body);
    const logical = { ...body, result: body.result };
    return { workspaceId: auth.agent.workspaceId, agentId: auth.agent.id, jobId: f.jobId, authenticatedPublicKey: auth.agent.publicKey,
      status: "succeeded", logicalDigest: digest(logical), sealed: f.plane.rt.sealer.seal(effectReceiptAad(f.workspaceId, f.kind, f.jobId,
        { agentId: auth.agent.id, agentKeyDigest: sha256Hex(auth.agent.publicKey), envelopeDigest: sha256Hex(f.envelope) }), logical),
      result: { finishedAt: new Date(body.finishedAt).toISOString(), sealed: f.plane.rt.sealer.seal(sealAad(f.workspaceId, f.jobId), body.result) } };
  }

  describe.each(["runner", "machine"] as const)("%s authenticated outcomes", kind => {
    it("settles active work atomically and accepts an identical signed retry without replacing the first evidence", async () => {
      const f = await fixture(kind);
      expect((await post(f)).status).toBe(200);
      const first = await f.queue.getEffectReceipt(f.workspaceId, f.jobId);
      expect(first).toMatchObject({ agentKind: kind, agentId: f.agent.id,
        agentKeyDigest: sha256Hex(f.agent.key.publicKey), envelopeDigest: sha256Hex(f.envelope),
        projectionStatus: "running", reportedStatus: "succeeded" });
      expect((await post(f, { result: body.result, finishedAt: body.finishedAt, status: body.status })).status).toBe(200);
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toEqual(first);
      expect((await post(f, { ...body, result: { changed: true } })).status).toBe(409);
      expect((await f.queue.get(f.workspaceId, f.jobId))?.status).toBe("succeeded");
      expect(f.plane.events.filter(e => e.type.endsWith("completed"))).toHaveLength(1);
    });

    it.each(["claimed", "running"] as const)("retains a cancelled-after-%s outcome without reopening the job or clearing operation uncertainty", async phase => {
      const f = await fixture(kind, phase);
      await f.queue.cancel(f.workspaceId, f.jobId, "Control plane stopped waiting.");
      const before = await f.queue.get(f.workspaceId, f.jobId);
      const privateValue = "inert-sensitive-receipt-value";
      const value = { ...body, error: `Provider diagnostic ${privateValue}`, result: { privateValue, resourceUrl: "https://private.example.invalid/result" } };
      expect((await post(f, value)).status).toBe(200);
      const r = await f.queue.getEffectReceipt(f.workspaceId, f.jobId);
      expect(r).toMatchObject({ projectionStatus: "cancelled", reportedStatus: "succeeded" });
      expect(f.plane.rt.sealer.open(effectReceiptAad(f.workspaceId, kind, f.jobId, r!), r!.sealed)).toEqual(value);
      expect(JSON.stringify(r)).not.toMatch(/inert-sensitive-receipt-value|private\.example|Provider diagnostic|resourceUrl/);
      expect(await f.queue.get(f.workspaceId, f.jobId)).toEqual(before);
      expect(await f.queue.claimNext({ workspaceId: f.workspaceId, agentId: f.agent.id })).toEqual([]);
      expect(await f.queue.markRunning({ workspaceId: f.workspaceId, agentId: f.agent.id, jobId: f.jobId, leaseMs: 1000 })).toBe(false);
      expect(f.plane.events.filter(e => e.type.endsWith("completed"))).toEqual([]);
      await unchangedOperation(f);
    });

    it("retains an authenticated result after reaper timeout independently of its terminal projection", async () => {
      const f = await fixture(kind);
      await passTime(); await f.queue.expireStale(1000);
      const before = await f.queue.get(f.workspaceId, f.jobId);
      expect(before?.status).toBe("timed_out");
      expect((await post(f, { status: "failed", error: "Late provider failure.", result: { stopped: true } })).status).toBe(200);
      const retained = await f.queue.getEffectReceipt(f.workspaceId, f.jobId);
      expect(retained).toMatchObject({ projectionStatus: "timed_out", reportedStatus: "failed" });
      expect(await f.queue.cancel(f.workspaceId, f.jobId)).toBeNull();
      await f.queue.expireStale(1000);
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toEqual(retained);
      expect(await f.queue.get(f.workspaceId, f.jobId)).toEqual(before);
      await unchangedOperation(f);
    });

    it.each(["queued", "cancelled-unclaimed", "expired"])("refuses %s work with no original claim and retains no synthetic receipt", async state => {
      const f = await fixture(kind, "queued");
      if (state === "cancelled-unclaimed") await f.queue.cancel(f.workspaceId, f.jobId);
      if (state === "expired") { await passTime(); await f.queue.expireStale(1000); }
      const before = await f.queue.get(f.workspaceId, f.jobId);
      expect((await post(f)).status).toBe(409);
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toBeNull();
      expect(await f.queue.get(f.workspaceId, f.jobId)).toEqual(before);
    });

    it("refuses foreign workspace, agent, job and invalid signature without recording evidence", async () => {
      const f = await fixture(kind);
      await f.queue.cancel(f.workspaceId, f.jobId);
      const foreign = await registerFakeAgent(f.plane, registerHandler(kind), { kind, workspaceId: id("foreign") });
      const sibling = await registerFakeAgent(f.plane, registerHandler(kind), { kind, workspaceId: f.workspaceId });
      expect((await post(f, body, foreign)).status).toBe(404);
      expect((await post(f, body, sibling)).status).toBe(404);
      expect(await f.queue.getEffectReceipt(id("foreign"), f.jobId)).toBeNull();
      expect((await f.agent.post(resultHandler(kind), "/jobs/job_missing/result", body, {}, { jti: "job_missing" })).status).toBe(404);
      expect((await f.agent.post(resultHandler(kind), `/jobs/${f.jobId}/result`, body, { privateKey: sibling.key.privateKey }, { jti: f.jobId })).status).toBe(401);
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toBeNull();
    });

    it("refuses valid encrypted outcomes under foreign SQL scope while retaining owning evidence", async () => {
      const f = await fixture(kind), input = await receiptInput(f), foreign = id("foreign");
      const foreignInput = { ...input, workspaceId: foreign, sealed: f.plane.rt.sealer.seal(effectReceiptAad(foreign, kind, f.jobId,
        { agentId: f.agent.id, agentKeyDigest: sha256Hex(f.agent.key.publicKey), envelopeDigest: sha256Hex(f.envelope) }), body) };
      await expect(f.queue.settleOutcome(foreignInput)).rejects.toMatchObject({ code: "agent_revoked" });
      expect(await f.queue.getEffectReceipt(foreign, f.jobId)).toBeNull();
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toBeNull();
      const own = await f.queue.settleOutcome(input);
      expect(own.receipt).toMatchObject({ workspaceId: f.workspaceId, jobId: f.jobId, reportedStatus: "succeeded" });
      const before = await f.queue.getEffectReceipt(f.workspaceId, f.jobId);
      await expect(f.queue.settleOutcome(foreignInput)).rejects.toMatchObject({ code: "agent_revoked" });
      expect(await f.queue.getEffectReceipt(foreign, f.jobId)).toBeNull();
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toEqual(before);
    });

    it("rechecks revocation after request authentication and refuses the previously valid identity", async () => {
      const f = await fixture(kind);
      await f.queue.cancel(f.workspaceId, f.jobId);
      const { auth, rt } = await authenticated(f, body);
      await registryOf(store, kind).revoke(f.workspaceId, f.agent.id);
      await expect(settleResult(rt, auth.agent, f.jobId, parseJsonBody(auth.body))).rejects.toMatchObject({ status: 401, code: "agent_revoked" });
      expect((await post(f)).status).toBe(401);
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toBeNull();
    });

    it("refuses unknown fields and non-JSON/deep result values with fixed-safe errors", async () => {
      const f = await fixture(kind); await f.queue.cancel(f.workspaceId, f.jobId);
      const leakedKey = "https://private.example.invalid/invalid";
      const r = await post(f, { ...body, [leakedKey]: true });
      expect(r.status).toBe(400); expect(JSON.stringify(r.body)).not.toContain(leakedKey);
      let nested: unknown = {};
      for (let i = 0; i < 66; i++) nested = { child: nested };
      expect((await post(f, { ...body, result: nested })).status).toBe(400);
      expect((await post(f, { ...body, result: Array(100_001).fill(0) })).status).toBe(400);
      const { auth, rt } = await authenticated(f, body);
      const cycle: Record<string, unknown> = {}; cycle.self = cycle;
      await expect(settleResult(rt, auth.agent, f.jobId, { ...body, result: cycle })).rejects.toMatchObject({ code: "invalid_request", message: "Invalid result body." });
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toBeNull();
    });

    it("serializes independent matching deliveries and retains exactly the first immutable receipt", async () => {
      const f = await fixture(kind); await f.queue.cancel(f.workspaceId, f.jobId);
      const results = await Promise.all([independentPost(f, body, store), independentPost(f, body, store2)]);
      expect(results).toEqual([{ status: "accepted" }, { status: "accepted" }]);
      const first = await f.queue.getEffectReceipt(f.workspaceId, f.jobId);
      expect(await queueOf(store2, kind).getEffectReceipt(f.workspaceId, f.jobId)).toEqual(first);
      expect((await f.queue.get(f.workspaceId, f.jobId))?.status).toBe("cancelled");
      expect(await f.queue.claimNext({ workspaceId: f.workspaceId, agentId: f.agent.id })).toEqual([]);
      await unchangedOperation(f);
    });

    it("serializes divergent deliveries across independent workers and refuses the losing logical outcome", async () => {
      const f = await fixture(kind); await f.queue.cancel(f.workspaceId, f.jobId);
      const values = [body, { ...body, result: { providerResult: "different-outcome" } }];
      const results = await Promise.allSettled(values.map((value, i) => independentPost(f, value, i ? store2 : store)));
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find(r => r.status === "rejected");
      expect(lost?.status === "rejected" ? lost.reason : undefined).toMatchObject({ status: 409, code: "already_settled" });
      const r = await f.queue.getEffectReceipt(f.workspaceId, f.jobId);
      const winner = results.findIndex(value => value.status === "fulfilled");
      expect(f.plane.rt.sealer.open(effectReceiptAad(f.workspaceId, kind, f.jobId, r!), r!.sealed)).toEqual(values[winner]);
    });

    it("retains committed evidence when the caller loses the acknowledgement and refuses any replay of work", async () => {
      const f = await fixture(kind); await f.queue.cancel(f.workspaceId, f.jobId);
      const real = queueOf(store, kind);
      const wrapped = { ...real, settleOutcome: async (i: SettleOutcomeInput) => { await real.settleOutcome(i); throw new Error("Lost receipt acknowledgement."); } };
      const broken: RunnerStore = { ...store, ...(kind === "runner" ? { jobs: wrapped } : { machineRequests: wrapped }) };
      await expect(independentPost(f, body, broken)).rejects.toThrow("Lost receipt acknowledgement.");
      const first = await f.queue.getEffectReceipt(f.workspaceId, f.jobId);
      expect(first).not.toBeNull();
      expect((await post(f)).status).toBe(200);
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toEqual(first);
      expect((await f.queue.get(f.workspaceId, f.jobId))?.status).toBe("cancelled");
      expect(await f.queue.claimNext({ workspaceId: f.workspaceId, agentId: f.agent.id })).toEqual([]);
    });

    it("commits active settlement and receipt before advisory audit delivery, retaining evidence when delivery fails", async () => {
      const f = await fixture(kind);
      vi.spyOn(log, "warn").mockImplementation(() => undefined);
      f.plane.rt.events.emit = () => { throw new Error("Audit sink unavailable."); };
      expect((await post(f)).status).toBe(200);
      const first = await f.queue.getEffectReceipt(f.workspaceId, f.jobId);
      expect(first).not.toBeNull();
      expect((await post(f)).status).toBe(200);
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toEqual(first);
      expect((await f.queue.get(f.workspaceId, f.jobId))?.status).toBe("succeeded");
    });

    it("binds sealed evidence to workspace, agent kind, job, agent key and original envelope without an old-key fallback", async () => {
      const f = await fixture(kind); await f.queue.cancel(f.workspaceId, f.jobId);
      expect((await post(f)).status).toBe(200);
      const r = (await f.queue.getEffectReceipt(f.workspaceId, f.jobId))!;
      expect(() => f.plane.rt.sealer.open(effectReceiptAad(f.workspaceId, kind === "runner" ? "machine" : "runner", f.jobId, r), r.sealed)).toThrow();
      expect(() => f.plane.rt.sealer.open(effectReceiptAad(id("foreign"), kind, f.jobId, r), r.sealed)).toThrow();
      expect(() => f.plane.rt.sealer.open(effectReceiptAad(f.workspaceId, kind, id("job"), r), r.sealed)).toThrow();
      expect(() => f.plane.rt.sealer.open(effectReceiptAad(f.workspaceId, kind, f.jobId, { ...r, agentId: id("agent") }), r.sealed)).toThrow();
      expect(() => f.plane.rt.sealer.open(effectReceiptAad(f.workspaceId, kind, f.jobId, { ...r, agentKeyDigest: sha256Hex("other-authenticated-key") }), r.sealed)).toThrow();
      expect(() => f.plane.rt.sealer.open(effectReceiptAad(f.workspaceId, kind, f.jobId, { ...r, envelopeDigest: sha256Hex("other-original-assignment") }), r.sealed)).toThrow();
      const newSealer = createAesResultSealer(randomBytes(32));
      expect(() => newSealer.open(effectReceiptAad(f.workspaceId, kind, f.jobId, r), r.sealed)).toThrow();
      const { auth, rt } = await authenticated(f, body);
      expect(await settleResult({ ...rt, sealer: newSealer }, auth.agent, f.jobId, body)).toEqual({ status: "accepted" });
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toEqual(r);
      await unchangedOperation(f);
    });

    it("copies returned evidence and validates ciphertext rather than accepting raw proof-shaped results", async () => {
      const f = await fixture(kind); await f.queue.cancel(f.workspaceId, f.jobId);
      const input = await receiptInput(f);
      await expect(f.queue.settleOutcome({ ...input, sealed: { ...input.sealed, ct: "https://private.example.invalid/raw" } })).rejects.toMatchObject({ code: "invalid_input" });
      // Regex coercion must not turn a numeric IV into accepted ciphertext.
      await expect(f.queue.settleOutcome({ ...input, sealed: { ...input.sealed, iv: 1234567890123456 } } as unknown as SettleOutcomeInput)).rejects.toMatchObject({ code: "invalid_input" });
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toBeNull();
      await f.queue.settleOutcome(input);
      const first = (await f.queue.getEffectReceipt(f.workspaceId, f.jobId))!;
      const r = (await f.queue.getEffectReceipt(f.workspaceId, f.jobId))!;
      r.logicalDigest = "0".repeat(64); r.sealed.ct = "altered";
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toEqual(first);
    });

    it.skipIf(lane.name === "memory")("rolls back the receipt and active projection together, then accepts a fresh delivery", async () => {
      const f = await fixture(kind), input = await receiptInput(f);
      const rollback = new Error("Deliberate receipt transaction rollback.");
      await expect(db!.tx(async tx => {
        await queueOf(createPlatformRunnerStore(tx), kind).settleOutcome(input);
        expect((await queueOf(createPlatformRunnerStore(tx), kind).getEffectReceipt(f.workspaceId, f.jobId))?.reportedStatus).toBe("succeeded");
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toBeNull();
      expect((await f.queue.get(f.workspaceId, f.jobId))?.status).toBe("running");
      expect((await post(f)).status).toBe(200);
    });

    it.skipIf(lane.name === "memory")("makes receipt update/delete and original assignment substitution fail at the database boundary", async () => {
      const f = await fixture(kind); await f.queue.cancel(f.workspaceId, f.jobId); await post(f);
      await expect(db!.tx(tx => tx.query("delete from platform.agent_effect_receipts where workspace_id=$1 and agent_kind=$2 and job_id=$3", [f.workspaceId, kind, f.jobId]))).rejects.toMatchObject({ sqlstate: "23514" });
      await expect(db!.tx(tx => tx.query("update platform.agent_effect_receipts set logical_digest=$4 where workspace_id=$1 and agent_kind=$2 and job_id=$3", [f.workspaceId, kind, f.jobId, "0".repeat(64)]))).rejects.toMatchObject({ sqlstate: "23514" });
      const table = kind === "runner" ? "platform.runner_jobs" : "platform.machine_requests";
      await expect(db!.tx(tx => tx.query(`update ${table} set envelope='substituted' where workspace_id=$1 and id=$2`, [f.workspaceId, f.jobId]))).rejects.toMatchObject({ sqlstate: "23514" });
      await expect(db!.tx(tx => tx.query(`update ${table} set claimed_at=null where workspace_id=$1 and id=$2`, [f.workspaceId, f.jobId]))).rejects.toMatchObject({ sqlstate: "23514" });
      await expect(db!.tx(tx => tx.query(`delete from ${table} where workspace_id=$1 and id=$2`, [f.workspaceId, f.jobId]))).rejects.toMatchObject({ sqlstate: "23503" });
    });

    it.skipIf(lane.name !== "postgres")("observes a blocked PostgreSQL result writer and retains late evidence when cancellation wins the job lock", async () => {
      const f = await fixture(kind);
      const table = kind === "runner" ? "platform.runner_jobs" : "platform.machine_requests";
      let delivery: Promise<{ result: { status: "accepted" } } | { error: unknown }> | undefined;
      let claimantPid = 0, backendReady!: () => void;
      const ready = new Promise<void>(resolve => { backendReady = resolve; });
      const claimant: Sql = { query: db2!.query.bind(db2), tx: fn => db2!.tx(async tx => {
        claimantPid = (await tx.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid;
        backendReady(); return fn(tx);
      }) };
      const claimantStore = createPlatformRunnerStore(claimant);
      try { await db!.tx(async blocker => {
        await blocker.query(`select id from ${table} where workspace_id=$1 and id=$2 for update`, [f.workspaceId, f.jobId]);
        const [{ pid }] = await blocker.query<{ pid: number }>("select pg_backend_pid() as pid");
        delivery = independentPost(f, body, claimantStore).then(result => ({ result }), error => ({ error }));
        await Promise.race([ready, delivery.then(() => { throw new Error("Result completed before entering its independent claim transaction."); })]);
        expect(claimantPid).toBeGreaterThan(0); expect(claimantPid).not.toBe(pid);
        let waiting = false;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const state = await observer!.tx(async fresh => {
            await fresh.query("select pg_stat_clear_snapshot()");
            return (await fresh.query<{ blocked: boolean; observer_pid: number }>(`select pg_backend_pid() as observer_pid,
              exists (select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'
                and $2=any(pg_blocking_pids(pid)) and query like $3) as blocked`,
              [claimantPid, pid, `%from ${table}%for update%`]))[0];
          });
          expect(state.observer_pid).not.toBe(pid); expect(state.observer_pid).not.toBe(claimantPid);
          if (state.blocked) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        expect(await blocker.query("select job_id from platform.agent_effect_receipts where workspace_id=$1 and agent_kind=$2 and job_id=$3", [f.workspaceId, kind, f.jobId])).toEqual([]);
        await blocker.query(`update ${table} set status='cancelled',settled_at=clock_timestamp(),lease_until=null where workspace_id=$1 and id=$2`, [f.workspaceId, f.jobId]);
      }); } finally { if (delivery) await delivery; }
      expect(await delivery).toEqual({ result: { status: "accepted" } });
      expect(await f.queue.getEffectReceipt(f.workspaceId, f.jobId)).toMatchObject({ projectionStatus: "cancelled", reportedStatus: "succeeded" });
      expect((await f.queue.get(f.workspaceId, f.jobId))?.status).toBe("cancelled");
      expect(await f.queue.claimNext({ workspaceId: f.workspaceId, agentId: f.agent.id })).toEqual([]);
      expect(f.plane.events.filter(e => e.type.endsWith("completed"))).toEqual([]);
      await unchangedOperation(f);
    });
  });
});
