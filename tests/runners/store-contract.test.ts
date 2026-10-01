/**
 * The `RunnerStore` port contract, run against BOTH implementations:
 *   - the in-memory store (fake clock), and
 *   - the platform-store adapter over PGlite (the production SQL: `repos.runners/jobs/nonces/machines`
 *     plus the machine-request queue), on the database's own clock.
 *
 * The memory store exists for fast unit tests; this file is what keeps it honest — it must agree with
 * the real SQL on registration atomicity, claim exclusivity, settle-once, revoke semantics, tenancy,
 * nonce windows and log idempotency. Timing cases use the store's minimum TTL (1 s), so they wait about
 * a second of real time on the database and advance the fake clock on the memory store.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryRunnerStore } from "@/lib/runners/memory-store";
import { RunnerStoreError, queueOf, registryOf, type JobQueue, type RunnerStore } from "@/lib/runners/ports";
import { MACHINE_PROTOCOL, RUNNER_PROTOCOL, type AgentKind } from "@/lib/runners/types";
import { newAgentKey, openDbPlane, T0, type DbPlane } from "./_support";

interface Harness {
  name: string;
  store: RunnerStore;
  operation(workspaceId: string): Promise<string>;
  /** let `ms` of store time pass (fake clock: advance it; database: really wait) */
  wait(ms: number): Promise<void>;
  fakeClock: boolean;
}

let dbPlane: DbPlane;
const clock = { t: T0 };
let opSeq = 0;

const memory = (): Harness => ({
  name: "in-memory store",
  store: createMemoryRunnerStore({ now: () => clock.t }),
  operation: async (ws) => `op_${ws}_${++opSeq}`,
  wait: async (ms) => {
    clock.t += ms;
  },
  fakeClock: true,
});

let harnesses: Harness[] = [];
beforeAll(async () => {
  dbPlane = await openDbPlane();
  harnesses = [
    memory(),
    {
      name: "platform store on PGlite",
      store: dbPlane.store,
      operation: (ws) => dbPlane.operation(ws),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      fakeClock: false,
    },
  ];
});
afterAll(async () => dbPlane?.close());

let n = 0;
const ws = (): string => `w-contract-${++n}`;
const tokenHash = (): string => randomBytes(32).toString("hex");
const protocolOf = (kind: AgentKind): string => (kind === "runner" ? RUNNER_PROTOCOL : MACHINE_PROTOCOL);

async function enrol(h: Harness, kind: AgentKind, workspaceId: string, id?: string) {
  const hash = tokenHash();
  await h.store.tokens.create({ workspaceId, kind, createdBy: "user-1", tokenHash: hash });
  return registryOf(h.store, kind).register({ tokenHash: hash, id, name: `${kind}-x`, publicKey: newAgentKey().publicKey, protocol: protocolOf(kind), capabilities: ["aws.http"], labels: { a: "b" }, host: { os: "linux" } });
}

async function enqueue(h: Harness, q: JobQueue, workspaceId: string, agentId: string, over: { id?: string; ttlMs?: number; operationId?: string } = {}) {
  const operationId = over.operationId ?? (await h.operation(workspaceId));
  return q.enqueue({ id: over.id ?? `job_${randomBytes(6).toString("hex")}`, workspaceId, agentId, operationId, kind: "aws.http", capability: "infrastructure.observe", envelope: "a.b.c", ttlMs: over.ttlMs });
}

const storeErr = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof RunnerStoreError ? e.code : `unexpected ${(e as Error).name}: ${(e as Error).message}`;
  }
};

