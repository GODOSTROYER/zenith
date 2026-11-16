/**
 * Poll, heartbeat and job delivery (docs/platform/RUNNER-PROTOCOL.md sections 4-6), through the route
 * handlers, with a fake agent that verifies every job the way the Go agent does (pinned key, typ, claims).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as heartbeatMachine } from "@/app/api/platform/v1/machines/[id]/heartbeat/route";
import { POST as pollMachine } from "@/app/api/platform/v1/machines/[id]/poll/route";
import { POST as registerMachine } from "@/app/api/platform/v1/machines/register/route";
import { POST as heartbeatRunner } from "@/app/api/platform/v1/runners/[id]/heartbeat/route";
import { POST as pollRunner } from "@/app/api/platform/v1/runners/[id]/poll/route";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import { enqueueMachineRequest, enqueueRunnerJob } from "@/lib/runners/dispatch";
import { configureRunnerRuntime } from "@/lib/runners/runtime";
import { LEASE_GRACE_SEC } from "@/lib/runners/types";
import { FakeAgent, OPERATION, createPlane, newSigner, registerFakeAgent, runnerGrant, issueGrant, teardownPlane, type Plane } from "./_support";

let plane: Plane;
let runner: FakeAgent;
beforeEach(async () => {
  plane = await createPlane("fake");
  runner = await registerFakeAgent(plane, registerRunner);
});
afterEach(teardownPlane);

async function enqueueProbe(agent: FakeAgent = runner, over: { timeoutSec?: number; queueTtlSec?: number; port?: number; operationId?: string } = {}): Promise<string> {
  const operationId = over.operationId ?? OPERATION;
  return enqueueRunnerJob({
    workspaceId: agent.workspaceId,
    runnerId: agent.id,
    operationId,
    capability: "infrastructure.observe",
    kind: "probe.tcp",
    payload: { host: "10.0.0.1", port: over.port ?? 22, timeoutMs: 2000 },
    grant: await runnerGrant(plane, { runnerId: agent.id, workspaceId: agent.workspaceId, operationId, capability: "infrastructure.observe" }),
    timeoutSec: over.timeoutSec,
    queueTtlSec: over.queueTtlSec,
  });
}

const poll = (agent: FakeAgent, body: unknown = { max: 1, waitSec: 0 }, handler: unknown = pollRunner) => agent.post(handler, "/poll", body);

describe("delivery of a signed job", () => {
  it("returns compact JWS jobs that verify with the published key, typ zenith-job+jwt, with every envelope field", async () => {
    const jobId = await enqueueProbe();
    const res = await poll(runner);
    expect(res.status).toBe(200);
    expect(res.body.pollIntervalSec).toBe(5);
    const jobs = res.body.jobs as string[];
    expect(jobs).toHaveLength(1);

    const job = runner.decodeJob(jobs[0], "zenith-job+jwt"); // throws on a bad signature, unpinned kid or wrong typ
    expect(Object.keys(job.header).sort()).toEqual(["alg", "kid", "typ"]); // the Go decoder refuses any other member
    expect(job.header).toMatchObject({ alg: "EdDSA", kid: plane.cpKeys[0].kid });
    const iat = Math.floor(plane.rt.now() / 1000);
    expect(job.claims).toEqual({
      protocol: "zenith.runner/v1",
      jti: jobId,
      runnerId: runner.id,
      workspaceId: "w-a",
      operationId: OPERATION,
      capability: "infrastructure.observe",
      kind: "probe.tcp",
      payload: { host: "10.0.0.1", port: 22, timeoutMs: 2000 },
      grant: expect.any(String),
      iat,
      exp: iat + 120,
      timeoutSec: 30,
      maxOutputBytes: 64 * 1024,
    });
    expect(jobId).toMatch(/^job_[0-9a-f-]{36}$/);
    // the embedded grant is itself a verifiable JWS for exactly this runner, capability and operation
    const grant = runner.decodeJob(job.claims.grant, "zenith-grant+jwt");
    expect(grant.claims).toMatchObject({ aud: `runner:${runner.id}`, cap: "infrastructure.observe", op: OPERATION, ws: "w-a" });
  });

  it("signs the envelope's key order as the spec lists it (the Go agent and its golden vector rely on field names, not order, but the wire form is stable)", async () => {
    await enqueueProbe();
    const job = runner.decodeJob(((await poll(runner)).body.jobs as string[])[0], "zenith-job+jwt");
    expect(Object.keys(job.claims)).toEqual(["protocol", "jti", "runnerId", "workspaceId", "operationId", "capability", "kind", "payload", "grant", "iat", "exp", "timeoutSec", "maxOutputBytes"]);
  });

  it("delivers a job at most once and marks it running with a lease of its timeout plus grace", async () => {
    const jobId = await enqueueProbe(runner, { timeoutSec: 600 });
    expect(((await poll(runner)).body.jobs as string[]).length).toBe(1);
    expect(((await poll(runner)).body.jobs as string[]).length).toBe(0); // not handed out again
    const row = await plane.store.jobs.get("w-a", jobId);
    expect(row?.status).toBe("running");
    expect(row?.startedAt).toBeTruthy();
    expect(Date.parse(row!.leaseUntil!) - plane.rt.now()).toBe((600 + LEASE_GRACE_SEC) * 1000);
    expect(plane.events.filter((e) => e.type === "runner.job.dispatched")).toMatchObject([{ workspaceId: "w-a", agentId: runner.id, operationId: OPERATION, data: { jobId, kind: "probe.tcp" } }]);
  });

  it("honours max and hands out jobs oldest first", async () => {
    const ids = [await enqueueProbe(), await enqueueProbe(runner, { port: 23 }), await enqueueProbe(runner, { port: 24 })];
    const first = (await poll(runner, { max: 2, waitSec: 0 })).body.jobs as string[];
    expect(first.map((j) => runner.decodeJob(j, "zenith-job+jwt").claims.jti)).toEqual(ids.slice(0, 2));
    const rest = (await poll(runner, { max: 5, waitSec: 0 })).body.jobs as string[];
    expect(rest.map((j) => runner.decodeJob(j, "zenith-job+jwt").claims.jti)).toEqual([ids[2]]);
  });

  it("never delivers an expired job", async () => {
    const jobId = await enqueueProbe(runner, { queueTtlSec: 10 });
    plane.clock.t += 11_000;
    expect((await poll(runner)).body.jobs).toEqual([]);
    expect((await plane.store.jobs.get("w-a", jobId))?.status).toBe("queued");
  });

  it("two jobs for two runners are each delivered to their own runner only", async () => {
    const other = await registerFakeAgent(plane, registerRunner, { name: "second" });
    const mine = await enqueueProbe(runner);
    const theirs = await enqueueProbe(other);
    const a = (await poll(runner)).body.jobs as string[];
    const b = (await poll(other)).body.jobs as string[];
    expect(a.map((j) => runner.decodeJob(j, "zenith-job+jwt").claims.jti)).toEqual([mine]);
    expect(b.map((j) => other.decodeJob(j, "zenith-job+jwt").claims.jti)).toEqual([theirs]);
  });
});

describe("claim exclusivity under concurrent polls", () => {
  it("never hands one job to two pollers, loses none, and the jobs are all delivered", async () => {
    const ids = await Promise.all(Array.from({ length: 7 }, (_, i) => enqueueProbe(runner, { port: 1000 + i })));
    const responses = await Promise.all(Array.from({ length: 12 }, () => poll(runner, { max: 2, waitSec: 0 })));
    const delivered = responses.flatMap((r) => (r.body.jobs as string[]).map((j) => String(runner.decodeJob(j, "zenith-job+jwt").claims.jti)));
    expect(new Set(delivered).size).toBe(delivered.length);
    expect([...delivered].sort()).toEqual([...ids].sort());
    for (const id of ids) expect((await plane.store.jobs.get("w-a", id))?.status).toBe("running");
  });
});

describe("long poll", () => {
  it("returns immediately with waitSec 0 and waits at most 20 s however long the agent asks", async () => {
    const t0 = plane.rt.now();
    expect((await poll(runner, { max: 1, waitSec: 0 })).body.jobs).toEqual([]);
    expect(plane.rt.now() - t0).toBe(0);
    const t1 = plane.rt.now();
    expect((await poll(runner, { max: 1, waitSec: 25 })).body.jobs).toEqual([]); // the spec's ceiling is 25; the serverless bound is 20
    const waited = plane.rt.now() - t1;
    expect(waited).toBeGreaterThanOrEqual(20_000);
    expect(waited).toBeLessThan(20_600);
  });

  it("returns as soon as a job arrives, without waiting out the rest", async () => {
    let calls = 0;
    const who: { agent?: FakeAgent } = {};
    const p = await createPlane("fake", {
      sleep: async (ms) => {
        p.clock.t += ms;
        if (++calls === 3) await enqueueProbeOn(p, who.agent!); // a job arrives while the poll is waiting
      },
    });
    const agent = await registerFakeAgent(p, registerRunner);
    who.agent = agent;
    const t0 = p.rt.now();
    const res = await agent.post(pollRunner, "/poll", { max: 1, waitSec: 20 });
    expect((res.body.jobs as string[]).length).toBe(1);
    expect(calls).toBe(3);
    expect(p.rt.now() - t0).toBe(1500); // three 500 ms steps, not the full 20 s
  });

  it("tells a runner revoked mid-wait so promptly (401 agent_revoked), not at the end of the wait", async () => {
    let calls = 0;
    const who: { agent?: FakeAgent } = {};
    const p = await createPlane("fake", {
      sleep: async (ms) => {
        p.clock.t += ms;
        if (++calls === 2) await p.store.runners.revoke("w-a", who.agent!.id);
      },
    });
    const a = await registerFakeAgent(p, registerRunner);
    who.agent = a;
    const t0 = p.rt.now();
    const res = await a.post(pollRunner, "/poll", { max: 1, waitSec: 20 });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("agent_revoked");
    expect(p.rt.now() - t0).toBeLessThan(5000);
  });

  it("validates the poll body", async () => {
    for (const body of [{ max: 0 }, { max: 11 }, { max: 1.5 }, { waitSec: -1 }, { waitSec: 26 }, { waitSec: "20" }, "[1]"]) {
      const res = await runner.post(pollRunner, "/poll", body as never);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await runner.post(pollRunner, "/poll", undefined)).status).toBe(200); // an empty body is {max:1,waitSec:0}
  });
});

describe("heartbeat", () => {
  it("records the heartbeat, accepts changed capabilities, and answers {revoked:false, pollIntervalSec}", async () => {
    const res = await runner.post(heartbeatRunner, "/heartbeat", { version: "1.1.0", capabilities: ["aws.http"], running: 2, host: { os: "linux", arch: "arm64" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: false, pollIntervalSec: 5 });
    const row = await plane.store.runners.get("w-a", runner.id);
    expect(row).toMatchObject({ version: "1.1.0", capabilities: ["aws.http"], host: { os: "linux", arch: "arm64" } });
    expect(row?.lastHeartbeatAt).toBeTruthy();
  });

  it("announces rotation keys in nextKeys, and omits the member when there are none", async () => {
    expect((await runner.post(heartbeatRunner, "/heartbeat", {})).body).not.toHaveProperty("nextKeys");
    const next = await newSigner("cp-next");
    configureRunnerRuntime({ ...plane.rt, verificationKeys: async () => [plane.signer.publicJwk(), next.publicJwk()] });
    const res = await runner.post(heartbeatRunner, "/heartbeat", {});
    expect(res.body.nextKeys).toEqual([{ kid: "cp-next", publicKey: next.publicJwk().x }]);
    // the active key is never re-announced
    expect(JSON.stringify(res.body.nextKeys)).not.toContain(plane.cpKeys[0].kid);
  });

  it("a revoked agent is told 401 agent_revoked, terminally", async () => {
    await plane.store.runners.revoke("w-a", runner.id);
    const res = await runner.post(heartbeatRunner, "/heartbeat", {});
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("agent_revoked");
  });

  it("rejects malformed bodies", async () => {
    for (const body of [{ running: -1 }, { capabilities: "aws.http" }, { host: { a: 1 } }, { version: 5 }]) expect((await runner.post(heartbeatRunner, "/heartbeat", body)).status, JSON.stringify(body)).toBe(400);
  });
});

describe("zenithd (machine) requests use the same protocol with their own envelope and queue", () => {
  it("delivers a zenith-machine+jwt with the machine envelope, and only to that machine", async () => {
    const machine = await registerFakeAgent(plane, registerMachine, { kind: "machine", capabilities: ["service.status", "machine.inspect"] });
    const id = await enqueueMachineRequest({
      workspaceId: "w-a",
      machineId: machine.id,
      operationId: OPERATION,
      operation: "service.status",
      args: { unit: "nginx.service" },
      grant: await issueGrant(plane, { aud: `machine:${machine.id}`, cap: "service.status", op: OPERATION, ws: "w-a" }),
    });
    expect(id).toMatch(/^mreq_[0-9a-f-]{36}$/);
    expect(((await poll(runner)).body.jobs as string[]).length).toBe(0); // a runner never sees a machine's queue
    const jobs = (await machine.post(pollMachine, "/poll", { max: 1, waitSec: 0 })).body.jobs as string[];
    expect(jobs).toHaveLength(1);
    const req = machine.decodeJob(jobs[0], "zenith-machine+jwt");
    const iat = Math.floor(plane.rt.now() / 1000);
    expect(req.claims).toEqual({
      protocol: "zenith.machine/v1",
      jti: id,
      machineId: machine.id,
      workspaceId: "w-a",
      operationId: OPERATION,
      operation: "service.status",
      args: { unit: "nginx.service" },
      grant: expect.any(String),
      iat,
      exp: iat + 120,
      timeoutSec: 30,
      maxOutputBytes: 64 * 1024,
    });
    expect(machine.decodeJob(req.claims.grant, "zenith-grant+jwt").claims).toMatchObject({ aud: `machine:${machine.id}`, cap: "service.status" });
    expect((await machine.post(heartbeatMachine, "/heartbeat", { capabilities: ["service.status"] })).status).toBe(200);
  });
});

async function enqueueProbeOn(p: Plane, agent: FakeAgent): Promise<string> {
  return enqueueRunnerJob({
    workspaceId: agent.workspaceId,
    runnerId: agent.id,
    operationId: OPERATION,
    capability: "infrastructure.observe",
    kind: "probe.tcp",
    payload: { host: "10.0.0.1", port: 22 },
    grant: await runnerGrant(p, { runnerId: agent.id, workspaceId: agent.workspaceId, operationId: OPERATION, capability: "infrastructure.observe" }),
  });
}
