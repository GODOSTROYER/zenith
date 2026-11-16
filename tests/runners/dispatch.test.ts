/**
 * The server API execution activities use: `enqueueRunnerJob` / `awaitRunnerJob` (and the zenithd
 * equivalents). Focus: what is REFUSED before anything is signed, and what "uncertain" means — the
 * control plane never re-dispatches a job whose outcome it cannot prove.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/controlplane/digest";
import { POST as heartbeatRunner } from "@/app/api/platform/v1/runners/[id]/heartbeat/route";
import { POST as resultRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/result/route";
import { POST as pollRunner } from "@/app/api/platform/v1/runners/[id]/poll/route";
import { POST as registerMachine } from "@/app/api/platform/v1/machines/register/route";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import {
  DispatchError,
  RunnerJobError,
  awaitRunnerJob,
  enqueueMachineRequest,
  enqueueRunnerJob,
  isUncertainJobError,
  requireSucceeded,
  type AwaitedJob,
  type EnqueueRunnerJobInput,
} from "@/lib/runners/dispatch";
import { reapExpiredJobs } from "@/lib/runners/service";
import { createAesResultSealer } from "@/lib/runners/seal";
import { configureRunnerRuntime } from "@/lib/runners/runtime";
import { FakeAgent, OPERATION, T0, createPlane, enqueueProbeJob, issueGrant, newSigner, registerFakeAgent, runnerGrant, teardownPlane, type Plane } from "./_support";

let plane: Plane;
let runner: FakeAgent;
beforeEach(async () => {
  plane = await createPlane("fake");
  runner = await registerFakeAgent(plane, registerRunner);
});
afterEach(teardownPlane);

const probe = { host: "10.0.0.1", port: 22, timeoutMs: 2000 };
async function input(over: Partial<EnqueueRunnerJobInput> = {}, grantOver: Partial<{ runnerId: string; workspaceId: string; operationId: string; capability: string; exp: number }> = {}): Promise<EnqueueRunnerJobInput> {
  const operationId = over.operationId ?? OPERATION;
  const capability = over.capability ?? "infrastructure.observe";
  return {
    workspaceId: "w-a",
    runnerId: runner.id,
    operationId,
    capability,
    kind: "probe.tcp",
    payload: probe,
    grant: await runnerGrant(plane, { runnerId: runner.id, workspaceId: "w-a", operationId, capability, ...grantOver }),
    ...over,
  };
}
const refused = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "accepted";
  } catch (e) {
    return e instanceof DispatchError ? `${e.code}: ${e.message}` : `unexpected ${String(e)}`;
  }
};
const poll = (a: FakeAgent = runner) => a.post(pollRunner, "/poll", { max: 5, waitSec: 0 });
const report = (id: string, body: unknown) => runner.post(resultRunner, `/jobs/${id}/result`, body, {}, { jti: id });

describe("enqueueRunnerJob refuses before signing", () => {
  it("accepts a well-formed job and queues it for the runner", async () => {
    const id = await enqueueRunnerJob(await input());
    const row = await plane.store.jobs.get("w-a", id);
    expect(row).toMatchObject({ status: "queued", agentId: runner.id, kind: "probe.tcp", capability: "infrastructure.observe", operationId: OPERATION });
    expect(Date.parse(row!.expiresAt) - plane.rt.now()).toBe(120_000);
  });

  it("refuses a runner that is unknown, in another workspace, revoked or stale", async () => {
    expect(await refused(enqueueRunnerJob(await input({ runnerId: "run_nope" }, { runnerId: "run_nope" })))).toMatch(/^agent_not_found/);
    expect(await refused(enqueueRunnerJob({ ...(await input()), workspaceId: "w-b" }))).toMatch(/^agent_not_found/); // tenant boundary
    plane.clock.t += 89_000;
    expect(await refused(enqueueRunnerJob(await input()))).toBe("accepted"); // 89 s of silence is not yet stale
    plane.clock.t += 2_000;
    expect(await refused(enqueueRunnerJob(await input()))).toMatch(/^agent_stale/); // three missed heartbeats
    expect((await runner.post(heartbeatRunner, "/heartbeat", {})).status).toBe(200);
    expect(await refused(enqueueRunnerJob(await input()))).toBe("accepted");
    await plane.store.runners.revoke("w-a", runner.id);
    expect(await refused(enqueueRunnerJob(await input()))).toMatch(/^agent_revoked/);
  });

  it("does not dispatch to a stale runner even if it is the only one", async () => {
    plane.clock.t += 120_000;
    const before = await plane.store.jobs.listForOperation("w-a", OPERATION);
    expect(await refused(enqueueRunnerJob(await input()))).toMatch(/^agent_stale/);
    expect(await plane.store.jobs.listForOperation("w-a", OPERATION)).toEqual(before); // nothing was queued
    expect((await poll()).body.jobs).toEqual([]);
  });

  it("refuses a job kind the runner did not advertise", async () => {
    const small = await registerFakeAgent(plane, registerRunner, { capabilities: ["aws.http"], name: "aws-only" });
    const job = { ...(await input({ runnerId: small.id }, { runnerId: small.id })) };
    expect(await refused(enqueueRunnerJob(job))).toMatch(/^agent_lacks_capability.*aws\.http/);
    // it advertises nothing it was not asked to do: a kind it does offer is fine
    const ok = await input({ runnerId: small.id, kind: "aws.http", payload: { service: "sts", region: "us-east-1", method: "POST", url: "https://sts.us-east-1.amazonaws.com/", headers: {}, bodyB64: "" } }, { runnerId: small.id });
    expect(await refused(enqueueRunnerJob(ok))).toBe("accepted");
  });

  it("follows capability changes announced in a heartbeat", async () => {
    expect(await refused(enqueueRunnerJob(await input({ kind: "probe.dns", payload: { name: "example.com" } })))).toBe("accepted");
    await runner.post(heartbeatRunner, "/heartbeat", { capabilities: ["aws.http"] });
    expect(await refused(enqueueRunnerJob(await input({ kind: "probe.dns", payload: { name: "example.com" } })))).toMatch(/^agent_lacks_capability/);
  });

  it("validates ids, the capability catalog and the limits", async () => {
    expect(await refused(enqueueRunnerJob(await input({ operationId: "op with space" })))).toMatch(/^invalid_input/);
    expect(await refused(enqueueRunnerJob(await input({ capability: "not.a.capability" })))).toMatch(/^invalid_input/);
    expect(await refused(enqueueRunnerJob({ ...(await input()), kind: "shell.exec" as never }))).toMatch(/^invalid_input/);
    for (const timeoutSec of [0, -1, 1.5, 7201]) expect(await refused(enqueueRunnerJob(await input({ timeoutSec }))), String(timeoutSec)).toMatch(/^invalid_input/);
    expect(await refused(enqueueRunnerJob(await input({ maxOutputBytes: 10 })))).toMatch(/^invalid_input/);
    expect(await refused(enqueueRunnerJob(await input({ queueTtlSec: 5 })))).toMatch(/^invalid_input/);
  });

  it("validates every payload strictly, exactly as the Go agent will", async () => {
    const bad: [Partial<EnqueueRunnerJobInput>, RegExp][] = [
      [{ payload: { ...probe, extra: 1 } }, /extra|Unrecognized/i], // unknown member: the agent would refuse it
      [{ payload: { host: "h", port: 0 } }, /port/],
      [{ payload: { host: "h", port: 70000 } }, /port/],
      [{ payload: {} }, /host/],
      [{ kind: "aws.http", payload: { service: "s3", region: "us-east-1", method: "GET", url: "http://s3.amazonaws.com/", headers: {} } }, /https/],
      [{ kind: "aws.http", payload: { service: "s3", region: "us-east-1", method: "TRACE", url: "https://s3.amazonaws.com/", headers: {} } }, /method/],
      [{ kind: "aws.http", payload: { service: "S3!", region: "us-east-1", method: "GET", url: "https://s3.amazonaws.com/", headers: {} } }, /service/],
      [{ kind: "aws.http", payload: { service: "s3", region: "us-east-1", method: "GET", url: "https://s3.amazonaws.com/", headers: {}, bodyB64: "not base64!" } }, /base64/],
      [{ kind: "k8s.http", payload: { method: "GET", path: "api/v1/pods" } }, /path/],
      [{ kind: "k8s.http", payload: { method: "CONNECT", path: "/api" } }, /method/],
      [{ kind: "probe.dns", payload: { name: "" } }, /name/],
      [{ kind: "probe.http", payload: { url: "https://example.com", method: "DELETE" } }, /method/],
    ];
    for (const [over, re] of bad) expect(await refused(enqueueRunnerJob(await input(over))), JSON.stringify(over).slice(0, 80)).toMatch(new RegExp(`^invalid_payload.*(${re.source})`, re.flags));
  });

  it("validates tofu.run payloads: digests, paths, base64, and plan/apply/show rules", async () => {
    const sha = "a".repeat(64);
    const files = [{ path: "main.tf.json", contentB64: Buffer.from("{}").toString("base64") }];
    const base = { files, lockfile: "", configDigest: sha };
    const cases: [unknown, string][] = [
      [{ ...base, command: "plan", planFileSha256: sha }, "planFileSha256"],
      [{ ...base, command: "apply" }, "planFileSha256"],
      [{ ...base, command: "show" }, "planFileSha256"],
      [{ ...base, command: "plan", destroy: true, planFileSha256: undefined }, "ok"],
      [{ ...base, command: "apply", planFileSha256: sha, destroy: true }, "destroy"],
      [{ ...base, command: "plan", configDigest: "ABC" }, "configDigest"],
      [{ ...base, command: "destroy" }, "command"],
      [{ ...base, command: "plan", files: [] }, "files"],
      [{ ...base, command: "plan", files: [{ path: "../etc/passwd", contentB64: "" }] }, "path"],
      [{ ...base, command: "plan", files: [{ path: "/abs.tf", contentB64: "" }] }, "path"],
      [{ ...base, command: "plan", files: [{ path: ".terraform/x", contentB64: "" }] }, "path"],
      [{ ...base, command: "plan", files: [{ path: ".terraform.lock.hcl", contentB64: "" }] }, "path"],
      [{ ...base, command: "plan", files: [files[0], files[0]] }, "duplicate"],
      [{ ...base, command: "plan", files: [{ path: "a", contentB64: "" }, { path: "a/b.tf", contentB64: "" }] }, "directory"],
      [{ ...base, command: "plan", files: [{ path: "a.tf", contentB64: "@@" }] }, "base64"],
      [{ ...base, command: "plan", lockfile: "x".repeat((1 << 20) + 1) }, "lockfile"],
    ];
    for (const [payload, expectation] of cases) {
      const res = await refused(enqueueRunnerJob(await input({ kind: "tofu.run", payload, capability: "infrastructure.plan" })));
      if (expectation === "ok") expect(res, JSON.stringify(payload).slice(0, 60)).toBe("accepted");
      else expect(res, JSON.stringify(payload).slice(0, 80)).toMatch(new RegExp(`^invalid_payload.*${expectation}`, "i"));
    }
  });

  it("refuses a job whose signed envelope would exceed what the store keeps (256 KiB)", async () => {
    const big = { path: "main.tf.json", contentB64: Buffer.alloc(300 * 1024, "a").toString("base64") };
    const res = await refused(enqueueRunnerJob(await input({ kind: "tofu.run", capability: "infrastructure.plan", payload: { command: "plan", files: [big], lockfile: "", configDigest: "b".repeat(64) } })));
    expect(res).toMatch(/^payload_too_large/);
    expect(await plane.store.jobs.listForOperation("w-a", OPERATION)).toEqual([]);
  });
});

describe("the capability grant must bind exactly this job", () => {
  it("refuses a grant for another runner, capability, operation or workspace", async () => {
    const other = await registerFakeAgent(plane, registerRunner, { name: "other" });
    expect(await refused(enqueueRunnerJob(await input({}, { runnerId: other.id })))).toMatch(/^grant_invalid.*grant_wrong_audience/);
    expect(await refused(enqueueRunnerJob({ ...(await input()), grant: await runnerGrant(plane, { runnerId: runner.id, workspaceId: "w-a", operationId: OPERATION, capability: "infrastructure.apply" }) }))).toMatch(/^grant_invalid.*grant_wrong_capability/);
    expect(await refused(enqueueRunnerJob({ ...(await input()), grant: await runnerGrant(plane, { runnerId: runner.id, workspaceId: "w-a", operationId: "op_other", capability: "infrastructure.observe" }) }))).toMatch(/^grant_invalid.*grant_wrong_operation/);
    expect(await refused(enqueueRunnerJob({ ...(await input()), grant: await runnerGrant(plane, { runnerId: runner.id, workspaceId: "w-b", operationId: OPERATION, capability: "infrastructure.observe" }) }))).toMatch(/^grant_invalid.*workspace/);
    expect(await plane.store.jobs.listForOperation("w-a", OPERATION)).toEqual([]);
  });

  it("refuses a missing, malformed, foreign-signed or wrong-typ grant", async () => {
    expect(await refused(enqueueRunnerJob({ ...(await input()), grant: "" }))).toMatch(/^grant_invalid/);
    expect(await refused(enqueueRunnerJob({ ...(await input()), grant: "not.a.jws" }))).toMatch(/^grant_invalid/);
    const foreign = await newSigner("cp-test"); // same kid, different key
    const claims = { jti: "g1", iss: "x", aud: `runner:${runner.id}`, sub: "u", iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 600, cap: "infrastructure.observe", op: OPERATION, digest: "d", ws: "w-a" };
    expect(await refused(enqueueRunnerJob({ ...(await input()), grant: await foreign.sign({ typ: "zenith-grant+jwt" }, claims) }))).toMatch(/^grant_invalid.*signature/);
    expect(await refused(enqueueRunnerJob({ ...(await input()), grant: await plane.signer.sign({ typ: "zenith-job+jwt" }, claims) }))).toMatch(/^grant_invalid.*header/);
  });

  it("refuses an expired grant and shortens the job to the grant's own lifetime", async () => {
    const iat = Math.floor(plane.rt.now() / 1000);
    const soon = await enqueueRunnerJob(await input({}, { exp: iat + 40 }));
    const row = await plane.store.jobs.get("w-a", soon);
    expect(Date.parse(row!.expiresAt) - plane.rt.now()).toBe(40_000); // queue window (120 s) clamped to the grant (40 s)
    const nearly = await input({}, { exp: iat + 3 });
    expect(await refused(enqueueRunnerJob(nearly))).toMatch(/^grant_invalid.*expire/);
    const issuedAtT0 = (await input()).grant;
    plane.clock.t += 700_000;
    await runner.post(heartbeatRunner, "/heartbeat", {}); // keep the runner fresh so only the grant can be the reason
    expect(await refused(enqueueRunnerJob({ ...nearly, grant: issuedAtT0 }))).toMatch(/^grant_invalid.*expired/); // issued at T0, expired now
  });
});

describe("a revoke that races the enqueue", () => {
  it("surfaces as agent_not_found and queues nothing", async () => {
    // a store whose enqueue loses a race with a revoke: the runner is revoked between the check and the insert
    const real = plane.store;
    const wrapped = { ...real, jobs: { ...real.jobs, enqueue: async (i: Parameters<typeof real.jobs.enqueue>[0]) => { await real.runners.revoke("w-a", runner.id); return real.jobs.enqueue(i); } } };
    configureRunnerRuntime({ ...plane.rt, store: wrapped });
    expect(await refused(enqueueRunnerJob(await input()))).toMatch(/^agent_not_found/);
    expect(await real.jobs.listForOperation("w-a", OPERATION)).toEqual([]);
  });
});

describe("awaitRunnerJob never re-dispatches", () => {
  it("returns the agent's result the moment it is reported", async () => {
    const id = await enqueueProbeJob(plane, runner);
    await poll();
    await report(id, { status: "succeeded", result: { reachable: true } });
    expect(await awaitRunnerJob(id, { workspaceId: "w-a" })).toMatchObject({ status: "succeeded", uncertain: false, result: { reachable: true } });
  });

  it("a job never claimed before its expiry is `expired` (provably not delivered), not uncertain, and is never offered afterwards", async () => {
    const id = await enqueueProbeJob(plane, runner, { queueTtlSec: 30 });
    const awaited = await awaitRunnerJob(id, { workspaceId: "w-a" });
    expect(awaited).toMatchObject({ jobId: id, status: "expired", uncertain: false });
    expect(awaited.result).toBeUndefined();
    expect((await plane.store.jobs.get("w-a", id))?.status).toBe("cancelled");
    expect((await poll()).body.jobs).toEqual([]); // no re-dispatch, ever
    expect(await plane.store.jobs.listForOperation("w-a", OPERATION)).toHaveLength(1);
  });

  it("a delivered job stays timed out and uncertain while a signed late outcome is retained without replay", async () => {
    const id = await enqueueProbeJob(plane, runner, { timeoutSec: 60 });
    expect(((await poll()).body.jobs as string[]).length).toBe(1);
    const awaited = await awaitRunnerJob(id, { workspaceId: "w-a" });
    expect(awaited).toMatchObject({ status: "timed_out", uncertain: true });
    expect(plane.rt.now() - T0).toBeGreaterThanOrEqual((60 + 150) * 1000); // it waited out the job's timeout plus the reporting grace
    const before = await plane.store.jobs.get("w-a", id);
    expect(before?.status).toBe("cancelled");
    expect((await report(id, { status: "succeeded", result: {} })).status).toBe(200);
    expect(await plane.store.jobs.getEffectReceipt("w-a", id)).toMatchObject({ projectionStatus: "cancelled", reportedStatus: "succeeded" });
    expect(await plane.store.jobs.get("w-a", id)).toEqual(before);
    expect(await awaitRunnerJob(id, { workspaceId: "w-a" })).toMatchObject({ status: "cancelled", uncertain: true });
    expect((await poll()).body.jobs).toEqual([]); // and it was not handed out again
    expect(await plane.store.jobs.listForOperation("w-a", OPERATION)).toHaveLength(1);
  });

  it("honours the caller's own deadline (impatient callers get the same honest answers)", async () => {
    const queued = await enqueueProbeJob(plane, runner);
    expect(await awaitRunnerJob(queued, { workspaceId: "w-a", deadlineMs: plane.rt.now() + 2000 })).toMatchObject({ status: "expired", uncertain: false });
    const running = await enqueueProbeJob(plane, runner, { port: 2 });
    await poll();
    expect(await awaitRunnerJob(running, { workspaceId: "w-a", deadlineMs: plane.rt.now() + 2000 })).toMatchObject({ status: "timed_out", uncertain: true });
  });

  it("aborting while the job is queued cancels it (never delivered); aborting after hand-over leaves it running", async () => {
    const ac = new AbortController();
    const id = await enqueueProbeJob(plane, runner);
    configureRunnerRuntime({ ...plane.rt, sleep: async (ms, signal) => { if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" }); plane.clock.t += ms; ac.abort(); } });
    await expect(awaitRunnerJob(id, { workspaceId: "w-a", signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect((await plane.store.jobs.get("w-a", id))?.status).toBe("cancelled");
    expect((await poll()).body.jobs).toEqual([]);

    const ac2 = new AbortController();
    const live = await enqueueProbeJob(plane, runner, { port: 5 });
    await poll();
    configureRunnerRuntime({ ...plane.rt, sleep: async (ms, signal) => { if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" }); plane.clock.t += ms; ac2.abort(); } });
    await expect(awaitRunnerJob(live, { workspaceId: "w-a", signal: ac2.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect((await plane.store.jobs.get("w-a", live))?.status).toBe("running"); // the agent may still be executing it
  });

  it("refuses to await another workspace's job", async () => {
    const id = await enqueueProbeJob(plane, runner);
    expect(await refused(awaitRunnerJob(id, { workspaceId: "w-b" }))).toMatch(/^job_not_found/);
    expect(await refused(awaitRunnerJob("job_nope", { workspaceId: "w-a" }))).toMatch(/^job_not_found/);
  });

  it("a result that cannot be opened (sealing key changed) is uncertain, not silently empty", async () => {
    const id = await enqueueProbeJob(plane, runner);
    await poll();
    await report(id, { status: "succeeded", result: { x: 1 } });
    configureRunnerRuntime({ ...plane.rt, sealer: createAesResultSealer(Buffer.alloc(32, 9)) });
    expect(await awaitRunnerJob(id, { workspaceId: "w-a" })).toMatchObject({ status: "failed", uncertain: true, error: expect.stringContaining("could not be opened") });
  });

  it("a revoke cancels queued work (not delivered) but leaves work already handed over for the reaper", async () => {
    const delivered = await enqueueProbeJob(plane, runner);
    await poll();
    const queued = await enqueueProbeJob(plane, runner, { port: 9 });
    await plane.store.runners.revoke("w-a", runner.id);
    expect(await awaitRunnerJob(queued, { workspaceId: "w-a" })).toMatchObject({ status: "cancelled", uncertain: false });
    expect((await plane.store.jobs.get("w-a", delivered))?.status).toBe("running");
    expect(await awaitRunnerJob(delivered, { workspaceId: "w-a" })).toMatchObject({ status: "timed_out", uncertain: true });
  });
});

describe("requireSucceeded", () => {
  const awaited = (over: Partial<AwaitedJob>): AwaitedJob => ({ jobId: "job_1", status: "failed", uncertain: false, ...over });

  it("returns a succeeded job and throws typed errors otherwise", () => {
    expect(requireSucceeded(awaited({ status: "succeeded", result: { a: 1 } })).result).toEqual({ a: 1 });
    const cases: [Partial<AwaitedJob>, string, boolean][] = [
      [{ status: "failed", error: "boom" }, "runner_job_failed", false],
      [{ status: "rejected", error: "not_allowed" }, "runner_job_rejected", false],
      [{ status: "timed_out", uncertain: true }, "runner_job_uncertain", true],
      [{ status: "expired" }, "runner_job_not_delivered", false],
      [{ status: "cancelled" }, "runner_job_not_delivered", false],
      [{ status: "cancelled", uncertain: true }, "runner_job_uncertain", true],
      [{ status: "failed", uncertain: true, error: "unreadable" }, "runner_job_uncertain", true],
    ];
    for (const [over, code, uncertain] of cases) {
      let caught: unknown;
      try {
        requireSucceeded(awaited(over));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RunnerJobError);
      expect((caught as RunnerJobError).code).toBe(code);
      expect(isUncertainJobError(caught)).toBe(uncertain);
    }
  });
});

describe("the reaper", () => {
  it("settles lapsed work, returns it for reconciliation to `uncertain`, emits events, and re-queues nothing", async () => {
    const idle = await registerFakeAgent(plane, registerRunner, { name: "idle" });
    const never = await enqueueProbeJob(plane, idle, { queueTtlSec: 30 });
    const lost = await enqueueProbeJob(plane, runner, { timeoutSec: 30, operationId: "op_lost" });
    await poll();
    const fresh = await enqueueProbeJob(plane, runner, { operationId: "op_fresh", port: 3 });
    plane.clock.t += 400_000;
    const reaped = await reapExpiredJobs(plane.rt);
    // `fresh` was queued moments ago but its own 120 s window lapsed too (the clock jumped 400 s)
    expect(Object.fromEntries(reaped.runnerJobs.map((j) => [j.id, j.status]))).toEqual({ [never]: "expired", [lost]: "timed_out", [fresh]: "expired" });
    expect(plane.events.filter((e) => e.type === "runner.job.completed").map((e) => e.data.status).sort()).toEqual(["expired", "expired", "timed_out"]);
    expect((await poll()).body.jobs).toEqual([]);
    expect(await reapExpiredJobs(plane.rt)).toEqual({ runnerJobs: [], machineRequests: [] });
  });
});

describe("zenithd requests", () => {
  it("refuse operations zenithd does not implement, non-object args, a foreign-audience grant and a machine without the operation", async () => {
    const machine = await registerFakeAgent(plane, registerMachine, { kind: "machine", capabilities: ["service.status", "file.upload", "file.write"] });
    const base = { workspaceId: "w-a", machineId: machine.id, operationId: OPERATION, operation: "service.status", args: { unit: "nginx.service" }, grant: await issueGrant(plane, { aud: `machine:${machine.id}`, cap: "service.status", op: OPERATION, ws: "w-a" }) };
    expect(await refused(enqueueMachineRequest(base))).toBe("accepted");
    expect(await refused(enqueueMachineRequest({ ...base, operation: "file.upload", grant: await issueGrant(plane, { aud: `machine:${machine.id}`, cap: "file.upload", op: OPERATION, ws: "w-a" }) }))).toMatch(/^invalid_payload.*strict local-source/);
    expect(await refused(enqueueMachineRequest({ ...base, operation: "file.write", args: { path: "/opt/customer/settings.txt", content: "inert-plaintext-marker" }, grant: await issueGrant(plane, { aud: `machine:${machine.id}`, cap: "file.write", op: OPERATION, ws: "w-a" }) }))).toMatch(/^invalid_payload.*strict local-template/);
    expect(await refused(enqueueMachineRequest({ ...base, args: [] as never }))).toMatch(/^invalid_payload.*object/);
    expect(await refused(enqueueMachineRequest({ ...base, args: { blob: "x".repeat(70_000) } }))).toMatch(/^invalid_payload.*larger/);
    expect(await refused(enqueueMachineRequest({ ...base, grant: await issueGrant(plane, { aud: "machine:mac_other", cap: "service.status", op: OPERATION, ws: "w-a" }) }))).toMatch(/^grant_invalid/);
    expect(await refused(enqueueMachineRequest({ ...base, operation: "process.list", grant: await issueGrant(plane, { aud: `machine:${machine.id}`, cap: "process.list", op: OPERATION, ws: "w-a" }) }))).toMatch(/^agent_lacks_capability/);
    expect(await refused(enqueueMachineRequest({ ...base, operation: "not.an.operation" }))).toMatch(/^invalid_input/);
    // a runner's id is not a machine's
    expect(await refused(enqueueMachineRequest({ ...base, machineId: runner.id }))).toMatch(/^agent_not_found/);
  });

  it("queues a purpose-bound local upload with actual signing and refuses inline source data before queueing", async () => {
    // Actual existing signing/queue code with the suite's modeled authority
    // transport. This is not native daemon or guest mutation acceptance.
    const machine = await registerFakeAgent(plane, registerMachine, { kind: "machine", capabilities: ["file.upload"] });
    const args = { path: "/opt/customer/model.bin", sourceRef: "model", sourceVersion: "c".repeat(64), expectedSha256: null };
    const grant = await issueGrant(plane, { aud: `machine:${machine.id}`, cap: "file.upload", op: OPERATION, ws: "w-a", res: "res_upload" });
    const input = { workspaceId: "w-a", machineId: machine.id, operationId: OPERATION, operation: "file.upload", args, grant };
    for (const forbidden of [{ ...args, bytes: "inert-upload-marker" }, { ...args, sourcePath: "/private/model.bin" }, { ...args, expectedSha256: "*" }]) {
      expect(await refused(enqueueMachineRequest({ ...input, args: forbidden }))).toMatch(/^invalid_payload.*strict local-source/);
      expect(await plane.store.machineRequests.listForOperation("w-a", OPERATION)).toHaveLength(0);
    }
    const wrong = await issueGrant(plane, { aud: `machine:${machine.id}`, cap: "file.write", op: OPERATION, ws: "w-a", res: "res_upload" });
    expect(await refused(enqueueMachineRequest({ ...input, grant: wrong }))).toMatch(/^grant_invalid/);
    expect(await plane.store.machineRequests.listForOperation("w-a", OPERATION)).toHaveLength(0);
    const id = await enqueueMachineRequest(input);
    const row = await plane.store.machineRequests.get("w-a", id);
    if (!row) throw new Error("the modeled signed upload was not queued");
    expect(row).toMatchObject({ id, workspaceId: "w-a", agentId: machine.id, operationId: OPERATION, kind: "file.upload", capability: "file.upload", status: "queued" });
    const decoded = machine.decodeJob(row.envelope, machine.jobTyp());
    expect(decoded.header).toMatchObject({ alg: "EdDSA", typ: "zenith-machine+jwt" });
    expect(decoded.claims).toMatchObject({ machineId: machine.id, workspaceId: "w-a", operationId: OPERATION, operation: "file.upload", args });
    expect(decoded.claims.args).toEqual(args);
    expect(sha256Hex(String(decoded.claims.grant))).toBe(sha256Hex(grant));
    expect(await plane.store.machineRequests.get("w-b", id)).toBeNull();
    expect(await plane.store.machineRequests.listForOperation("w-a", OPERATION)).toHaveLength(1);
  });

  it("queues only pinned package metadata with the actual signer and a bound resource grant", async () => {
    // Real signing/queue functions with this suite's modeled authority transport.
    const machine = await registerFakeAgent(plane, registerMachine, { kind: "machine", capabilities: ["package.install"] });
    const args = { profileRef: "bundle", profileVersion: "c".repeat(64), expectedInstalledVersion: null };
    const grant = await issueGrant(plane, { aud: `machine:${machine.id}`, cap: "package.install", op: OPERATION, ws: "w-a", res: "res_package" });
    const input = { workspaceId: "w-a", machineId: machine.id, operationId: OPERATION, operation: "package.install", args, grant };
    for (const invalid of [{ ...args, bytes: "inert-package-marker" }, { ...args, sourcePath: "/private/bundle.deb" }, { ...args, url: "https://example.invalid/bundle" }, { ...args, argv: ["/bin/sh"] }, { ...args, expectedInstalledVersion: "*" }]) {
      expect(await refused(enqueueMachineRequest({ ...input, args: invalid }))).toMatch(/^invalid_payload.*strict pinned package/);
      expect(await plane.store.machineRequests.listForOperation("w-a", OPERATION)).toHaveLength(0);
    }
    const id = await enqueueMachineRequest(input), row = await plane.store.machineRequests.get("w-a", id);
    if (!row) throw new Error("The modeled signed package request was not queued.");
    expect(row).toMatchObject({ workspaceId: "w-a", agentId: machine.id, capability: "package.install", operationId: OPERATION, status: "queued" });
    const decoded = machine.decodeJob(row.envelope, machine.jobTyp());
    expect(decoded.claims).toMatchObject({ machineId: machine.id, workspaceId: "w-a", operationId: OPERATION, operation: "package.install", args });
    expect(sha256Hex(String(decoded.claims.grant))).toBe(sha256Hex(grant));
    expect(await plane.store.machineRequests.get("w-b", id)).toBeNull();
  });

  it("a silent machine is stale and gets nothing", async () => {
    const machine = await registerFakeAgent(plane, registerMachine, { kind: "machine", capabilities: ["service.status"] });
    plane.clock.t += 100_000;
    const res = await refused(enqueueMachineRequest({ workspaceId: "w-a", machineId: machine.id, operationId: OPERATION, operation: "service.status", args: {}, grant: await issueGrant(plane, { aud: `machine:${machine.id}`, cap: "service.status", op: OPERATION, ws: "w-a" }) }));
    expect(res).toMatch(/^agent_stale/);
  });
});