describe.each(["runner", "machine"] as const)("%s registration", (kind) => {
  const each = (run: (h: Harness) => Promise<void>) => async () => {
    for (const h of harnesses) await run(h);
  };

  it("consumes the token exactly once and takes the workspace from the token", each(async (h) => {
    const w = ws();
    const hash = tokenHash();
    await h.store.tokens.create({ workspaceId: w, kind, createdBy: "user-1", tokenHash: hash });
    const input = { tokenHash: hash, name: "a", publicKey: newAgentKey().publicKey, protocol: protocolOf(kind), capabilities: [], labels: {}, host: {} };
    const agent = await registryOf(h.store, kind).register(input);
    expect(agent.workspaceId, h.name).toBe(w);
    expect(agent.status).toBe("active");
    expect(await storeErr(registryOf(h.store, kind).register(input)), h.name).toBe("invalid_registration_token");
  }));

  it("refuses an unknown token, a token of the other kind, and never reveals which", each(async (h) => {
    const w = ws();
    const other: AgentKind = kind === "runner" ? "machine" : "runner";
    const hash = tokenHash();
    await h.store.tokens.create({ workspaceId: w, kind: other, createdBy: "user-1", tokenHash: hash });
    const input = { name: "a", publicKey: newAgentKey().publicKey, protocol: protocolOf(kind), capabilities: [], labels: {}, host: {} };
    expect(await storeErr(registryOf(h.store, kind).register({ ...input, tokenHash: hash })), h.name).toBe("invalid_registration_token");
    expect(await storeErr(registryOf(h.store, kind).register({ ...input, tokenHash: tokenHash() })), h.name).toBe("invalid_registration_token");
    // the wrong-kind attempt did not burn the token for its real kind
    expect((await registryOf(h.store, other).register({ ...input, tokenHash: hash, protocol: protocolOf(other) })).workspaceId).toBe(w);
  }));

  it("refuses an expired token", each(async (h) => {
    const w = ws();
    const hash = tokenHash();
    await h.store.tokens.create({ workspaceId: w, kind, createdBy: "user-1", tokenHash: hash, ttlMs: 1000 });
    await h.wait(1150);
    expect(await storeErr(registryOf(h.store, kind).register({ tokenHash: hash, name: "a", publicKey: newAgentKey().publicKey, protocol: protocolOf(kind), capabilities: [], labels: {}, host: {} })), h.name).toBe("invalid_registration_token");
  }));

  it("a registration that fails validation does not consume the token", each(async (h) => {
    const w = ws();
    const hash = tokenHash();
    await h.store.tokens.create({ workspaceId: w, kind, createdBy: "user-1", tokenHash: hash });
    const base = { tokenHash: hash, name: "a", protocol: protocolOf(kind), capabilities: [], labels: {}, host: {} };
    expect(await storeErr(registryOf(h.store, kind).register({ ...base, publicKey: "tooshort" })), h.name).toBe("invalid_input");
    expect((await registryOf(h.store, kind).register({ ...base, publicKey: newAgentKey().publicKey })).workspaceId).toBe(w);
  }));

  it("rejects a token hash that is not a SHA-256, and a ttl beyond one hour", each(async (h) => {
    const w = ws();
    expect(await storeErr(h.store.tokens.create({ workspaceId: w, kind, createdBy: "u", tokenHash: "zrt_raw-token-not-a-hash" })), h.name).toBe("invalid_input");
    expect(await storeErr(h.store.tokens.create({ workspaceId: w, kind, createdBy: "u", tokenHash: tokenHash(), ttlMs: 61 * 60 * 1000 })), h.name).toBe("invalid_input");
  }));

  it("scopes get/list by workspace; findForAuth is the one unscoped read", each(async (h) => {
    const a = ws();
    const b = ws();
    const reg = registryOf(h.store, kind);
    const agentA = await enrol(h, kind, a);
    await enrol(h, kind, b);
    expect((await reg.findForAuth(agentA.id))?.workspaceId, h.name).toBe(a);
    expect(await reg.findForAuth("nope"), h.name).toBeNull();
    expect((await reg.get(a, agentA.id))?.id).toBe(agentA.id);
    expect(await reg.get(b, agentA.id), h.name).toBeNull();
    expect((await reg.list(a)).map((x) => x.id)).toEqual([agentA.id]);
  }));

  it("heartbeat updates the row, reports revocation, and is workspace-scoped", each(async (h) => {
    const a = ws();
    const reg = registryOf(h.store, kind);
    const agent = await enrol(h, kind, a);
    expect(await reg.heartbeat({ workspaceId: a, id: agent.id, version: "2.0.0", capabilities: ["aws.http", "tofu.run"] }), h.name).toEqual({ revoked: false });
    const row = await reg.get(a, agent.id);
    expect(row?.version).toBe("2.0.0");
    expect(row?.capabilities).toEqual(["aws.http", "tofu.run"]);
    expect(row?.lastHeartbeatAt).toBeTruthy();
    expect(await reg.heartbeat({ workspaceId: ws(), id: agent.id }), h.name).toBeNull();
    await reg.revoke(a, agent.id);
    expect(await reg.heartbeat({ workspaceId: a, id: agent.id }), h.name).toEqual({ revoked: true });
  }));

  it("revoke is terminal and idempotent, scoped to the workspace, and cancels queued and claimed work but not running work", each(async (h) => {
    const a = ws();
    const reg = registryOf(h.store, kind);
    const q = queueOf(h.store, kind);
    const agent = await enrol(h, kind, a);
    const queued = await enqueue(h, q, a, agent.id);
    const claimed = await enqueue(h, q, a, agent.id);
    const running = await enqueue(h, q, a, agent.id);
    // claim in creation order: [queued, claimed, running] -> mark the first two claimed only
    const got = await q.claimNext({ workspaceId: a, agentId: agent.id, max: 3, leaseMs: 30_000 });
    expect(got.map((j) => j.id), h.name).toEqual([queued.id, claimed.id, running.id]);
    expect(await q.markRunning({ workspaceId: a, agentId: agent.id, jobId: running.id, leaseMs: 30_000 }), h.name).toBe(true);
    // a fourth job is left queued
    const late = await enqueue(h, q, a, agent.id);

    expect(await reg.revoke(ws(), agent.id), h.name).toBeNull(); // another workspace cannot revoke it
    expect((await reg.get(a, agent.id))?.status).toBe("active");
    const res = await reg.revoke(a, agent.id);
    expect(res?.agent.status, h.name).toBe("revoked");
    expect(res?.cancelledJobs, h.name).toBe(3); // queued + claimed + late; running survives
    expect((await q.get(a, running.id))?.status, h.name).toBe("running");
    for (const id of [queued.id, claimed.id, late.id]) expect((await q.get(a, id))?.status, h.name).toBe("cancelled");
    expect((await reg.revoke(a, agent.id))?.agent.status, h.name).toBe("revoked"); // idempotent
    expect(await storeErr(enqueue(h, q, a, agent.id)), h.name).toBe("not_found"); // never dispatched to again
    expect(await q.claimNext({ workspaceId: a, agentId: agent.id }), h.name).toEqual([]);
  }));
});

