/**
 * Tenant isolation of the agent-facing surface. A valid signature proves WHICH agent is calling; it is no
 * authority over another agent's URL, queue, jobs or logs — not across workspaces and not between two
 * agents of one workspace. (The human-facing half — revoke/list/tokens across workspaces — is in
 * admin-routes.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as heartbeatMachine } from "@/app/api/platform/v1/machines/[id]/heartbeat/route";
import { POST as registerMachine } from "@/app/api/platform/v1/machines/register/route";
import { POST as heartbeatRunner } from "@/app/api/platform/v1/runners/[id]/heartbeat/route";
import { POST as logsRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/logs/route";
import { POST as resultRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/result/route";
import { POST as pollRunner } from "@/app/api/platform/v1/runners/[id]/poll/route";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import { awaitRunnerJob, DispatchError, enqueueRunnerJob } from "@/lib/runners/dispatch";
import { API, FakeAgent, OPERATION, call, createPlane, enqueueProbeJob, registerFakeAgent, runnerGrant, teardownPlane, type Plane } from "./_support";

let plane: Plane;
let a1: FakeAgent; // workspace A
let a2: FakeAgent; // workspace A, a different runner
let b1: FakeAgent; // workspace B
beforeEach(async () => {
  plane = await createPlane("fake");
  a1 = await registerFakeAgent(plane, registerRunner, { workspaceId: "w-a", name: "a1" });
  a2 = await registerFakeAgent(plane, registerRunner, { workspaceId: "w-a", name: "a2" });
  b1 = await registerFakeAgent(plane, registerRunner, { workspaceId: "w-b", name: "b1" });
});
afterEach(teardownPlane);

const poll = (who: FakeAgent) => who.post(pollRunner, "/poll", { max: 10, waitSec: 0 });
const tokens = async (who: FakeAgent): Promise<string[]> => (await poll(who)).body.jobs as string[];
const result = (who: FakeAgent, onId: string, jti: string, body: unknown = { status: "succeeded", result: { stolen: true } }) =>
  call(resultRunner, who.request("POST", `${API}/runners/${onId}/jobs/${jti}/result`, JSON.stringify(body)), { id: onId, jti });

describe("queues", () => {
  it("a runner polls only its own queue: neither another workspace's runner nor a sibling runner sees its jobs", async () => {
    const mine = await enqueueProbeJob(plane, b1);
    expect(await tokens(a1)).toEqual([]);
    expect(await tokens(a2)).toEqual([]);
    const got = await tokens(b1);
    expect(got.map((t) => b1.decodeJob(t, "zenith-job+jwt").claims.jti)).toEqual([mine]);
  });

  it("a signature by runner A on runner B's URL is refused (403 agent_mismatch) and does not touch B's queue", async () => {
    const job = await enqueueProbeJob(plane, b1);
    const res = await call(pollRunner, a1.request("POST", `${API}/runners/${b1.id}/poll`, JSON.stringify({ max: 5, waitSec: 0 })), { id: b1.id });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("agent_mismatch");
    expect((await plane.store.jobs.get("w-b", job))?.status).toBe("queued");
  });

  it("claiming B's agent id in the header while signing with A's key is an invalid signature", async () => {
    const job = await enqueueProbeJob(plane, b1);
    const res = await call(pollRunner, a1.request("POST", `${API}/runners/${b1.id}/poll`, JSON.stringify({ max: 5, waitSec: 0 }), { agentHeader: b1.id }), { id: b1.id });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("invalid_signature");
    expect((await plane.store.jobs.get("w-b", job))?.status).toBe("queued");
  });

  it("a runner cannot use its key on the machines collection, nor a machine its key on runners", async () => {
    const m = await registerFakeAgent(plane, registerMachine, { kind: "machine", workspaceId: "w-a" });
    const asRunner = await call(heartbeatMachine, a1.request("POST", `${API}/machines/${a1.id}/heartbeat`, "{}"), { id: a1.id });
    expect(asRunner.status).toBe(401);
    expect(asRunner.body.error?.code).toBe("agent_revoked"); // the same answer as for an unknown agent
    const asMachine = await call(heartbeatRunner, m.request("POST", `${API}/runners/${m.id}/heartbeat`, "{}"), { id: m.id });
    expect(asMachine.status).toBe(401);
  });
});

describe("results and logs", () => {
  it("a runner cannot settle a job of another workspace, or of a sibling runner, and the job is untouched", async () => {
    const theirs = await enqueueProbeJob(plane, b1);
    await tokens(b1);
    const sibling = await enqueueProbeJob(plane, a2);
    await tokens(a2);
    for (const target of [theirs, sibling]) {
      const res = await result(a1, a1.id, target);
      expect(res.status, target).toBe(404);
      expect(res.body.error?.code).toBe("job_not_found");
    }
    expect((await plane.store.jobs.get("w-b", theirs))?.status).toBe("running");
    expect((await plane.store.jobs.get("w-a", sibling))?.status).toBe("running");
    // the owners still can
    expect((await result(b1, b1.id, theirs, { status: "succeeded", result: {} })).status).toBe(200);
    expect((await result(a2, a2.id, sibling, { status: "succeeded", result: {} })).status).toBe(200);
  });

  it("a 404 for a foreign job is indistinguishable from a 404 for a job that does not exist", async () => {
    const theirs = await enqueueProbeJob(plane, b1);
    await tokens(b1);
    const foreign = await result(a1, a1.id, theirs);
    const missing = await result(a1, a1.id, "job_00000000-0000-0000-0000-000000000000");
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });

  it("a runner cannot write log lines into another workspace's job", async () => {
    const theirs = await enqueueProbeJob(plane, b1);
    await tokens(b1);
    const res = await call(logsRunner, a1.request("POST", `${API}/runners/${a1.id}/jobs/${theirs}/logs`, JSON.stringify({ seq: 1, lines: [{ stream: "info", line: "injected" }] })), { id: a1.id, jti: theirs });
    expect(res.status).toBe(404);
    expect(await plane.store.jobs.listLogs({ workspaceId: "w-b", jobId: theirs })).toEqual([]);
  });

  it("the settle call itself is scoped by the authenticated agent's workspace, whatever the URL claims", async () => {
    const theirs = await enqueueProbeJob(plane, b1);
    await tokens(b1);
    // A signs a request for its OWN url but names B's job: the store is asked about (w-a, a1, job) and finds nothing
    expect(await plane.store.jobs.settle({ workspaceId: "w-a", agentId: a1.id, jobId: theirs, status: "succeeded", result: {} })).toBe(false);
    expect(await plane.store.jobs.settle({ workspaceId: "w-b", agentId: a1.id, jobId: theirs, status: "succeeded", result: {} })).toBe(false);
    expect((await plane.store.jobs.get("w-b", theirs))?.status).toBe("running");
  });
});

describe("dispatch and await", () => {
  it("a workspace cannot enqueue for another workspace's runner, even with a grant it could mint for its own", async () => {
    const op = "op_x";
    const grantForB = await runnerGrant(plane, { runnerId: b1.id, workspaceId: "w-b", operationId: op, capability: "infrastructure.observe" });
    const base = { runnerId: b1.id, operationId: op, capability: "infrastructure.observe", kind: "probe.tcp" as const, payload: { host: "10.0.0.1", port: 22 } };
    await expect(enqueueRunnerJob({ ...base, workspaceId: "w-a", grant: grantForB })).rejects.toMatchObject({ code: "agent_not_found" });
    const grantForAButWrongRunner = await runnerGrant(plane, { runnerId: b1.id, workspaceId: "w-a", operationId: op, capability: "infrastructure.observe" });
    await expect(enqueueRunnerJob({ ...base, workspaceId: "w-a", grant: grantForAButWrongRunner })).rejects.toBeInstanceOf(DispatchError);
    expect(await plane.store.jobs.listForOperation("w-b", op)).toEqual([]);
  });

  it("a grant bound to another workspace is refused even for the right runner", async () => {
    const grant = await runnerGrant(plane, { runnerId: a1.id, workspaceId: "w-b", operationId: OPERATION, capability: "infrastructure.observe" });
    await expect(enqueueRunnerJob({ workspaceId: "w-a", runnerId: a1.id, operationId: OPERATION, capability: "infrastructure.observe", kind: "probe.tcp", payload: { host: "h", port: 1 }, grant })).rejects.toMatchObject({ code: "grant_invalid" });
  });

  it("a workspace cannot await (or learn anything about) another workspace's job", async () => {
    const theirs = await enqueueProbeJob(plane, b1);
    await expect(awaitRunnerJob(theirs, { workspaceId: "w-a" })).rejects.toMatchObject({ code: "job_not_found" });
    await expect(awaitRunnerJob("job_nope", { workspaceId: "w-a" })).rejects.toMatchObject({ code: "job_not_found" });
    expect((await plane.store.jobs.get("w-b", theirs))?.status).toBe("queued"); // awaiting from A did not cancel it
  });

  it("revoking one runner leaves every other runner's queue and work alone", async () => {
    const mine = await enqueueProbeJob(plane, a1);
    const sibling = await enqueueProbeJob(plane, a2);
    const theirs = await enqueueProbeJob(plane, b1);
    await plane.store.runners.revoke("w-a", a1.id);
    expect((await plane.store.jobs.get("w-a", mine))?.status).toBe("cancelled");
    expect((await plane.store.jobs.get("w-a", sibling))?.status).toBe("queued");
    expect((await plane.store.jobs.get("w-b", theirs))?.status).toBe("queued");
    // and A's runner cannot revoke B's through any agent route: there is none — revoke is session-only
    expect(await plane.store.runners.revoke("w-a", b1.id)).toBeNull();
    expect((await plane.store.runners.get("w-b", b1.id))?.status).toBe("active");
  });
});
