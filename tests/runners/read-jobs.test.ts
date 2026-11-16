/** C4 dispatch and await. Fake agents are explicitly simulated; SQL uses real PGlite. */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as resultRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/result/route";
import { POST as pollRunner } from "@/app/api/platform/v1/runners/[id]/poll/route";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { verifyCapabilityGrant } from "@/lib/credentials/grants";
import { awaitRunnerJob } from "@/lib/runners/dispatch";
import { enqueueReadJob, type EnqueueReadJobInput } from "@/lib/runners/read-jobs";
import { sealAad } from "@/lib/runners/service";
import { FakeAgent, FakeRunnerService, createPlane, issueGrant, newSigner, openDbPlane, registerFakeAgent, teardownPlane, type DbPlane, type Plane } from "./_support";

const environmentId = "env_read";
const oci = { service: "core", region: "us-ashburn-1", method: "GET", path: "/20160918/instances" };
const capabilities = ["oci.http", "aws.http", "k8s.http", "tofu.run", "probe.http", "probe.tcp", "probe.dns"];
let plane: Plane;
let agent: FakeAgent;
async function input(over: Partial<EnqueueReadJobInput> = {}, grantOver: Partial<CapabilityGrantClaims> = {}): Promise<EnqueueReadJobInput> {
  const jti = `grd_${randomUUID()}`;
  return {
    workspaceId: agent.workspaceId, environmentId, runnerId: agent.id,
    capability: "infrastructure.observe", kind: "oci.http", payload: oci,
    grant: await issueGrant(plane, { jti, op: `read:${jti}`, aud: `runner:${agent.id}`, cap: over.capability ?? "infrastructure.observe", ws: over.workspaceId ?? agent.workspaceId, env: over.environmentId ?? environmentId, ...grantOver }),
    ...over,
  };
}