describe("runner staleness (derived on the store clock)", () => {
  it("is false when fresh, true after 90 s of silence, and cleared by a heartbeat", async () => {
    const h = harnesses[0]; // only the fake clock can skip 90 s
    const a = ws();
    const agent = await enrol(h, "runner", a);
    expect((await h.store.runners.get(a, agent.id))?.stale).toBe(false);
    await h.wait(89_000);
    expect((await h.store.runners.get(a, agent.id))?.stale).toBe(false);
    await h.wait(2_000);
    expect((await h.store.runners.get(a, agent.id))?.stale).toBe(true);
    await h.store.runners.heartbeat({ workspaceId: a, id: agent.id });
    expect((await h.store.runners.get(a, agent.id))?.stale).toBe(false);
  });
});

describe("nonces", () => {
  it("accepts a nonce once per agent within the window, atomically", async () => {
    for (const h of harnesses) {
      const agent = `run_${randomBytes(4).toString("hex")}`;
      const nonce = randomBytes(16).toString("base64url");
      const results = await Promise.all(Array.from({ length: 8 }, () => h.store.nonces.remember(agent, nonce, 10 * 60 * 1000)));
      expect(results.filter(Boolean), h.name).toHaveLength(1); // of racing requests exactly one wins
      expect(await h.store.nonces.remember(agent, nonce, 10 * 60 * 1000), h.name).toBe(false);
      expect(await h.store.nonces.remember(`${agent}x`, nonce, 10 * 60 * 1000), h.name).toBe(true); // keyed by agent
    }
  });

  it("treats a nonce older than the window as unseen", async () => {
    for (const h of harnesses) {
      const agent = `run_${randomBytes(4).toString("hex")}`;
      const nonce = randomBytes(16).toString("base64url");
      expect(await h.store.nonces.remember(agent, nonce, 1000)).toBe(true);
      expect(await h.store.nonces.remember(agent, nonce, 1000), h.name).toBe(false);
      await h.wait(1150);
      expect(await h.store.nonces.remember(agent, nonce, 1000), h.name).toBe(true);
    }
  });
});

