/**
 * Results and logs (docs/platform/RUNNER-PROTOCOL.md section 4): exactly one result per job, sealed at
 * rest; log streaming that is bounded, redacted, idempotent and unable to fail a job.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as logsMachine } from "@/app/api/platform/v1/machines/[id]/jobs/[jti]/logs/route";
import { POST as resultMachine } from "@/app/api/platform/v1/machines/[id]/jobs/[jti]/result/route";
import { POST as pollMachine } from "@/app/api/platform/v1/machines/[id]/poll/route";
import { POST as registerMachine } from "@/app/api/platform/v1/machines/register/route";
import { POST as logsRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/logs/route";
import { POST as resultRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/result/route";
import { POST as pollRunner } from "@/app/api/platform/v1/runners/[id]/poll/route";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import { awaitMachineRequest, awaitRunnerJob, enqueueMachineRequest, toMachineResult } from "@/lib/runners/dispatch";
import { FakeAgent, OPERATION, API, call, createPlane, enqueueProbeJob, issueGrant, registerFakeAgent, teardownPlane, type Plane } from "./_support";

let plane: Plane;
let runner: FakeAgent;
beforeEach(async () => {
  plane = await createPlane("fake");
  runner = await registerFakeAgent(plane, registerRunner);
});
afterEach(teardownPlane);

/** queue + deliver one job, as the agent would receive it */
async function delivered(agent: FakeAgent = runner, over: Parameters<typeof enqueueProbeJob>[2] = {}): Promise<string> {
  const id = await enqueueProbeJob(plane, agent, over);
  const jobs = (await agent.post(pollRunner, "/poll", { max: 1, waitSec: 0 })).body.jobs as string[];
  expect(jobs).toHaveLength(1);
  return id;
}

const result = (agent: FakeAgent, jti: string, body: unknown, handler: unknown = resultRunner) => agent.post(handler, `/jobs/${jti}/result`, body, {}, { jti });
const logs = (agent: FakeAgent, jti: string, body: unknown, handler: unknown = logsRunner) => agent.post(handler, `/jobs/${jti}/logs`, body, {}, { jti });
const line = (text: string, stream = "stdout") => ({ ts: "2026-09-30T12:00:00Z", stream, line: text });
const ok = { status: "succeeded", startedAt: "2026-09-30T12:00:00Z", finishedAt: "2026-09-30T12:00:01Z", exitCode: 0, result: { open: true } };

