/**
 * The runner plane end to end on the REAL platform store (PGlite — the same SQL production runs), not the
 * in-memory one: token → registration → signed poll (SKIP LOCKED claim) → AWS SDK call relayed through a
 * runner → sealed result in `jsonb` → await → logs → revoke. What the contract suite proves per method,
 * this proves in composition, including what the database itself refuses.
 */
import { DescribeServicesCommand, ECSClient } from "@aws-sdk/client-ecs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as logsRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/logs/route";
import { POST as resultRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/result/route";
import { POST as heartbeatRunner } from "@/app/api/platform/v1/runners/[id]/heartbeat/route";
import { POST as pollRunner } from "@/app/api/platform/v1/runners/[id]/poll/route";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import { createRunnerAwsSessionClientFactory } from "@/lib/runners/aws-runner-transport";
import { awaitRunnerJob } from "@/lib/runners/dispatch";
import { reapExpiredJobs, revokeAgent } from "@/lib/runners/service";
import { FakeAgent, FakeRunnerService, createPlane, enqueueProbeJob, openDbPlane, registerFakeAgent, runnerGrant, teardownPlane, type DbPlane, type Plane } from "./_support";

let db: DbPlane;
beforeAll(async () => {
  db = await openDbPlane();
});
afterAll(async () => db.close());

let plane: Plane;
let agent: FakeAgent;
let operationId: string;
let service: FakeRunnerService | undefined;
beforeEach(async () => {
  plane = await createPlane("real", {}, db.store);
  agent = await registerFakeAgent(plane, registerRunner, { workspaceId: "w-e2e" });
  operationId = await db.operation("w-e2e");
});
afterEach(async () => {
  await service?.stop().catch(() => undefined);
  service = undefined;
  teardownPlane();
});

describe("platform store, end to end", () => {
  it("relays an AWS SDK call through a registered runner and back through real SQL", async () => {
    service = new FakeRunnerService(agent, { poll: pollRunner, result: resultRunner }, (job) => {
      const p = job.claims.payload as { service: string; url: string; headers: Record<string, string> };
      expect(p).toMatchObject({ service: "ecs", url: "https://ecs.us-east-1.amazonaws.com/" });
      expect(Object.keys(p.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
      return {
        status: "succeeded",
        result: { status: 200, headers: { "content-type": "application/x-amz-json-1.1" }, bodyB64: Buffer.from(JSON.stringify({ services: [{ serviceName: "web", desiredCount: 2 }], failures: [] })).toString("base64") },
      };
    }).start();
    const grant = await runnerGrant(plane, { runnerId: agent.id, workspaceId: "w-e2e", operationId, capability: "infrastructure.observe" });
    const ecs = createRunnerAwsSessionClientFactory({ runnerId: agent.id, workspaceId: "w-e2e", operationId, grant, region: "us-east-1", queueTtlSec: 30 })(ECSClient);
    const out = await ecs.send(new DescribeServicesCommand({ services: ["web"] }));
    expect(out.services?.[0]).toMatchObject({ serviceName: "web", desiredCount: 2 });
    const [job] = await db.store.jobs.listForOperation("w-e2e", operationId);
    expect(job).toMatchObject({ status: "succeeded", kind: "aws.http", agentId: agent.id });
    // the database holds the result SEALED: the ECS response body is nowhere in the row
    const raw = await db.db.query("select result::text as r, envelope from platform.runner_jobs where id = $1", [job.id]);
    expect(String(raw[0].r)).not.toContain("serviceName");
    expect(String(raw[0].r)).toContain("A256GCM");
    expect(String(raw[0].envelope).split(".")).toHaveLength(3); // the signed envelope is a compact JWS
  });

  it("registration, nonces and heartbeats are real rows: a replayed request is refused, a heartbeat is recorded", async () => {
    const body = JSON.stringify({ version: "9.9.9" });
    const req = agent.request("POST", agent.path("/heartbeat"), body);
    const replay = agent.request("POST", agent.path("/heartbeat"), body, { nonce: req.headers.get("x-zenith-nonce")!, timestamp: Number(req.headers.get("x-zenith-timestamp")) });
    const { call } = await import("./_support");
    expect((await call(heartbeatRunner, req, { id: agent.id })).status).toBe(200);
    const again = await call(heartbeatRunner, replay, { id: agent.id });
    expect(again.status).toBe(401);
    expect(again.body.error?.code).toBe("nonce_replayed");
    expect((await db.store.runners.get("w-e2e", agent.id))?.version).toBe("9.9.9");
    const rows = await db.db.query("select count(*)::int as n from platform.agent_nonces where agent_id = $1", [agent.id]);
    expect(rows[0].n).toBe(1);
  });

  it("the token is consumed in the same transaction that creates the runner, and only its hash is stored", async () => {
    const rows = await db.db.query<{ token_hash: string; used_by: string | null }>("select token_hash, used_by from platform.runner_registration_tokens where used_by = $1", [agent.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_hash).not.toMatch(/^z[rm]t_/);
  });

  it("exclusive claims hold under concurrent polls on the real database", async () => {
    const op = await db.operation("w-e2e");
    const queued = await Promise.all(Array.from({ length: 6 }, (_, i) => enqueueProbeJob(plane, agent, { operationId: op, port: 3100 + i })));
    const polls = await Promise.all(Array.from({ length: 8 }, () => agent.post(pollRunner, "/poll", { max: 2, waitSec: 0 })));
    const delivered = polls.flatMap((r) => (r.body.jobs as string[]).map((t) => String(agent.decodeJob(t, "zenith-job+jwt").claims.jti)));
    expect(new Set(delivered).size).toBe(delivered.length);
    expect([...delivered].sort()).toEqual([...queued].sort());
  });

  it("enqueue for an operation that does not exist is refused by the database (the foreign key), surfaced as agent_not_found", async () => {
    await expect(enqueueProbeJob(plane, agent, { operationId: "op_does_not_exist" })).rejects.toMatchObject({ code: "agent_not_found" });
  });

  it("logs: redacted, idempotent, and closed after the result — against real tables", async () => {
    const op = await db.operation("w-e2e");
    const id = await enqueueProbeJob(plane, agent, { operationId: op });
    await agent.post(pollRunner, "/poll", { max: 1, waitSec: 0 });
    const lines = [{ stream: "stdout", line: "using AKIAIOSFODNN7EXAMPLE" }, { stream: "stderr", line: "plain line" }, ...Array.from({ length: 600 }, (_, i) => ({ stream: "info", line: `bulk ${i}` }))];
    const first = await agent.post(logsRunner, `/jobs/${id}/logs`, { seq: 1, lines }, {}, { jti: id });
    expect(first.body).toEqual({ stored: 602, truncated: false }); // 602 lines > the store's 500 per append: sub-batched
    expect((await agent.post(logsRunner, `/jobs/${id}/logs`, { seq: 1, lines }, {}, { jti: id })).body).toMatchObject({ stored: 0 });
    const stored = await db.store.jobs.listLogs({ workspaceId: "w-e2e", jobId: id, limit: 1000 });
    expect(stored).toHaveLength(602);
    expect(stored.map((l) => l.line).join("\n")).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(await db.store.jobs.logUsage("w-e2e", id)).toMatchObject({ lines: 602 });
    await agent.post(resultRunner, `/jobs/${id}/result`, { status: "succeeded", result: {} }, {}, { jti: id });
    expect((await agent.post(logsRunner, `/jobs/${id}/logs`, { seq: 2, lines: [{ stream: "info", line: "late" }] }, {}, { jti: id })).status).toBe(409);
  });

  it("a result whose error text looks like a secret to the store still settles the job, with the text withheld", async () => {
    const op = await db.operation("w-e2e");
    const id = await enqueueProbeJob(plane, agent, { operationId: op });
    await agent.post(pollRunner, "/poll", { max: 1, waitSec: 0 });
    const res = await agent.post(resultRunner, `/jobs/${id}/result`, { status: "failed", error: "charge failed for sk_" + "live_abcdefghijklmnop12345678" }, {}, { jti: id });
    expect(res.status).toBe(200);
    const row = await db.store.jobs.get("w-e2e", id);
    expect(row?.status).toBe("failed");
    expect(row?.error).not.toContain("sk_live_");
    expect(row?.error).toBe("charge failed for [REDACTED:payment-secret-key]");
    expect((await agent.post(resultRunner, `/jobs/${id}/result`, { status: "succeeded" }, {}, { jti: id })).status).toBe(409);
  });

  it("revoke cancels queued work in SQL, the reaper times out a silent running job, and nothing is re-queued", async () => {
    const op1 = await db.operation("w-e2e");
    const running = await enqueueProbeJob(plane, agent, { operationId: op1, timeoutSec: 30 });
    await agent.post(pollRunner, "/poll", { max: 1, waitSec: 0 });
    const op2 = await db.operation("w-e2e");
    const queued = await enqueueProbeJob(plane, agent, { operationId: op2 });
    const res = await revokeAgent(plane.rt, "runner", "w-e2e", agent.id, "user-admin");
    expect(res).toEqual({ id: agent.id, status: "revoked", cancelledJobs: 1 });
    expect((await db.store.jobs.get("w-e2e", queued))?.status).toBe("cancelled");
    expect((await db.store.jobs.get("w-e2e", running))?.status).toBe("running"); // the runner may still be executing it
    // a heartbeat from the revoked runner is told to stop
    expect((await agent.post(heartbeatRunner, "/heartbeat", {})).body.error?.code).toBe("agent_revoked");
    // force the running job's lease to lapse and reap: timed_out, which the caller reconciles to `uncertain`
    await db.db.query("update platform.runner_jobs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [running]);
    const reaped = await reapExpiredJobs(plane.rt);
    expect(reaped.runnerJobs.map((j) => [j.id, j.status])).toEqual([[running, "timed_out"]]);
    expect(await awaitRunnerJob(running, { workspaceId: "w-e2e" })).toMatchObject({ status: "timed_out", uncertain: true });
    expect(await db.store.jobs.claimNext({ workspaceId: "w-e2e", agentId: agent.id })).toEqual([]);
  });
});