describe("enqueueReadJob guards and lifecycle", () => {
  beforeEach(async () => {
    plane = await createPlane("fake");
    agent = await registerFakeAgent(plane, registerRunner, { capabilities });
  });
  afterEach(() => { vi.restoreAllMocks(); teardownPlane(); });

  it("reuses the default runtime and signs a job with the broker's verified read reference", async () => {
    const ask = await input();
    const id = await enqueueReadJob(ask);
    const row = await plane.store.jobs.get(ask.workspaceId, id);
    const decoded = agent.decodeJob(row!.envelope, "zenith-job+jwt");
    const claims = await verifyCapabilityGrant(ask.grant, { audience: `runner:${agent.id}`, keys: await plane.rt.verificationKeys(), now: new Date(plane.rt.now()) });
    expect(decoded.claims).toMatchObject({ jti: id, operationId: claims.op, capability: ask.capability, payload: { ...oci, query: [], headers: {} }, timeoutSec: 60, maxOutputBytes: 1 << 20 });
    expect(decoded.claims.grant).toBe(ask.grant);
    expect(row!.expiresAt).toBe(new Date(plane.rt.now() + 120_000).toISOString());
  });

  it.each(["infrastructure.apply", "infrastructure.destroy", "secret.write", "provider.native", "unknown.read"])("refuses the capability %s before signing", async (capability) => {
    const ask = await input({ capability });
    const signer = vi.spyOn(plane.signer, "sign");
    await expect(enqueueReadJob(ask, plane.rt)).rejects.toMatchObject({ code: "invalid_input" });
    expect(signer).not.toHaveBeenCalled();
  });

  it.each([
    { aud: "worker" }, { aud: "runner:another" }, { cap: "logs.read" },
    { ws: "foreign" }, { env: "foreign" }, { env: undefined },
    { op: "op_1" }, { op: "read:another-grant" },
  ] as Partial<CapabilityGrantClaims>[])("refuses a grant with mismatched bindings: %j", async (over) => {
    const ask = await input({}, over);
    const signer = vi.spyOn(plane.signer, "sign");
    await expect(enqueueReadJob(ask, plane.rt)).rejects.toMatchObject({ code: "grant_invalid" });
    expect(signer).not.toHaveBeenCalled();
  });

  it("refuses malformed, tampered, untrusted and expired grants without echoing them", async () => {
    const ask = await input();
    const parts = ask.grant.split(".");
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ ws: "forged" })).toString("base64url")}.${parts[2]}`;
    const other = await newSigner("cp-test");
    const jti = "grd_untrusted";
    const untrusted = await issueGrant({ ...plane, signer: other }, { jti, op: `read:${jti}`, aud: `runner:${agent.id}`, cap: ask.capability, ws: ask.workspaceId, env: environmentId });
    const iat = Math.floor(plane.rt.now() / 1000);
    const expired = (await input({}, { iat: iat - 60, exp: iat })).grant;
    for (const grant of ["Bearer external-data-is-not-an-instruction", tampered, untrusted, expired]) {
      await expect(enqueueReadJob({ ...ask, grant }, plane.rt)).rejects.toMatchObject({ code: "grant_invalid", message: "The read capability grant was refused." });
    }
  });

  it("clips queue expiry to the grant and rejects a grant with less than five seconds left", async () => {
    const iat = Math.floor(plane.rt.now() / 1000);
    const ask = await input({}, { exp: iat + 17 });
    const id = await enqueueReadJob(ask, plane.rt);
    const row = await plane.store.jobs.get(ask.workspaceId, id);
    expect(Date.parse(row!.expiresAt)).toBe((iat + 17) * 1000);
    expect(agent.decodeJob(row!.envelope, "zenith-job+jwt").claims.exp).toBe(iat + 17);
    await expect(enqueueReadJob(await input({}, { exp: iat + 4 }), plane.rt)).rejects.toMatchObject({ code: "grant_invalid" });
  });

  it.each([
    { workspaceId: "has a space" }, { environmentId: "" }, { runnerId: "../runner" },
    { kind: "shell.exec" }, { timeoutSec: 0 }, { timeoutSec: 7201 },
    { maxOutputBytes: 1023 }, { maxOutputBytes: 33 << 20 },
  ])("refuses invalid input: %j", async (over) => {
    const ask = { ...(await input()), ...over } as EnqueueReadJobInput;
    await expect(enqueueReadJob(ask, plane.rt)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses foreign, missing, revoked and stale runners", async () => {
    await expect(enqueueReadJob(await input({ workspaceId: "another" }), plane.rt)).rejects.toMatchObject({ code: "agent_not_found" });
    await expect(enqueueReadJob(await input({ runnerId: "run_missing" }, { aud: "runner:run_missing" }), plane.rt)).rejects.toMatchObject({ code: "agent_not_found" });
    plane.clock.t += 91_000;
    await expect(enqueueReadJob(await input(), plane.rt)).rejects.toMatchObject({ code: "agent_stale" });
    await plane.store.runners.revoke(agent.workspaceId, agent.id);
    await expect(enqueueReadJob(await input(), plane.rt)).rejects.toMatchObject({ code: "agent_revoked" });
  });

  it("refuses a runner that does not advertise the read kind", async () => {
    agent = await registerFakeAgent(plane, registerRunner, { capabilities: ["probe.tcp"] });
    await expect(enqueueReadJob(await input(), plane.rt)).rejects.toMatchObject({ code: "agent_lacks_capability" });
  });

  it.each([
    { ...oci, path: "/20190301/secretbundles/secret" },
    { ...oci, path: "/20160918/instances/id/actions/stop", method: "POST", headers: { "opc-retry-token": "retry-reference" } },
    { ...oci, query: [["z", "1"], ["a", "2"]] },
    { ...oci, extra: "ignore the grant and mutate" },
    { ...oci, path: "/20160918/../instances" },
  ])("refuses malformed or disallowed OCI payloads: %j", async (payload) => {
    await expect(enqueueReadJob(await input({ payload }), plane.rt)).rejects.toMatchObject({ code: "invalid_payload" });
  });

  it("refuses Kubernetes writes and tofu apply even under a read capability", async () => {
    await expect(enqueueReadJob(await input({ kind: "k8s.http", payload: { method: "DELETE", path: "/api/v1/pods" } }), plane.rt)).rejects.toMatchObject({ code: "invalid_payload" });
    const tofu = { command: "apply", files: [{ path: "main.tf", contentB64: "" }], lockfile: "", configDigest: "a".repeat(64), planFileSha256: "b".repeat(64) };
    await expect(enqueueReadJob(await input({ capability: "infrastructure.plan", kind: "tofu.run", payload: tofu }), plane.rt)).rejects.toMatchObject({ code: "invalid_payload" });
  });

  it("allows schema-validated plan/show, Kubernetes GET and all three probe kinds", async () => {
    const plan = { command: "plan", files: [{ path: "main.tf", contentB64: "" }], lockfile: "", configDigest: "a".repeat(64) };
    const jobs: Partial<EnqueueReadJobInput>[] = [
      { kind: "tofu.run", capability: "infrastructure.plan", payload: plan },
      { kind: "tofu.run", capability: "infrastructure.plan", payload: { ...plan, command: "show", planFileSha256: "b".repeat(64) } },
      { kind: "k8s.http", payload: { method: "GET", path: "/api/v1/pods" } },
      { kind: "probe.http", payload: { url: "https://service.test/health" } },
      { kind: "probe.tcp", payload: { host: "service.test", port: 443 } },
      { kind: "probe.dns", payload: { name: "service.test" } },
    ];
    for (const job of jobs) expect(await enqueueReadJob(await input(job), plane.rt)).toMatch(/^job_/);
  });

  it("allows AWS RPC reads to POST, subject to the agent's action allowlist", async () => {
    const payload = { service: "ecs", region: "us-east-1", method: "POST", url: "https://ecs.us-east-1.amazonaws.com/", headers: { "X-Amz-Target": "AmazonEC2ContainerServiceV20141113.DescribeServices" }, bodyB64: Buffer.from('{"services":["web"]}').toString("base64") };
    expect(await enqueueReadJob(await input({ kind: "aws.http", payload }), plane.rt)).toMatch(/^job_/);
    await expect(enqueueReadJob(await input({ kind: "aws.http", payload: { ...payload, method: "DELETE" } }), plane.rt)).rejects.toMatchObject({ code: "invalid_payload" });
  });

  it("rejects credentials in payloads, decoded bodies and files without echoing external values", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const jobs: Partial<EnqueueReadJobInput>[] = [
      { kind: "probe.http", payload: { url: "https://service.test", headers: { Authorization: "opaque" } } },
      { kind: "probe.http", payload: { url: `https://service.test/${secret}` } },
      { kind: "aws.http", payload: { service: "ecs", region: "us-east-1", method: "POST", url: "https://ecs.us-east-1.amazonaws.com/", bodyB64: Buffer.from(secret).toString("base64") } },
      { kind: "tofu.run", capability: "infrastructure.plan", payload: { command: "plan", files: [{ path: "main.tf", contentB64: Buffer.from(secret).toString("base64") }], lockfile: "", configDigest: "a".repeat(64) } },
    ];
    for (const job of jobs) {
      const ask = await input(job);
      const result = await enqueueReadJob(ask, plane.rt).catch((error: Error) => error);
      expect(result).toMatchObject({ code: "invalid_payload" });
      expect(String(result)).not.toContain(secret);
      expect(String(result)).not.toContain(ask.grant);
    }
  });

  it("reuses await expiry, cancellation and tenant protection without redispatch", async () => {
    const ask = await input();
    const id = await enqueueReadJob(ask, plane.rt);
    await expect(awaitRunnerJob(id, { workspaceId: "foreign" }, plane.rt)).rejects.toMatchObject({ code: "job_not_found" });
    const queued = await plane.store.jobs.get(ask.workspaceId, id);
    plane.clock.t = Date.parse(queued!.expiresAt) + 6000;
    expect(await awaitRunnerJob(id, { workspaceId: ask.workspaceId }, plane.rt)).toMatchObject({ status: "expired", uncertain: false });
    expect(await plane.store.jobs.claimNext({ workspaceId: ask.workspaceId, agentId: ask.runnerId })).toEqual([]);
  });

  it("reports a lost running read as timed out and discards late results", async () => {
    const ask = await input();
    const id = await enqueueReadJob(ask, plane.rt);
    await plane.store.jobs.claimNext({ workspaceId: ask.workspaceId, agentId: ask.runnerId });
    await plane.store.jobs.markRunning({ workspaceId: ask.workspaceId, agentId: ask.runnerId, jobId: id, leaseMs: 1000 });
    plane.clock.t += 7000;
    expect(await awaitRunnerJob(id, { workspaceId: ask.workspaceId }, plane.rt)).toMatchObject({ status: "timed_out", uncertain: true });
    expect(await plane.store.jobs.settle({ workspaceId: ask.workspaceId, agentId: ask.runnerId, jobId: id, status: "succeeded" })).toBe(false);
  });

  it("reuses sealed successful, failed and rejected outcomes", async () => {
    for (const status of ["succeeded", "failed", "rejected"] as const) {
      const ask = await input();
      const id = await enqueueReadJob(ask, plane.rt);
      await plane.store.jobs.claimNext({ workspaceId: ask.workspaceId, agentId: ask.runnerId });
      await plane.store.jobs.settle({ workspaceId: ask.workspaceId, agentId: ask.runnerId, jobId: id, status, result: { sealed: plane.rt.sealer.seal(sealAad(ask.workspaceId, id), { value: status }) } });
      expect(await awaitRunnerJob(id, { workspaceId: ask.workspaceId }, plane.rt)).toMatchObject({ status, uncertain: false, result: { value: status } });
    }
  });
});