describe("results", () => {
  it("settles the job, emits a completion event without the result, and the awaiter opens the sealed result", async () => {
    const id = await delivered();
    const res = await result(runner, id, ok);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "accepted" });
    const awaited = await awaitRunnerJob<{ open: boolean }>(id, { workspaceId: "w-a" });
    expect(awaited).toMatchObject({ jobId: id, status: "succeeded", uncertain: false, result: { open: true }, exitCode: 0, startedAt: "2026-09-30T12:00:00.000Z", finishedAt: "2026-09-30T12:00:01.000Z" });
    expect(plane.events.filter((e) => e.type === "runner.job.completed")).toEqual([
      { type: "runner.job.completed", workspaceId: "w-a", operationId: OPERATION, agentId: runner.id, data: { jobId: id, kind: "probe.tcp", status: "succeeded", agentKind: "runner" } },
    ]);
  });

  it("stores the result SEALED: no plaintext of it is in the job row", async () => {
    const id = await delivered();
    const secret = "sensitive-plan-value-7781";
    await result(runner, id, { ...ok, result: { planJson: { resource_changes: [{ change: { after: { password: secret } } }] }, bodyB64: Buffer.from(`{"AccessKeyId":"${secret}"}`).toString("base64") } });
    const row = await plane.store.jobs.get("w-a", id);
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(Buffer.from(`{"AccessKeyId":"${secret}"}`).toString("base64"));
    expect(dump).not.toContain("planJson");
    expect(row?.result).toMatchObject({ sealed: { v: 1, alg: "A256GCM" } });
    // and a result moved onto another job's row is unreadable
    const other = await delivered(runner, { port: 99 });
    await result(runner, other, ok);
    const stolen = (await plane.store.jobs.get("w-a", id))!.result as { sealed: unknown };
    expect(() => plane.rt.sealer.open(`w-a|${other}`, stolen.sealed)).toThrow();
  });

  it("accepts exactly one result: a duplicate is 409 already_settled and does not overwrite", async () => {
    const id = await delivered();
    expect((await result(runner, id, ok)).status).toBe(200);
    const again = await result(runner, id, { ...ok, status: "failed", result: { open: false }, error: "second" });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("already_settled");
    const awaited = await awaitRunnerJob<{ open: boolean }>(id, { workspaceId: "w-a" });
    expect(awaited.status).toBe("succeeded");
    expect(awaited.result).toEqual({ open: true });
  });

  it("of racing results exactly one wins", async () => {
    const id = await delivered();
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => result(runner, id, { ...ok, result: { n: i } })));
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(5);
    expect(plane.events.filter((e) => e.type === "runner.job.completed")).toHaveLength(1);
  });

  it("answers 404 for an unknown job, and 409 for a job that was never delivered", async () => {
    expect((await result(runner, "job_nope", ok)).status).toBe(404);
    const queued = await enqueueProbeJob(plane, runner); // queued, not polled
    const res = await result(runner, queued, ok);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("already_settled");
    expect((await plane.store.jobs.get("w-a", queued))?.status).toBe("queued");
  });

  it("retains encrypted late evidence after control plane timeout without reopening uncertain work", async () => {
    const id = await delivered(runner, { timeoutSec: 30 });
    plane.clock.t += 40 * 60 * 1000; // far past the lease (timeout + grace)
    const awaited = await awaitRunnerJob(id, { workspaceId: "w-a" });
    expect(awaited).toMatchObject({ status: "timed_out", uncertain: true });
    const before = await plane.store.jobs.get("w-a", id);
    expect(before?.status).toBe("cancelled");
    const late = await result(runner, id, ok);
    expect(late.status).toBe(200);
    const receipt = await plane.store.jobs.getEffectReceipt("w-a", id);
    expect(receipt).toMatchObject({ projectionStatus: "cancelled", reportedStatus: "succeeded" });
    expect(receipt?.sealed.alg).toBe("A256GCM");
    expect(await plane.store.jobs.get("w-a", id)).toEqual(before);
    expect(await awaitRunnerJob(id, { workspaceId: "w-a" })).toMatchObject({ status: "cancelled", uncertain: true });
    // and nothing was queued again
    expect((await runner.post(pollRunner, "/poll", { max: 5, waitSec: 0 })).body.jobs).toEqual([]);
  });

  it("stores a rejection with its reason and redacts credential material from error text", async () => {
    const id = await delivered();
    const leaky = "verification failed: AKIAIOSFODNN7EXAMPLE used with Bearer abcdefghijklmnop123456 and token=ya29.AbCdEfGhIjKlMnOpQrStUvWx";
    expect((await result(runner, id, { status: "rejected", error: leaky, result: { reason: "not_allowed" } })).status).toBe(200);
    const row = await plane.store.jobs.get("w-a", id);
    expect(row?.status).toBe("rejected");
    expect(row?.error).not.toMatch(/AKIAIOSFODNN7EXAMPLE|abcdefghijklmnop123456|ya29\.AbCdEf/);
    expect(row?.error).toContain("verification failed");
    const awaited = await awaitRunnerJob(id, { workspaceId: "w-a" });
    expect(awaited).toMatchObject({ status: "rejected", uncertain: false, result: { reason: "not_allowed" } });
  });

  it("bounds error text to 4000 characters", async () => {
    const id = await delivered();
    await result(runner, id, { status: "failed", error: "error text ".repeat(5000) }); // 55,000 characters
    expect((await plane.store.jobs.get("w-a", id))?.error).toHaveLength(4000);
  });

  it("a timed_out status reported by the agent leaves the outcome unknown", async () => {
    const id = await delivered();
    await result(runner, id, { status: "timed_out", error: "the job exceeded its 30s timeout" });
    expect(await awaitRunnerJob(id, { workspaceId: "w-a" })).toMatchObject({ status: "timed_out", uncertain: true });
  });

  it("rejects malformed results", async () => {
    const id = await delivered();
    for (const body of [{ status: "done" }, {}, { status: "succeeded", exitCode: 1.5 }, { status: "succeeded", error: 5 }, "[]", "{nope"]) {
      const res = await result(runner, id, body as never);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await plane.store.jobs.get("w-a", id))?.status).toBe("running"); // none of them settled it
  });

  it("caps the result body (16 MiB): a larger one is 413 and the job stays open", async () => {
    const id = await delivered();
    const res = await result(runner, id, { status: "succeeded", result: { blob: "x".repeat(17 * 1024 * 1024) } });
    expect(res.status).toBe(413);
    expect(res.body.error?.code).toBe("payload_too_large");
    expect((await plane.store.jobs.get("w-a", id))?.status).toBe("running");
  });
});

