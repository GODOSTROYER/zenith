/**
 * Runners, registration tokens, jobs (SKIP LOCKED claim, settle-once), job
 * logs, agent nonces (replay protection) and the machine registry.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { LANES, backdate, expectCode, newWorkspace, openLane, seedApprovedOperation, uid } from "./_support/harness";
import type { PlatformDbHandle } from "@/lib/controlplane/db";

const KEY = "A".repeat(43); // 43 base64url chars = a raw 32-byte key

describe.each(LANES)("runners and agents [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(lane);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });
  const db = () => ctx.db;

  async function registeredRunner(ws: string = newWorkspace(), handle: PlatformDbHandle = ctx.db) {
    const { token, tokenHash } = repos.runners.generateRegistrationToken("runner");
    await repos.runners.createRegistrationToken(handle, { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash });
    const runner = await repos.runners.registerRunner(handle, { tokenHash, name: "vpc-runner", publicKey: KEY, version: "1.0.0", capabilities: ["tofu.run"] });
    return { ws, runner, token, tokenHash };
  }

  async function enqueue(ws: string, runnerId: string, over: { ttlMs?: number; id?: string } = {}) {
    const { operation } = await seedApprovedOperation(db(), ws);
    return repos.jobs.enqueue(db(), { id: over.id ?? uid("job"), workspaceId: ws, runnerId, operationId: operation.id, kind: "tofu.run", capability: "infrastructure.apply", envelope: "eyJhbGciOiJFZERTQSJ9.payload.signature", ttlMs: over.ttlMs });
  }

  describe("registration tokens", () => {
    it("registers a runner, taking the workspace from the token, and consumes the token once", async () => {
      const ws = newWorkspace();
      const { token, tokenHash } = repos.runners.generateRegistrationToken("runner");
      expect(token).toMatch(/^zrt_/);
      expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
      const created = await repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash });
      expect(Date.parse(created.expiresAt)).toBeLessThanOrEqual(Date.now() + 61 * 60_000);

      const runner = await repos.runners.registerRunner(db(), { tokenHash, name: "r1", publicKey: KEY, capabilities: ["tofu.run", "aws.http"], labels: { region: "ap-south-1" } });
      expect(runner).toMatchObject({ workspaceId: ws, status: "active", name: "r1", capabilities: ["tofu.run", "aws.http"], labels: { region: "ap-south-1" }, stale: false });
      expect(runner.id).toMatch(/^run_/);
      await expectCode(repos.runners.registerRunner(db(), { tokenHash, name: "again", publicKey: KEY }), "invalid_registration_token");
      expect(await repos.runners.listRunners(db(), ws)).toHaveLength(1);
    });

    it("stores only the hash: the raw token appears nowhere in the table", async () => {
      const { token, tokenHash } = repos.runners.generateRegistrationToken("runner");
      await repos.runners.createRegistrationToken(db(), { workspaceId: newWorkspace(), kind: "runner", createdBy: "admin", tokenHash });
      const rows = await db().query<Record<string, unknown>>("select * from platform.runner_registration_tokens where token_hash = $1", [tokenHash]);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(token);
      await expectCode(repos.runners.createRegistrationToken(db(), { workspaceId: newWorkspace(), kind: "runner", createdBy: "admin", tokenHash: token }), "invalid_input");
    });

    it("refuses an expired token, a token of the wrong kind, an over-long lifetime and a bad public key", async () => {
      const ws = newWorkspace();
      const expired = repos.runners.generateRegistrationToken("runner");
      await repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash: expired.tokenHash });
      await db().query("update platform.runner_registration_tokens set expires_at = clock_timestamp() - interval '1 second' where token_hash = $1", [expired.tokenHash]);
      await expectCode(repos.runners.registerRunner(db(), { tokenHash: expired.tokenHash, name: "r", publicKey: KEY }), "invalid_registration_token");

      const machineToken = repos.runners.generateRegistrationToken("machine");
      await repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "machine", createdBy: "admin", tokenHash: machineToken.tokenHash });
      await expectCode(repos.runners.registerRunner(db(), { tokenHash: machineToken.tokenHash, name: "r", publicKey: KEY }), "invalid_registration_token");

      const long = repos.runners.generateRegistrationToken("runner");
      await expectCode(repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash: long.tokenHash, ttlMs: 2 * 60 * 60 * 1000 }), "invalid_input");

      const ok = repos.runners.generateRegistrationToken("runner");
      await repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash: ok.tokenHash });
      await expectCode(repos.runners.registerRunner(db(), { tokenHash: ok.tokenHash, name: "r", publicKey: "short" }), "invalid_input");
      // the failed attempt (bad key) did not burn the token
      await repos.runners.registerRunner(db(), { tokenHash: ok.tokenHash, name: "r", publicKey: KEY });
    });

    it("a failed registration leaves the token unused (consume and insert are one transaction)", async () => {
      const ws = newWorkspace();
      const { tokenHash } = repos.runners.generateRegistrationToken("runner");
      await repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash });
      const id = uid("run");
      await repos.runners.registerRunner(db(), { tokenHash, id, name: "first", publicKey: KEY });
      const t2 = repos.runners.generateRegistrationToken("runner");
      await repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash: t2.tokenHash });
      // duplicate primary key on the runner insert → whole registration rolls back
      await expect(repos.runners.registerRunner(db(), { tokenHash: t2.tokenHash, id, name: "dup", publicKey: KEY })).rejects.toMatchObject({ sqlstate: "23505" });
      const rows = await db().query<{ used_at: string | null }>("select used_at from platform.runner_registration_tokens where token_hash = $1", [t2.tokenHash]);
      expect(rows[0].used_at).toBeNull();
    });

    it("racing registrations with one token: exactly one runner is created", async () => {
      const ws = newWorkspace();
      const { tokenHash } = repos.runners.generateRegistrationToken("runner");
      await repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash });
      const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => repos.runners.registerRunner(i % 2 ? ctx.db : ctx.db2, { tokenHash, name: `r${i}`, publicKey: KEY })));
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(await repos.runners.listRunners(db(), ws)).toHaveLength(1);
    });
  });

  describe("runner registry", () => {
    it("is workspace scoped; findRunnerForAuth is the one lookup by id alone", async () => {
      const { ws, runner } = await registeredRunner();
      expect((await repos.runners.getRunner(db(), ws, runner.id))?.id).toBe(runner.id);
      expect(await repos.runners.getRunner(db(), newWorkspace(), runner.id)).toBeNull();
      expect(await repos.runners.listRunners(db(), newWorkspace())).toEqual([]);
      const auth = await repos.runners.findRunnerForAuth(db(), runner.id);
      expect(auth?.workspaceId).toBe(ws);
      expect(auth?.publicKey).toBe(KEY);
      expect(await repos.runners.findRunnerForAuth(db(), "run_unknown")).toBeNull();
    });

    it("heartbeats, derives staleness on the database clock, and tells a revoked runner to stop", async () => {
      const { ws, runner } = await registeredRunner();
      expect((await repos.runners.getRunner(db(), ws, runner.id))?.stale).toBe(false);
      await db().query("update platform.runners set registered_at = clock_timestamp() - interval '5 minutes', last_heartbeat_at = null where id = $1", [runner.id]);
      expect((await repos.runners.getRunner(db(), ws, runner.id))?.stale).toBe(true);
      expect(await repos.runners.heartbeat(db(), { workspaceId: ws, id: runner.id, version: "1.0.1" })).toEqual({ revoked: false });
      const fresh = await repos.runners.getRunner(db(), ws, runner.id);
      expect(fresh).toMatchObject({ stale: false, version: "1.0.1" });
      expect(fresh?.lastHeartbeatAt).toBeDefined();
      expect(await repos.runners.heartbeat(db(), { workspaceId: newWorkspace(), id: runner.id })).toBeNull();

      const revoked = await repos.runners.revokeRunner(db(), ws, runner.id);
      expect(revoked?.runner.status).toBe("revoked");
      expect(revoked?.runner.stale).toBe(false);
      expect(await repos.runners.heartbeat(db(), { workspaceId: ws, id: runner.id })).toEqual({ revoked: true });
      expect(await repos.runners.revokeRunner(db(), newWorkspace(), runner.id)).toBeNull();
    });
  });

  describe("jobs", () => {
    it("enqueues only for an active runner and an operation of the same workspace", async () => {
      const { ws, runner } = await registeredRunner();
      const { operation } = await seedApprovedOperation(db(), ws);
      const base = { workspaceId: ws, runnerId: runner.id, operationId: operation.id, kind: "tofu.run", capability: "infrastructure.apply", envelope: "a.b.c" };
      const job = await repos.jobs.enqueue(db(), { ...base, id: uid("job") });
      expect(job).toMatchObject({ status: "queued", runnerId: runner.id, operationId: operation.id });
      await expectCode(repos.jobs.enqueue(db(), { ...base, id: uid("job"), workspaceId: newWorkspace() }), "not_found");
      await expectCode(repos.jobs.enqueue(db(), { ...base, id: uid("job"), operationId: (await seedApprovedOperation(db())).operation.id }), "not_found");
      await expectCode(repos.jobs.enqueue(db(), { ...base, id: uid("job"), envelope: "" }), "invalid_input");
      await repos.runners.revokeRunner(db(), ws, runner.id);
      await expectCode(repos.jobs.enqueue(db(), { ...base, id: uid("job") }), "not_found");
    });

    it("claimNext hands each job to exactly one of many concurrent pollers (SKIP LOCKED), oldest first", async () => {
      const { ws, runner } = await registeredRunner();
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) ids.push((await enqueue(ws, runner.id)).id);
      const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? ctx.db : ctx.db2).tx((tx) => repos.jobs.claimNext(tx, { workspaceId: ws, runnerId: runner.id, max: 2 }))));
      const all = claims.flat();
      expect(all).toHaveLength(8);
      expect(new Set(all.map((j) => j.id)).size).toBe(8);
      expect(all.every((j) => j.status === "claimed" && j.leaseUntil && j.claimedAt)).toBe(true);
      expect(new Set(all.map((j) => j.id))).toEqual(new Set(ids));
      expect(await repos.jobs.claimNext(db(), { workspaceId: ws, runnerId: runner.id })).toEqual([]);

      // single claims come back oldest first
      const { ws: ws2, runner: r2 } = await registeredRunner();
      const order: string[] = [];
      for (let i = 0; i < 3; i++) order.push((await enqueue(ws2, r2.id)).id);
      const got: string[] = [];
      for (let i = 0; i < 3; i++) got.push((await repos.jobs.claimNext(db(), { workspaceId: ws2, runnerId: r2.id }))[0].id);
      expect(got).toEqual(order);
    });

    it("never hands out a job to another runner, another workspace, a revoked runner, or past its expiry", async () => {
      const { ws, runner } = await registeredRunner();
      const other = await registeredRunner(ws);
      const job = await enqueue(ws, runner.id);
      expect(await repos.jobs.claimNext(db(), { workspaceId: ws, runnerId: other.runner.id })).toEqual([]);
      expect(await repos.jobs.claimNext(db(), { workspaceId: newWorkspace(), runnerId: runner.id })).toEqual([]);
      await backdate(db(), "runner_jobs", "expires_at", job.id);
      expect(await repos.jobs.claimNext(db(), { workspaceId: ws, runnerId: runner.id })).toEqual([]);

      const { ws: ws3, runner: r3 } = await registeredRunner();
      await enqueue(ws3, r3.id);
      await db().query("update platform.runners set status = 'revoked' where id = $1", [r3.id]);
      expect(await repos.jobs.claimNext(db(), { workspaceId: ws3, runnerId: r3.id })).toEqual([]);
    });

    it("settle is first-writer-wins: the second result — a duplicate or a conflicting one — gets false", async () => {
      const { ws, runner } = await registeredRunner();
      const job = await enqueue(ws, runner.id);
      await repos.jobs.claimNext(db(), { workspaceId: ws, runnerId: runner.id });
      const base = { workspaceId: ws, runnerId: runner.id, jobId: job.id };
      expect(await repos.jobs.settle(db(), { ...base, status: "succeeded", result: { exitCode: 0 } })).toBe(true);
      expect(await repos.jobs.settle(db(), { ...base, status: "succeeded", result: { exitCode: 0 } })).toBe(false);
      expect(await repos.jobs.settle(db(), { ...base, status: "failed", error: "late" })).toBe(false);
      const stored = await repos.jobs.get(db(), ws, job.id);
      expect(stored).toMatchObject({ status: "succeeded", result: { exitCode: 0 } });
      expect(stored?.settledAt).toBeDefined();
    });

    it("racing settles of one job: exactly one wins", async () => {
      const { ws, runner } = await registeredRunner();
      const job = await enqueue(ws, runner.id);
      await repos.jobs.claimNext(db(), { workspaceId: ws, runnerId: runner.id });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => (i % 2 ? ctx.db : ctx.db2).tx((tx) => repos.jobs.settle(tx, { workspaceId: ws, runnerId: runner.id, jobId: job.id, status: i % 3 ? "succeeded" : "failed" })))
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("refuses to settle a job that is queued, another runner's, another workspace's, or given an invalid status or a secret", async () => {
      const { ws, runner } = await registeredRunner();
      const other = await registeredRunner(ws);
      const job = await enqueue(ws, runner.id);
      const base = { workspaceId: ws, runnerId: runner.id, jobId: job.id, status: "succeeded" as const };
      expect(await repos.jobs.settle(db(), base)).toBe(false); // still queued: nobody claimed it
      await repos.jobs.claimNext(db(), { workspaceId: ws, runnerId: runner.id });
      expect(await repos.jobs.settle(db(), { ...base, runnerId: other.runner.id })).toBe(false);
      expect(await repos.jobs.settle(db(), { ...base, workspaceId: newWorkspace() })).toBe(false);
      await expectCode(repos.jobs.settle(db(), { ...base, status: "queued" as never }), "invalid_input");
      await expectCode(repos.jobs.settle(db(), { ...base, result: { note: "-----BEGIN RSA PRIVATE KEY-----\nabc" } }), "secret_material");
      expect((await repos.jobs.get(db(), ws, job.id))?.status).toBe("claimed");
      expect(await repos.jobs.settle(db(), base)).toBe(true);
    });

    it("the reaper times out silent jobs and expires unclaimed ones; a late result is then refused; nothing is re-queued", async () => {
      const { ws, runner } = await registeredRunner();
      const silent = await enqueue(ws, runner.id);
      const unclaimed = await enqueue(ws, runner.id);
      await repos.jobs.claimNext(db(), { workspaceId: ws, runnerId: runner.id });
      expect((await repos.jobs.get(db(), ws, silent.id))?.status).toBe("claimed");
      // one job claimed (the older), one still queued
      await backdate(db(), "runner_jobs", "lease_until", silent.id);
      await backdate(db(), "runner_jobs", "expires_at", unclaimed.id);
      const reaped = await repos.jobs.expireStale(db(), 1000);
      const byId = new Map(reaped.map((j) => [j.id, j]));
      expect(byId.get(silent.id)?.status).toBe("timed_out");
      expect(byId.get(unclaimed.id)?.status).toBe("expired");
      expect(await repos.jobs.settle(db(), { workspaceId: ws, runnerId: runner.id, jobId: silent.id, status: "succeeded" })).toBe(false);
      expect(await repos.jobs.claimNext(db(), { workspaceId: ws, runnerId: runner.id })).toEqual([]);
      expect((await repos.jobs.expireStale(db(), 1000)).map((j) => j.id)).not.toContain(silent.id);
    });

    it("markRunning extends the lease of the claiming runner only; cancel stops unsettled jobs", async () => {
      const { ws, runner } = await registeredRunner();
      const job = await enqueue(ws, runner.id);
      await repos.jobs.claimNext(db(), { workspaceId: ws, runnerId: runner.id });
      expect(await repos.jobs.markRunning(db(), { workspaceId: ws, runnerId: "run_other", jobId: job.id, leaseMs: 60_000 })).toBe(false);
      expect(await repos.jobs.markRunning(db(), { workspaceId: ws, runnerId: runner.id, jobId: job.id, leaseMs: 600_000 })).toBe(true);
      const running = await repos.jobs.get(db(), ws, job.id);
      expect(running?.status).toBe("running");
      expect(Date.parse(running!.leaseUntil!)).toBeGreaterThan(Date.now() + 300_000);
      expect((await repos.jobs.cancel(db(), ws, job.id, "operator cancelled"))?.status).toBe("cancelled");
      expect(await repos.jobs.cancel(db(), ws, job.id)).toBeNull();
      expect(await repos.jobs.settle(db(), { workspaceId: ws, runnerId: runner.id, jobId: job.id, status: "succeeded" })).toBe(false);
    });

    it("revoking a runner cancels its queued and claimed jobs but leaves a running one for the reaper", async () => {
      const { ws, runner } = await registeredRunner();
      const queued = await enqueue(ws, runner.id);
      const claimed = await enqueue(ws, runner.id);
      const running = await enqueue(ws, runner.id);
      await repos.jobs.claimNext(db(), { workspaceId: ws, runnerId: runner.id, max: 2 }); // queued + claimed → claimed
      await db().query("update platform.runner_jobs set status = 'queued', claimed_at = null, lease_until = null where id = $1", [queued.id]);
      await db().query("update platform.runner_jobs set status = 'running', started_at = clock_timestamp() where id = $1", [running.id]);
      const result = await repos.runners.revokeRunner(db(), ws, runner.id);
      expect(result?.cancelledJobs).toBeGreaterThanOrEqual(2);
      expect((await repos.jobs.get(db(), ws, queued.id))?.status).toBe("cancelled");
      expect((await repos.jobs.get(db(), ws, claimed.id))?.status).toBe("cancelled");
      expect((await repos.jobs.get(db(), ws, running.id))?.status).toBe("running");
    });

    it("job reads are workspace scoped", async () => {
      const { ws, runner } = await registeredRunner();
      const job = await enqueue(ws, runner.id);
      expect(await repos.jobs.get(db(), newWorkspace(), job.id)).toBeNull();
      expect(await repos.jobs.listForOperation(db(), newWorkspace(), job.operationId)).toEqual([]);
      expect((await repos.jobs.listForOperation(db(), ws, job.operationId)).map((j) => j.id)).toEqual([job.id]);
      expect(await repos.jobs.cancel(db(), newWorkspace(), job.id)).toBeNull();
    });
  });

  describe("job logs", () => {
    it("appends batches idempotently, truncates long lines, withholds secret-shaped lines, and pages by id", async () => {
      const { ws, runner } = await registeredRunner();
      const job = await enqueue(ws, runner.id);
      const at = new Date().toISOString();
      const lines = [
        { ts: at, stream: "stdout" as const, line: "planning" },
        { ts: at, stream: "stderr" as const, line: "x".repeat(9000) },
        { ts: at, stream: "info" as const, line: "AWS_KEY=AKIAABCDEFGHIJKLMNOP" },
      ];
      const input = { workspaceId: ws, runnerId: runner.id, jobId: job.id, batchSeq: 1, lines };
      expect(await repos.jobs.appendLogs(db(), input)).toBe(3);
      expect(await repos.jobs.appendLogs(db(), input)).toBe(0); // a retried POST adds nothing
      expect(await repos.jobs.appendLogs(db(), { ...input, batchSeq: 2, lines: [{ ts: at, stream: "stdout", line: "done" }] })).toBe(1);

      const all = await repos.jobs.listLogs(db(), { workspaceId: ws, jobId: job.id });
      expect(all.map((l) => l.line.length)).toEqual([8, 8192, "[line withheld: it matched a secret pattern]".length, 4]);
      expect(all[2].line).not.toContain("AKIA");
      const rest = await repos.jobs.listLogs(db(), { workspaceId: ws, jobId: job.id, afterId: all[1].id });
      expect(rest.map((l) => l.line)).toEqual([all[2].line, "done"]);
      expect(await repos.jobs.listLogs(db(), { workspaceId: newWorkspace(), jobId: job.id })).toEqual([]);
    });

    it("only the runner that owns the job, in its workspace, may append", async () => {
      const { ws, runner } = await registeredRunner();
      const other = await registeredRunner(ws);
      const job = await enqueue(ws, runner.id);
      const lines = [{ ts: new Date().toISOString(), stream: "stdout" as const, line: "x" }];
      expect(await repos.jobs.appendLogs(db(), { workspaceId: ws, runnerId: other.runner.id, jobId: job.id, batchSeq: 1, lines })).toBeNull();
      expect(await repos.jobs.appendLogs(db(), { workspaceId: newWorkspace(), runnerId: runner.id, jobId: job.id, batchSeq: 1, lines })).toBeNull();
      await expectCode(repos.jobs.appendLogs(db(), { workspaceId: ws, runnerId: runner.id, jobId: job.id, batchSeq: 1, lines: [{ ...lines[0], stream: "audit" as never }] }), "invalid_input");
    });
  });

  describe("agent nonces", () => {
    it("accepts a nonce once, rejects the replay, and is scoped per agent", async () => {
      const agentId = uid("run");
      const nonce = uid("n");
      expect(await repos.nonces.remember(db(), agentId, nonce)).toBe(true);
      expect(await repos.nonces.remember(db(), agentId, nonce)).toBe(false);
      expect(await repos.nonces.remember(db(), uid("run"), nonce)).toBe(true);
    });

    it("a nonce older than the ten-minute window is treated as unseen; recent replays stay rejected", async () => {
      const agentId = uid("run");
      const nonce = uid("n");
      await repos.nonces.remember(db(), agentId, nonce);
      expect(await repos.nonces.remember(db(), agentId, nonce)).toBe(false);
      await db().query("update platform.agent_nonces set seen_at = clock_timestamp() - interval '11 minutes' where agent_id = $1", [agentId]);
      expect(await repos.nonces.remember(db(), agentId, nonce)).toBe(true);
      expect(await repos.nonces.remember(db(), agentId, nonce)).toBe(false);
    });

    it("racing requests with one nonce: exactly one is accepted", async () => {
      const agentId = uid("run");
      const nonce = uid("n");
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? ctx.db : ctx.db2).tx((tx) => repos.nonces.remember(tx, agentId, nonce))));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("prune removes only nonces past the retention age", async () => {
      const agentId = uid("run");
      await repos.nonces.remember(db(), agentId, "old");
      await repos.nonces.remember(db(), agentId, "new");
      await db().query("update platform.agent_nonces set seen_at = clock_timestamp() - interval '1 hour' where agent_id = $1 and nonce = 'old'", [agentId]);
      expect(await repos.nonces.prune(db())).toBeGreaterThanOrEqual(1);
      const left = await db().query<{ nonce: string }>("select nonce from platform.agent_nonces where agent_id = $1", [agentId]);
      expect(left.map((r) => r.nonce)).toEqual(["new"]);
      await expectCode(repos.nonces.remember(db(), "", "n"), "invalid_input");
    });
  });

  describe("machines", () => {
    it("registers a zenithd machine from a machine token (binding from the token), and refuses reuse", async () => {
      const ws = newWorkspace();
      const { tokenHash } = repos.runners.generateRegistrationToken("machine");
      await repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "machine", createdBy: "admin", tokenHash, binding: { environmentId: "env_1", address: "compute_instance/worker-1" } });
      const machine = await repos.machines.registerMachine(db(), { tokenHash, name: "worker-1", publicKey: KEY, capabilities: ["service.status"] });
      expect(machine).toMatchObject({ workspaceId: ws, environmentId: "env_1", address: "compute_instance/worker-1", transport: "zenithd", status: "active", stale: false });
      expect(machine.targetId).toBe(machine.id);
      await expectCode(repos.machines.registerMachine(db(), { tokenHash, name: "again", publicKey: KEY }), "invalid_registration_token");
      expect((await repos.machines.findMachineForAuth(db(), machine.id))?.workspaceId).toBe(ws);
      expect(await repos.machines.getMachine(db(), newWorkspace(), machine.id)).toBeNull();
      expect(await repos.machines.listMachines(db(), newWorkspace())).toEqual([]);
      expect(await repos.machines.heartbeatMachine(db(), { workspaceId: ws, id: machine.id })).toEqual({ revoked: false });
      expect((await repos.machines.revokeMachine(db(), ws, machine.id))?.status).toBe("revoked");
      expect(await repos.machines.heartbeatMachine(db(), { workspaceId: ws, id: machine.id })).toEqual({ revoked: true });
      expect(await repos.machines.revokeMachine(db(), newWorkspace(), machine.id)).toBeNull();
    });

    it("a runner token cannot register a machine, and a machine token binding may not hold secrets", async () => {
      const ws = newWorkspace();
      const runnerToken = repos.runners.generateRegistrationToken("runner");
      await repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash: runnerToken.tokenHash });
      await expectCode(repos.machines.registerMachine(db(), { tokenHash: runnerToken.tokenHash, name: "m", publicKey: KEY }), "invalid_registration_token");
      await expectCode(
        repos.runners.createRegistrationToken(db(), { workspaceId: ws, kind: "machine", createdBy: "admin", tokenHash: repos.runners.generateRegistrationToken("machine").tokenHash, binding: { apiToken: "x" } }),
        "secret_material"
      );
    });

    it("upserts transport targets by (workspace, transport, target id) and keeps them workspace scoped", async () => {
      const ws = newWorkspace();
      const a = await repos.machines.upsertTarget(db(), { workspaceId: ws, environmentId: "env_1", name: "web-1", transport: "aws_ssm", targetId: "i-0abc" });
      const b = await repos.machines.upsertTarget(db(), { workspaceId: ws, name: "web-1-renamed", transport: "aws_ssm", targetId: "i-0abc", labels: { role: "web" } });
      expect(b.id).toBe(a.id);
      expect(b).toMatchObject({ name: "web-1-renamed", environmentId: "env_1", labels: { role: "web" }, stale: false });
      const other = await repos.machines.upsertTarget(db(), { workspaceId: newWorkspace(), name: "x", transport: "aws_ssm", targetId: "i-0abc" });
      expect(other.id).not.toBe(a.id);
      expect((await repos.machines.listMachines(db(), ws)).map((m) => m.id)).toEqual([a.id]);
      expect((await repos.machines.listMachines(db(), ws, { transport: "kubernetes" }))).toEqual([]);
      await expectCode(repos.machines.upsertTarget(db(), { workspaceId: ws, name: "n", transport: "zenithd" as never, targetId: "t" }), "invalid_input");
    });
  });
});