describe.each(["runner", "machine"] as const)("%s job queue", (kind) => {
  const each = (run: (h: Harness, q: JobQueue) => Promise<void>) => async () => {
    for (const h of harnesses) await run(h, queueOf(h.store, kind));
  };

  it("enqueues only for an active agent of the caller's workspace (and an existing operation)", each(async (h, q) => {
    const a = ws();
    const b = ws();
    const agent = await enrol(h, kind, a);
    expect(await storeErr(enqueue(h, q, b, agent.id)), h.name).toBe("not_found"); // another tenant's agent
    expect(await storeErr(enqueue(h, q, a, "nobody")), h.name).toBe("not_found");
    const job = await enqueue(h, q, a, agent.id);
    expect(job.status).toBe("queued");
    expect(job.agentId).toBe(agent.id);
    expect(job.workspaceId).toBe(a);
    expect(await storeErr(enqueue(h, q, a, agent.id, { id: job.id })), h.name).toBe("conflict"); // ids are unique
  }));

  it("claims oldest first, exclusively, even under concurrent claimers", each(async (h, q) => {
    const a = ws();
    const agent = await enrol(h, kind, a);
    const made = [];
    for (let i = 0; i < 6; i++) made.push((await enqueue(h, q, a, agent.id)).id);
    const batches = await Promise.all(Array.from({ length: 4 }, () => q.claimNext({ workspaceId: a, agentId: agent.id, max: 2, leaseMs: 30_000 })));
    const all = batches.flat().map((j) => j.id);
    expect(new Set(all).size, h.name).toBe(all.length); // no job handed out twice
    expect(all.sort(), h.name).toEqual([...made].sort()); // and none lost
    for (const j of batches.flat()) {
      expect(j.status).toBe("claimed");
      expect(j.leaseUntil).toBeTruthy();
    }
    expect(await q.claimNext({ workspaceId: a, agentId: agent.id }), h.name).toEqual([]);
  }));

  it("returns the oldest jobs first", each(async (h, q) => {
    const a = ws();
    const agent = await enrol(h, kind, a);
    const first = await enqueue(h, q, a, agent.id);
    await h.wait(5);
    const second = await enqueue(h, q, a, agent.id);
    const got = await q.claimNext({ workspaceId: a, agentId: agent.id, max: 2 });
    expect(got.map((j) => j.id), h.name).toEqual([first.id, second.id]);
  }));

  it("never claims another agent's or another workspace's jobs", each(async (h, q) => {
    const a = ws();
    const b = ws();
    const one = await enrol(h, kind, a);
    const two = await enrol(h, kind, a);
    const three = await enrol(h, kind, b);
    await enqueue(h, q, a, one.id);
    expect(await q.claimNext({ workspaceId: a, agentId: two.id }), h.name).toEqual([]);
    expect(await q.claimNext({ workspaceId: b, agentId: one.id }), h.name).toEqual([]);
    expect(await q.claimNext({ workspaceId: b, agentId: three.id }), h.name).toEqual([]);
    expect(await q.claimNext({ workspaceId: a, agentId: one.id }), h.name).toHaveLength(1);
  }));

  it("settles exactly once; a duplicate, a foreign agent and a foreign workspace all get false", each(async (h, q) => {
    const a = ws();
    const b = ws();
    const one = await enrol(h, kind, a);
    const two = await enrol(h, kind, a);
    const job = await enqueue(h, q, a, one.id);
    const args = { workspaceId: a, agentId: one.id, jobId: job.id, status: "succeeded" as const, result: { ok: true }, error: undefined };
    expect(await q.settle(args), `${h.name}: not yet claimed`).toBe(false);
    await q.claimNext({ workspaceId: a, agentId: one.id });
    expect(await q.settle({ ...args, agentId: two.id }), `${h.name}: another agent`).toBe(false);
    expect(await q.settle({ ...args, workspaceId: b }), `${h.name}: another workspace`).toBe(false);
    const wins = await Promise.all([q.settle(args), q.settle({ ...args, status: "failed" }), q.settle(args)]);
    expect(wins.filter(Boolean), `${h.name}: racing results`).toHaveLength(1);
    const after = await q.get(a, job.id);
    expect(after?.status).toBe("succeeded");
    expect(after?.result).toEqual({ ok: true });
    expect(after?.settledAt).toBeTruthy();
    expect(await q.settle(args), h.name).toBe(false);
    expect(await q.get(b, job.id), h.name).toBeNull();
  }));

  it("markRunning needs a live claim by the same agent and extends the lease", each(async (h, q) => {
    const a = ws();
    const one = await enrol(h, kind, a);
    const two = await enrol(h, kind, a);
    const job = await enqueue(h, q, a, one.id);
    expect(await q.markRunning({ workspaceId: a, agentId: one.id, jobId: job.id, leaseMs: 5000 }), `${h.name}: unclaimed`).toBe(false);
    await q.claimNext({ workspaceId: a, agentId: one.id, leaseMs: 1000 });
    expect(await q.markRunning({ workspaceId: a, agentId: two.id, jobId: job.id, leaseMs: 5000 }), `${h.name}: another agent`).toBe(false);
    expect(await q.markRunning({ workspaceId: a, agentId: one.id, jobId: job.id, leaseMs: 60_000 }), h.name).toBe(true);
    const row = await q.get(a, job.id);
    expect(row?.status).toBe("running");
    expect(row?.startedAt).toBeTruthy();
  }));

  it("cancel settles a job that has not finished, once, and is workspace-scoped", each(async (h, q) => {
    const a = ws();
    const agent = await enrol(h, kind, a);
    const job = await enqueue(h, q, a, agent.id);
    expect(await q.cancel(ws(), job.id, "x"), h.name).toBeNull();
    const cancelled = await q.cancel(a, job.id, "stopped waiting");
    expect(cancelled?.status, h.name).toBe("cancelled");
    expect(cancelled?.error).toBe("stopped waiting");
    expect(await q.cancel(a, job.id), h.name).toBeNull();
    expect(await q.claimNext({ workspaceId: a, agentId: agent.id }), h.name).toEqual([]);
    // a cancelled job cannot be settled by a late agent result
    expect(await q.settle({ workspaceId: a, agentId: agent.id, jobId: job.id, status: "succeeded", result: {} }), h.name).toBe(false);
  }));

  it("the reaper expires an unclaimed job past its ttl and times out a running one past its lease; nothing is re-queued", each(async (h, q) => {
    const a = ws();
    const idle = await enrol(h, kind, a); // never polls: its job is never claimed
    const busy = await enrol(h, kind, a);
    const expiring = await enqueue(h, q, a, idle.id, { ttlMs: 1000 });
    const running = await enqueue(h, q, a, busy.id, { ttlMs: 60_000 });
    const fresh = await enqueue(h, q, a, busy.id, { ttlMs: 60_000 });
    const claimed = await q.claimNext({ workspaceId: a, agentId: busy.id, max: 1 });
    expect(claimed.map((j) => j.id), h.name).toEqual([running.id]);
    expect(await q.markRunning({ workspaceId: a, agentId: busy.id, jobId: running.id, leaseMs: 1000 })).toBe(true);
    await h.wait(1250);
    const reaped = await q.expireStale(100);
    const byId = new Map(reaped.map((j) => [j.id, j.status]));
    expect(byId.get(running.id), `${h.name}: a running job past its lease`).toBe("timed_out");
    expect(byId.get(expiring.id), `${h.name}: an unclaimed job past its ttl`).toBe("expired");
    expect(byId.has(fresh.id), `${h.name}: a fresh job is untouched`).toBe(false);
    expect((await q.get(a, fresh.id))?.status).toBe("queued");
    // a reaped job can be neither claimed nor settled later, and the reaper finds nothing twice
    expect(await q.settle({ workspaceId: a, agentId: busy.id, jobId: running.id, status: "succeeded", result: {} }), h.name).toBe(false);
    expect(await q.claimNext({ workspaceId: a, agentId: idle.id }), h.name).toEqual([]);
    expect((await q.claimNext({ workspaceId: a, agentId: busy.id, max: 5 })).map((j) => j.id), h.name).toEqual([fresh.id]);
    expect((await q.expireStale(100)).filter((j) => [running.id, expiring.id].includes(j.id)), h.name).toEqual([]);
  }));

  it("lists jobs per operation, scoped to the workspace", each(async (h, q) => {
    const a = ws();
    const agent = await enrol(h, kind, a);
    const operationId = await h.operation(a);
    const j1 = await enqueue(h, q, a, agent.id, { operationId });
    const j2 = await enqueue(h, q, a, agent.id, { operationId });
    expect((await q.listForOperation(a, operationId)).map((j) => j.id), h.name).toEqual([j1.id, j2.id]);
    expect(await q.listForOperation(ws(), operationId), h.name).toEqual([]);
  }));
});

