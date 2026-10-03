/** Real machine queue adapters with fake signed agents, in-memory and SQL/PGlite stores. */
import { afterEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/platform/v1/machines/register/route";
import { POST as poll } from "@/app/api/platform/v1/machines/[id]/poll/route";
import { POST as report } from "@/app/api/platform/v1/machines/[id]/jobs/[jti]/result/route";
import { createRunnerMachineDispatcher, createZenithdMachineDriver, type MachineRequest } from "@/lib/machines";
import { createPlane, issueGrant, openDbPlane, registerFakeAgent, teardownPlane, type DbPlane } from "../runners/_support";

const signal = () => new AbortController().signal;
const databases: DbPlane[] = [];
afterEach(async () => { teardownPlane(); while (databases.length) await databases.pop()!.close(); });

describe.each(["memory", "pglite"] as const)("machine dispatcher (%s)", (kind) => {
  it("signs normalized requests and unwraps sealed Go-shaped results including exec output", async () => {
    const db = kind === "pglite" ? await openDbPlane() : undefined;
    if (db) databases.push(db);
    const p = await createPlane(db ? "real" : "fake", {}, db?.store);
    const agent = await registerFakeAgent(p, register, { kind: "machine", capabilities: ["service.status", "machine.exec"] });
    const operationId = db ? await db.operation(agent.workspaceId) : "op_dispatch";
    const dispatcher = createRunnerMachineDispatcher(p.rt);
    const req: MachineRequest = { operationId, target: { workspaceId: agent.workspaceId, transport: "zenithd", targetId: agent.id }, operation: "machine.exec", args: { argv: ["/bin/echo", "hello"], timeoutSec: 5 }, timeoutSec: 5, maxOutputBytes: 65536 };
    const jws = await issueGrant(p, { aud: `machine:${agent.id}`, cap: req.operation, op: operationId, ws: agent.workspaceId });
    const id = await dispatcher.enqueue(req, jws);
    expect(id).toMatch(/^mreq_/);
    const delivery = await agent.post(poll, "/poll", { max: 1, waitSec: 0 });
    const envelope = agent.decodeJob((delivery.body.jobs as string[])[0], agent.jobTyp());
    expect(envelope.claims).toMatchObject({ jti: id, operation: req.operation, args: req.args, grant: jws });
    expect((await agent.post(report, `/jobs/${id}/result`, { status: "succeeded", exitCode: 0, result: { ok: true, operation: req.operation, data: { exitCode: 0 }, output: { stdout: "hello", stderr: "", exitCode: 0, truncated: false } } }, {}, { jti: id })).status).toBe(200);
    expect(await dispatcher.await(id, signal())).toMatchObject({ status: "succeeded", exitCode: 0, result: { exitCode: 0 }, output: { stdout: "hello", stderr: "", truncated: false } });
    expect((await agent.post(poll, "/poll", { max: 1, waitSec: 0 })).body.jobs).toEqual([]);
    await expect(createRunnerMachineDispatcher(p.rt, "foreign").await(id, signal())).rejects.toMatchObject({ code: "job_not_found" });
  });
});

it("normalizes direct requests and refuses invalid arguments before enqueueing", async () => {
  const p = await createPlane();
  const agent = await registerFakeAgent(p, register, { kind: "machine", capabilities: ["process.list"] });
  const d = createRunnerMachineDispatcher(p.rt);
  const req: MachineRequest = { operationId: "op_normalize", target: { workspaceId: agent.workspaceId, transport: "zenithd", targetId: agent.id }, operation: "process.list", args: {}, timeoutSec: 5, maxOutputBytes: 65536 };
  const jws = await issueGrant(p, { aud: `machine:${agent.id}`, cap: req.operation, op: req.operationId, ws: agent.workspaceId });
  await expect(d.enqueue({ ...req, args: { limit: 501 } }, jws)).rejects.toMatchObject({ code: "invalid_args" });
  expect(await p.store.machineRequests.listForOperation(agent.workspaceId, req.operationId)).toEqual([]);
  const id = await d.enqueue(req, jws);
  const delivery = await agent.post(poll, "/poll", { max: 1, waitSec: 0 });
  expect(agent.decodeJob((delivery.body.jobs as string[])[0], agent.jobTyp()).claims).toMatchObject({ jti: id, args: { limit: 50, sortBy: "cpu" } });
});

it("a silent agent past its lease is uncertain, never re-dispatched, and late reports lose", async () => {
  const p = await createPlane();
  const agent = await registerFakeAgent(p, register, { kind: "machine", capabilities: ["machine.service.restart"] });
  const d = createRunnerMachineDispatcher(p.rt);
  const req: MachineRequest = { operationId: "op_silent", target: { workspaceId: agent.workspaceId, transport: "zenithd", targetId: agent.id }, operation: "machine.service.restart", args: { unit: "nginx.service" }, timeoutSec: 5, maxOutputBytes: 65536 };
  const jws = await issueGrant(p, { aud: `machine:${agent.id}`, cap: req.operation, op: req.operationId, ws: agent.workspaceId });
  const id = await d.enqueue(req, jws);
  await agent.post(poll, "/poll", { max: 1, waitSec: 0 });
  expect(await d.await(id, signal())).toEqual({ status: "uncertain" });
  expect((await agent.post(report, `/jobs/${id}/result`, { status: "succeeded", result: {} }, {}, { jti: id })).status).toBe(409);
  expect((await agent.post(poll, "/poll", { max: 1, waitSec: 0 })).body.jobs).toEqual([]);
  expect(await p.store.machineRequests.listForOperation(agent.workspaceId, req.operationId)).toHaveLength(1);
});

it("agent-reported timeout is distinct from silence and pre-delivery expiry", async () => {
  const p = await createPlane();
  const agent = await registerFakeAgent(p, register, { kind: "machine" });
  const d = createRunnerMachineDispatcher(p.rt);
  const req: MachineRequest = { operationId: "op_timeout", target: { workspaceId: agent.workspaceId, transport: "zenithd", targetId: agent.id }, operation: "machine.inspect", args: {}, timeoutSec: 5, maxOutputBytes: 65536 };
  const jws = await issueGrant(p, { aud: `machine:${agent.id}`, cap: req.operation, op: req.operationId, ws: agent.workspaceId });
  const id = await d.enqueue(req, jws);
  await agent.post(poll, "/poll", { max: 1, waitSec: 0 });
  await agent.post(report, `/jobs/${id}/result`, { status: "timed_out", result: { ok: false, data: { error: "timeout" } } }, {}, { jti: id });
  expect(await d.await(id, signal())).toMatchObject({ status: "timed_out", result: { error: "timeout" } });
  const driver = createZenithdMachineDriver({ dispatcher: d });
  const queued = await d.enqueue(req, jws);
  const outcome = await d.await(queued, signal());
  expect(outcome).toMatchObject({ status: "rejected", result: { error: "delivery_failed" } });
  const unused = createRunnerMachineDispatcher(p.rt);
  await expect(unused.await(id, signal())).rejects.toMatchObject({ code: "invalid_request" });
  const ac = new AbortController(); ac.abort();
  await expect(d.await(id, ac.signal)).rejects.toBeDefined();
  expect(driver.supports).toContain(req.operation);
});

it("queues exact signed template metadata and refuses a revoked file.write machine", async () => {
  const p = await createPlane();
  const agent = await registerFakeAgent(p, register, { kind: "machine", capabilities: ["file.write"] });
  const dispatcher = createRunnerMachineDispatcher(p.rt);
  const args = { path: "/opt/customer/settings.txt", contentRef: "settings", contentVersion: "c".repeat(64), expectedSha256: null };
  const req: MachineRequest = { operationId: "op_template", target: { workspaceId: agent.workspaceId, resourceId: "res_fixture", transport: "zenithd", targetId: agent.id }, operation: "file.write", args, timeoutSec: 5, maxOutputBytes: 4096 };
  const grant = await issueGrant(p, { aud: `machine:${agent.id}`, cap: req.operation, op: req.operationId, ws: agent.workspaceId, res: "res_fixture" });
  await expect(dispatcher.enqueue({ ...req, args: { ...args, content: "inert-plaintext-marker" } }, grant)).rejects.toMatchObject({ code: "invalid_args" });
  const id = await dispatcher.enqueue(req, grant);
  const delivery = await agent.post(poll, "/poll", { max: 1, waitSec: 0 });
  const envelope = agent.decodeJob((delivery.body.jobs as string[])[0], agent.jobTyp());
  expect(envelope.claims).toMatchObject({ jti: id, operation: "file.write", args, grant });
  expect(JSON.stringify(envelope.claims)).not.toContain("inert-plaintext-marker");
  await p.store.machines.revoke(agent.workspaceId, agent.id);
  await expect(dispatcher.enqueue({ ...req, operationId: "op_revoked" }, grant)).rejects.toMatchObject({ code: "agent_revoked" });
  expect((await agent.post(poll, "/poll", { max: 1, waitSec: 0 })).status).not.toBe(200);
  expect(await p.store.machineRequests.listForOperation(agent.workspaceId, req.operationId)).toHaveLength(1);
});