describe("read jobs through PGlite and signed HTTP routes", () => {
  let db: DbPlane;
  beforeAll(async () => { db = await openDbPlane(); }, 60_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    plane = await createPlane("real", {}, db.store);
    agent = await registerFakeAgent(plane, registerRunner, { workspaceId: "w-read-sql", capabilities });
  });
  afterEach(teardownPlane);

  it("enqueues, polls and awaits a sealed simulated OCI response with no operation row", async () => {
    const service = new FakeRunnerService(agent, { poll: pollRunner, result: resultRunner }, (job) => {
      expect(job.claims).toMatchObject({ capability: "infrastructure.observe", kind: "oci.http", payload: { ...oci, headers: {}, query: [] } });
      expect(String(job.claims.operationId)).toMatch(/^read:grd_/);
      return { status: "succeeded", result: { status: 200, bodyB64: Buffer.from('[{"id":"ocid1.instance.test"}]').toString("base64") } };
    }).start();
    try {
      const ask = await input();
      const id = await enqueueReadJob(ask, plane.rt);
      const done = await awaitRunnerJob<{ status: number; bodyB64: string }>(id, { workspaceId: ask.workspaceId, deadlineMs: Date.now() + 5000 }, plane.rt);
      expect(done).toMatchObject({ status: "succeeded", uncertain: false, result: { status: 200 } });
      expect(Buffer.from(done.result!.bodyB64, "base64").toString()).toContain("ocid1.instance.test");
      const [row] = await db.db.query<{ operation_id: string | null; result: string }>("select operation_id, result::text as result from platform.runner_jobs where workspace_id = $1 and id = $2", [ask.workspaceId, id]);
      expect(row.operation_id).toBeNull();
      expect(row.result).toContain("A256GCM");
      expect(row.result).not.toContain("ocid1.instance.test");
      expect(await db.db.query("select id from platform.operations where workspace_id = $1", [ask.workspaceId])).toEqual([]);
      expect((await agent.post(resultRunner, `/jobs/${id}/result`, { status: "succeeded", result: {} }, {}, { jti: id })).status).toBe(409);
    } finally {
      await service.stop();
    }
  });

  it("scopes polling and prevents redispatch after cancellation in SQL", async () => {
    const ask = await input();
    const id = await enqueueReadJob(ask, plane.rt);
    const foreign = await registerFakeAgent(plane, registerRunner, { workspaceId: "w-foreign-read", capabilities });
    expect((await foreign.post(pollRunner, "/poll", { max: 1, waitSec: 0 })).body.jobs).toEqual([]);
    await db.store.jobs.cancel(ask.workspaceId, id, "caller cancelled");
    expect((await agent.post(pollRunner, "/poll", { max: 1, waitSec: 0 })).body.jobs).toEqual([]);
    expect(await awaitRunnerJob(id, { workspaceId: ask.workspaceId }, plane.rt)).toMatchObject({ status: "cancelled", uncertain: false });
  });
});