describe("logs", () => {
  const stored = async (id: string) => (await plane.store.jobs.listLogs({ workspaceId: "w-a", jobId: id, limit: 1000 })).map((l) => l.line);

  it("appends lines in order with their streams", async () => {
    const id = await delivered();
    const res = await logs(runner, id, { seq: 1, lines: [line("init"), line("plan", "stderr"), line("done", "info")] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stored: 3, truncated: false });
    expect((await plane.store.jobs.listLogs({ workspaceId: "w-a", jobId: id })).map((l) => [l.stream, l.line])).toEqual([["stdout", "init"], ["stderr", "plan"], ["info", "done"]]);
  });

  it("redacts credential patterns the agent missed, and truncates long lines", async () => {
    const id = await delivered();
    const jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
    await logs(runner, id, {
      seq: 1,
      lines: [
        line("export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
        line("using AKIAIOSFODNN7EXAMPLE to sign"),
        line(`Authorization: Bearer ${jwt}`),
        line("registered with zrt_AbCdEfGhIjKlMnOpQrStUvWxYz012345"),
        line("postgres://admin:hunter2hunter2@db.internal:5432/app"),
        line("ab ".repeat(7000)), // 21,000 characters, no long base64-looking run to redact
      ],
    });
    const all = await stored(id);
    const dump = all.join("\n");
    for (const leak of ["wJalrXUtnFEMI", "AKIAIOSFODNN7EXAMPLE", jwt, "zrt_AbCdEf", "hunter2hunter2"]) expect(dump, leak).not.toContain(leak);
    expect(all[5]).toHaveLength(8192);
    expect(all[0]).toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("is idempotent per (seq, line): a retried POST does not duplicate", async () => {
    const id = await delivered();
    const body = { seq: 7, lines: [line("a"), line("b")] };
    expect((await logs(runner, id, body)).body).toMatchObject({ stored: 2 });
    expect((await logs(runner, id, body)).body).toMatchObject({ stored: 0 });
    expect(await stored(id)).toEqual(["a", "b"]);
  });

  it("splits a batch larger than the store's 500-line append into sub-batches, losing none and staying idempotent on retry", async () => {
    const id = await delivered();
    const lines = Array.from({ length: 900 }, (_, i) => ({ stream: "info", line: `l${i}` }));
    expect((await logs(runner, id, { seq: 3, lines })).body).toMatchObject({ stored: 900, truncated: false });
    expect((await stored(id)).length).toBe(900);
    expect((await stored(id))[899]).toBe("l899");
    expect((await logs(runner, id, { seq: 3, lines })).body).toMatchObject({ stored: 0 });
    expect((await stored(id)).length).toBe(900);
    // the next batch does not collide with the sub-batches of the previous one
    expect((await logs(runner, id, { seq: 4, lines: [line("next")] })).body).toMatchObject({ stored: 1 });
  });

  it("caps one call at 64 KiB (413)", async () => {
    const id = await delivered();
    const res = await logs(runner, id, { seq: 1, lines: [line("x".repeat(60_000)), line("y".repeat(6_000))] });
    expect(res.status).toBe(413);
    expect(await stored(id)).toEqual([]);
  });

  it("bounds the total per job: bytes (4 MiB), then the stream goes quiet but never errors", async () => {
    const id = await delivered();
    const big = "word ".repeat(1400); // 7,000 characters of ordinary text (a long unbroken run would be redacted as a blob)
    let seq = 0;
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 90; i++) last = (await logs(runner, id, { seq: ++seq, lines: Array.from({ length: 8 }, () => line(big)) })).body;
    expect(last).toMatchObject({ stored: 0, truncated: true });
    const usage = await plane.store.jobs.logUsage("w-a", id);
    expect(usage.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(usage.bytes).toBeGreaterThan(4 * 1024 * 1024 - 8 * 7000 - 1);
    const after = await logs(runner, id, { seq: ++seq, lines: [line(big)] });
    expect(after.status).toBe(200); // never an error: a chatty job cannot fail its own log stream
    expect(after.body).toMatchObject({ stored: 0, truncated: true });
  });

  it("bounds the total per job: lines (20,000)", async () => {
    const id = await delivered();
    let truncated = false;
    for (let seq = 1; seq <= 12; seq++) {
      const res = await logs(runner, id, { seq, lines: Array.from({ length: 2000 }, () => ({ stream: "info", line: "x" })) });
      expect(res.status).toBe(200);
      truncated ||= res.body.truncated === true;
    }
    expect(truncated).toBe(true);
    expect((await plane.store.jobs.logUsage("w-a", id)).lines).toBe(20_000);
  });

  it("closes the stream once the job is settled (409), and refuses unknown jobs (404)", async () => {
    const id = await delivered();
    await result(runner, id, ok);
    const res = await logs(runner, id, { seq: 1, lines: [line("late")] });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("already_settled");
    expect((await logs(runner, "job_nope", { seq: 1, lines: [] })).status).toBe(404);
  });

  it("rejects malformed batches", async () => {
    const id = await delivered();
    for (const body of [{ seq: -1, lines: [] }, { seq: 1.5, lines: [] }, { seq: 1 }, { seq: 1, lines: [{ stream: "tty", line: "x" }] }, { seq: 1, lines: [{ stream: "info" }] }, { seq: 1, lines: Array.from({ length: 2001 }, () => ({ stream: "info", line: "" })) }]) {
      expect((await logs(runner, id, body as never)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
  });
});

describe("zenithd results and logs use the same endpoints under /machines", () => {
  it("settles a machine request, maps it onto MachineResult, and keeps the output sealed", async () => {
    const machine = await registerFakeAgent(plane, registerMachine, { kind: "machine", capabilities: ["service.status"] });
    const id = await enqueueMachineRequest({
      workspaceId: "w-a",
      machineId: machine.id,
      operationId: OPERATION,
      operation: "service.status",
      args: { unit: "nginx.service" },
      grant: await issueGrant(plane, { aud: `machine:${machine.id}`, cap: "service.status", op: OPERATION, ws: "w-a" }),
    });
    expect(((await machine.post(pollMachine, "/poll", { max: 1, waitSec: 0 })).body.jobs as string[]).length).toBe(1);
    expect((await logs(machine, id, { seq: 1, lines: [line("status read")] }, logsMachine)).status).toBe(200);
    const secretOutput = "ActiveState=active SECRET_LOOKING=hunter2-hunter2-hunter2";
    expect(
      (await result(machine, id, { status: "succeeded", startedAt: "2026-09-30T12:00:00Z", finishedAt: "2026-09-30T12:00:01Z", result: { ok: true, data: { unit: "nginx.service", active: true }, output: { stdout: secretOutput, stderr: "", exitCode: 0, truncated: false } } }, resultMachine)).status
    ).toBe(200);
    expect(JSON.stringify(await plane.store.machineRequests.get("w-a", id))).not.toContain("hunter2");
    const awaited = await awaitMachineRequest<Record<string, unknown>>(id, { workspaceId: "w-a" });
    expect(toMachineResult(awaited, "service.status")).toMatchObject({
      ok: true,
      operation: "service.status",
      data: { unit: "nginx.service", active: true },
      output: { stdout: secretOutput, exitCode: 0, truncated: false },
      transport: "zenithd",
      transportRef: id,
      simulated: false,
    });
    expect(plane.events.map((e) => e.type)).toContain("machine.request.completed");
  });
});

it("a result POST without a body is 400", async () => {
  const id = await delivered();
  const res = await call(resultRunner, runner.request("POST", `${API}/runners/${runner.id}/jobs/${id}/result`), { id: runner.id, jti: id });
  expect(res.status).toBe(400);
});