describe.each(["runner", "machine"] as const)("%s job logs", (kind) => {
  const each = (run: (h: Harness, q: JobQueue) => Promise<void>) => async () => {
    for (const h of harnesses) await run(h, queueOf(h.store, kind));
  };
  const line = (i: number, stream: "stdout" | "stderr" | "info" = "stdout") => ({ ts: new Date(T0 + i).toISOString(), stream, line: `line ${i}` });

  it("appends in order, is idempotent per (batchSeq, line), and reports usage", each(async (h, q) => {
    const a = ws();
    const agent = await enrol(h, kind, a);
    const job = await enqueue(h, q, a, agent.id);
    await q.claimNext({ workspaceId: a, agentId: agent.id });
    const batch = [line(1), line(2, "stderr"), line(3, "info")];
    expect(await q.appendLogs({ workspaceId: a, agentId: agent.id, jobId: job.id, batchSeq: 1, lines: batch }), h.name).toBe(3);
    expect(await q.appendLogs({ workspaceId: a, agentId: agent.id, jobId: job.id, batchSeq: 1, lines: batch }), `${h.name}: a retried POST does not duplicate`).toBe(0);
    expect(await q.appendLogs({ workspaceId: a, agentId: agent.id, jobId: job.id, batchSeq: 2, lines: [line(4)] }), h.name).toBe(1);
    const logs = await q.listLogs({ workspaceId: a, jobId: job.id });
    expect(logs.map((l) => l.line), h.name).toEqual(["line 1", "line 2", "line 3", "line 4"]);
    expect(logs.map((l) => l.stream)).toEqual(["stdout", "stderr", "info", "stdout"]);
    expect(await q.logUsage(a, job.id), h.name).toEqual({ lines: 4, bytes: 4 * "line 1".length });
    const page = await q.listLogs({ workspaceId: a, jobId: job.id, afterId: logs[1].id, limit: 1 });
    expect(page.map((l) => l.line), h.name).toEqual(["line 3"]);
  }));

  it("refuses a batch over 500 lines, a bad stream, and another agent's or workspace's job", each(async (h, q) => {
    const a = ws();
    const agent = await enrol(h, kind, a);
    const other = await enrol(h, kind, a);
    const job = await enqueue(h, q, a, agent.id);
    await q.claimNext({ workspaceId: a, agentId: agent.id });
    const many = Array.from({ length: 501 }, (_, i) => line(i));
    expect(await storeErr(q.appendLogs({ workspaceId: a, agentId: agent.id, jobId: job.id, batchSeq: 1, lines: many })), h.name).toBe("invalid_input");
    expect(await storeErr(q.appendLogs({ workspaceId: a, agentId: agent.id, jobId: job.id, batchSeq: 1, lines: [{ ...line(1), stream: "nope" as never }] })), h.name).toBe("invalid_input");
    expect(await q.appendLogs({ workspaceId: a, agentId: other.id, jobId: job.id, batchSeq: 1, lines: [line(1)] }), h.name).toBeNull();
    expect(await q.appendLogs({ workspaceId: ws(), agentId: agent.id, jobId: job.id, batchSeq: 1, lines: [line(1)] }), h.name).toBeNull();
    expect(await q.listLogs({ workspaceId: ws(), jobId: job.id }), h.name).toEqual([]);
    expect(await q.logUsage(ws(), job.id), h.name).toEqual({ lines: 0, bytes: 0 });
  }));

  it("truncates a line to 8192 characters", each(async (h, q) => {
    const a = ws();
    const agent = await enrol(h, kind, a);
    const job = await enqueue(h, q, a, agent.id);
    await q.claimNext({ workspaceId: a, agentId: agent.id });
    await q.appendLogs({ workspaceId: a, agentId: agent.id, jobId: job.id, batchSeq: 1, lines: [{ ts: new Date(T0).toISOString(), stream: "stdout", line: "x".repeat(9000) }] });
    expect((await q.listLogs({ workspaceId: a, jobId: job.id }))[0].line, h.name).toHaveLength(8192);
  }));
});

describe("transport targets are not agents (platform store)", () => {
  it("a non-zenithd machine target can neither authenticate nor be revoked through the runner plane", async () => {
    const h = harnesses[1];
    const w = ws();
    const { repos } = await import("@/lib/controlplane/db");
    const target = await repos.machines.upsertTarget(dbPlane.db, { workspaceId: w, name: "i-0abc", transport: "aws_ssm", targetId: "i-0abc" });
    expect(await h.store.machines.findForAuth(target.id)).toBeNull();
    expect(await h.store.machines.get(w, target.id)).toBeNull();
    expect(await h.store.machines.revoke(w, target.id)).toBeNull();
    expect((await repos.machines.getMachine(dbPlane.db, w, target.id))?.status, "untouched").not.toBe("revoked");
    expect(await h.store.machines.list(w)).toEqual([]);
  });
});
