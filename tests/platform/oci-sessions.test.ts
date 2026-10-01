/** Real PGlite scope/audit and EdDSA signing; mocked C4/runner dispatch. No OCI cloud execution. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { CredentialRequest, OciConnectionConfig, OciSession, ProviderSession } from "@/lib/credentials/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-oci-session-contract-", { fast: true });
const jobs = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), await: vi.fn() }));
vi.mock("@/lib/runners/read-jobs", () => ({ enqueueReadJob: jobs.read }));
vi.mock("@/lib/runners/dispatch", async (original) => ({ ...await original<typeof import("@/lib/runners/dispatch")>(), enqueueRunnerJob: jobs.write, awaitRunnerJob: jobs.await }));
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { platformCredentialBroker } = await import("@/lib/platform/credentials");
const { createPlane, teardownPlane } = await import("../runners/_support");
let db: Awaited<ReturnType<typeof openPlatformDb>>;
let clock: number;
let sequence = 0;
const ws = "ws-oci-sessions";
const env = "env-oci-sessions";
const compartment = "ocid1.compartment.oc1..fixture000001";
const instance = "ocid1.instance.oc1.iad.fixture000001";
const canary = "runner-error-secret-canary";
const request = { service: "core" as const, region: "us-ashburn-1", method: "GET" as const, path: "/20160918/instances", query: { compartmentId: compartment } };
beforeAll(async () => { db = await openPlatformDb({ kind: "pglite" }); });
beforeEach(async () => {
  clock = Date.now(); await createPlane("real");
  jobs.read.mockReset().mockResolvedValue("job-read"); jobs.write.mockReset().mockResolvedValue("job-write");
  jobs.await.mockReset().mockResolvedValue({ status: "succeeded", uncertain: false, result: { status: 200, headers: {}, bodyB64: Buffer.from(JSON.stringify({ items: [] })).toString("base64") } });
});
afterEach(() => { vi.restoreAllMocks(); teardownPlane(); });
afterAll(async () => { await db.close(); });

async function setup(cap = "infrastructure.observe", purpose: CredentialRequest["purpose"] = "observe", extra: Partial<CapabilityGrantClaims> = {}) {
  const runnerId = `run-oci-${++sequence}`;
  const token = repos.runners.generateRegistrationToken("runner");
  await repos.runners.createRegistrationToken(db, { workspaceId: ws, kind: "runner", tokenHash: token.tokenHash, createdBy: "operator" });
  await repos.runners.registerRunner(db, { id: runnerId, tokenHash: token.tokenHash, name: "synthetic-oci-runner", publicKey: "a".repeat(43), capabilities: ["oci.http"] });
  const config: OciConnectionConfig = { provider: "oci", mode: "runner", runnerId, compartmentOcid: compartment, tenancyOcid: "ocid1.tenancy.oc1..fixture000001", region: "us-ashburn-1" };
  const connection = await repos.connections.create(db, { workspaceId: ws, config, createdBy: "operator" });
  await repos.connections.recordVerification(db, { workspaceId: ws, id: connection.id, ok: true, detail: "Synthetic runner registration fixture; cloud permissions unverified." });
  const grant: CapabilityGrantClaims = { jti: "grt-original", iss: "https://zenith.test", sub: "worker", aud: "worker", iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 900, op: `op-${sequence}`, digest: "d".repeat(64), cap, ws, env, constraints: { allowed: ["test"] }, ...extra };
  const req: CredentialRequest = { connectionId: connection.id, purpose, grant };
  return { config, connection, grant, req, broker: platformCredentialBroker(db, { now: () => new Date(clock) }) };
}
function asOci(s: ProviderSession): OciSession { if (s.provider !== "oci") throw new Error("Expected an OCI session."); return s; }

describe("OCI capability-scoped broker sessions", () => {
  it("queues observe requests through C4 without an operation and derives a bounded runner grant", async () => {
    const f = await setup();
    const response = await f.broker.withSession(f.req, async (s) => {
      const oci = asOci(s);
      expect(oci).toMatchObject({ provider: "oci", compartmentOcid: compartment, capability: f.grant.cap, scope: { workspaceId: ws, environmentId: env } });
      return oci.transport.request(request);
    });
    expect(response).toMatchObject({ status: 200, body: { items: [] } });
    expect(jobs.read).toHaveBeenCalledTimes(1); expect(jobs.write).not.toHaveBeenCalled();
    const queued = jobs.read.mock.calls[0][0];
    expect(queued).toMatchObject({ workspaceId: ws, environmentId: env, runnerId: f.config.runnerId, capability: "infrastructure.observe", kind: "oci.http", timeoutSec: 60, maxOutputBytes: 1024 * 1024 });
    expect(queued).not.toHaveProperty("operationId");
    expect(decodeJwt(queued.grant)).toMatchObject({ ...f.grant, aud: `runner:${f.config.runnerId}`, jti: expect.not.stringMatching("grt-original"), exp: f.grant.exp });
    expect(jobs.await.mock.calls[0][1]).toMatchObject({ workspaceId: ws });
    expect((await repos.events.list(db, ws, { limit: 100 })).some((e) => e.type === "credential.assumed")).toBe(true);
  });
  it("dispatches mutations once through operation-scoped jobs and preserves the worker's grant", async () => {
    const f = await setup("service.restart", "deploy");
    await f.broker.withSession(f.req, (s) => asOci(s).transport.request({ ...request, service: "containerinstances", method: "POST", path: `/20210415/containerInstances/${instance}/actions/restart`, query: undefined, headers: { "opc-retry-token": "safe-idempotency-token" } }));
    expect(jobs.write).toHaveBeenCalledTimes(1); expect(jobs.read).not.toHaveBeenCalled();
    expect(jobs.write.mock.calls[0][0]).toMatchObject({ operationId: f.grant.op, capability: "service.restart" });
    expect(f.grant.aud).toBe("worker"); expect(f.grant.jti).toBe("grt-original");
  });
  it.each(["resolve", "reject"])("invalidates retained transports after callback %s", async (outcome) => {
    const f = await setup(); let saved: OciSession | undefined;
    const run = f.broker.withSession(f.req, async (s) => { saved = asOci(s); if (outcome === "reject") throw new Error("callback failed"); });
    if (outcome === "reject") await expect(run).rejects.toThrow("callback failed"); else await run;
    await expect(saved!.transport.request(request)).rejects.toMatchObject({ reason: "session_ended" }); expect(jobs.read).not.toHaveBeenCalled();
  });
  it("expires during a callback and respects requested and grant lifetime caps", async () => {
    const f = await setup(); f.req.durationSec = 60;
    await f.broker.withSession(f.req, async (s) => {
      expect(Date.parse(asOci(s).expiresAt)).toBeLessThanOrEqual(clock + 60_000);
      clock += 60_001; await expect(asOci(s).transport.request(request)).rejects.toMatchObject({ reason: "session_ended" });
    }); expect(jobs.read).not.toHaveBeenCalled();
  });
  it("keeps concurrent sessions independent and rejects escalation through the transport", async () => {
    const f = await setup();
    await Promise.all([1, 2].map(() => f.broker.withSession(f.req, async (s) => {
      await expect(asOci(s).transport.request({ ...request, service: "containerinstances", method: "POST", path: `/20210415/containerInstances/${instance}/actions/restart` })).rejects.toMatchObject({ code: "oci_request_refused" });
      await asOci(s).transport.request(request);
    })));
    expect(jobs.read).toHaveBeenCalledTimes(2); expect(jobs.write).not.toHaveBeenCalled();
    expect(new Set(jobs.read.mock.calls.map(([job]) => decodeJwt(job.grant).jti)).size).toBe(2);
  });
  it("captures capability claims before a caller can mutate the request", async () => {
    const f = await setup();
    await f.broker.withSession(f.req, async (s) => { f.grant.cap = "service.restart"; f.grant.ws = "foreign"; await asOci(s).transport.request(request); });
    expect(jobs.read.mock.calls[0][0]).toMatchObject({ workspaceId: ws, capability: "infrastructure.observe" }); expect(jobs.write).not.toHaveBeenCalled();
  });
  it.each(["region", "compartment"])("refuses a foreign %s on a scoped transport", async (field) => {
    const f = await setup();
    const foreign = field === "region" ? { ...request, region: "eu-frankfurt-1" } : { ...request, query: { compartmentId: "ocid1.compartment.oc1..foreign000001" } };
    await f.broker.withSession(f.req, async (s) => { await expect(asOci(s).transport.request(foreign)).rejects.toMatchObject({ reason: "grant_invalid" }); });
    expect(jobs.read).not.toHaveBeenCalled();
  });
  it("loads only non-external, matching environment resources and honors newer observations", async () => {
    const f = await setup();
    const createResource = async (suffix: string, changes: Partial<Parameters<typeof repos.resources.upsertDesired>[1]["node"]> = {}) => repos.resources.upsertDesired(db, { workspaceId: ws, environmentId: env, node: {
      address: `machine/${sequence}-${suffix}`, kind: "compute_instance", provider: "oci", region: "us-ashburn-1", nativeType: "oci:compute_instance", ownership: "managed", externalRef: instance, spec: {}, specDigest: "d".repeat(64), dependsOn: [], origin: [], labels: {}, ...changes,
    } });
    const managed = await createResource("managed");
    await createResource("external", { ownership: "external" });
    await createResource("region", { region: "eu-frankfurt-1" });
    const missing = await createResource("missing");
    const simulated = await createResource("simulated");
    const observed = await createResource("observed");
    for (const resource of [missing, simulated, observed]) await repos.observations.appendObservation(db, { workspaceId: ws, resourceId: resource.id, observation: {
      address: resource.address, presence: resource === missing ? "missing" : "present", externalId: resource === observed ? "ocid1.instance.oc1.iad.observed000001" : instance, attributes: {}, simulated: resource === simulated, observedAt: new Date(clock).toISOString(), source: "oci:contract-test",
    } });
    await f.broker.withSession(f.req, async (s) => {
      expect(asOci(s).scope.resources.map((r) => [r.address, r.externalId])).toEqual(expect.arrayContaining([[managed.address, instance], [observed.address, "ocid1.instance.oc1.iad.observed000001"]]));
      expect(asOci(s).scope.resources).toHaveLength(2);
    });
    f.req.grant = { ...f.grant, res: managed.id };
    await f.broker.withSession(f.req, async (s) => { expect(asOci(s).scope.resources).toEqual([{ address: managed.address, nativeType: "oci:compute_instance", externalId: instance }]); });
  });
  it.each(["workspace", "revoked", "pending", "expired", "purpose", "duration"])("refuses invalid %s before dispatch", async (failure) => {
    const f = await setup();
    if (failure === "workspace") f.req.grant = { ...f.grant, ws: "foreign" };
    if (failure === "revoked") await repos.connections.revoke(db, ws, f.connection.id);
    if (failure === "pending") await db.query("update platform.provider_connections set status = 'pending_verification' where workspace_id = $1 and id = $2", [ws, f.connection.id]);
    if (failure === "expired") f.req.grant = { ...f.grant, exp: Math.floor(clock / 1000) };
    if (failure === "purpose") f.req.purpose = "deploy";
    if (failure === "duration") f.req.durationSec = 0;
    const callback = vi.fn(); await expect(f.broker.withSession(f.req, callback)).rejects.toMatchObject({ code: "credential_denied" });
    expect(callback).not.toHaveBeenCalled(); expect(jobs.read).not.toHaveBeenCalled(); expect(jobs.write).not.toHaveBeenCalled();
  });
  it.each(["missing", "revoked", "stale", "kind", "protocol"])("refuses an unavailable %s runner before callback", async (condition) => {
    const f = await setup(); const original = await repos.runners.getRunner(db, ws, f.config.runnerId);
    vi.spyOn(repos.runners, "getRunner").mockResolvedValue(condition === "missing" ? null : { ...original!, ...(condition === "revoked" ? { status: "revoked" as const } : {}), ...(condition === "stale" ? { stale: true } : {}), ...(condition === "kind" ? { capabilities: ["tofu.run"] } : {}), ...(condition === "protocol" ? { protocol: "unsupported" } : {}) });
    const callback = vi.fn(); await expect(f.broker.withSession(f.req, callback)).rejects.toMatchObject({ reason: "runner_unavailable" }); expect(callback).not.toHaveBeenCalled();
  });
  it("refuses audit failure before callback or job dispatch, with no exception leakage", async () => {
    const f = await setup(); vi.spyOn(repos.events, "append").mockRejectedValue(new Error(canary));
    const callback = vi.fn(); await expect(f.broker.withSession(f.req, callback)).rejects.toMatchObject({ reason: "audit_failed", message: expect.not.stringContaining(canary) });
    expect(callback).not.toHaveBeenCalled(); expect(jobs.read).not.toHaveBeenCalled();
  });
  it("refuses a connection revoked during a callback", async () => {
    const f = await setup();
    await f.broker.withSession(f.req, async (s) => { await repos.connections.revoke(db, ws, f.connection.id); await expect(asOci(s).transport.request(request)).rejects.toMatchObject({ reason: "session_ended" }); });
    expect(jobs.read).not.toHaveBeenCalled();
  });
  it.each(["failed", "rejected", "timed_out", "expired", "cancelled"])("never retries %s jobs or echoes remote errors", async (status) => {
    const f = await setup(); jobs.await.mockResolvedValue({ status, uncertain: status === "timed_out", error: canary });
    await f.broker.withSession(f.req, async (s) => { await expect(asOci(s).transport.request(request)).rejects.toMatchObject({ reason: "runner_unavailable", message: expect.not.stringContaining(canary) }); });
    expect(jobs.read).toHaveBeenCalledTimes(1); expect(jobs.await).toHaveBeenCalledTimes(1);
  });
  it("rejects uncertain, truncated, malformed and oversized successful job outputs", async () => {
    const f = await setup();
    for (const result of [{ status: 200, headers: {}, truncated: true }, { status: 200, headers: {}, bodyB64: Buffer.alloc(1024 * 1024 + 1).toString("base64") }, { status: "canary" }, { status: 200, headers: {}, bodyB64: "not base64" }, { status: 200, headers: "bad" }, null]) {
      jobs.await.mockResolvedValue({ status: "succeeded", uncertain: false, result });
      await f.broker.withSession(f.req, async (s) => { await expect(asOci(s).transport.request(request)).rejects.toThrow(); });
    }
    jobs.await.mockResolvedValue({ status: "succeeded", uncertain: true, result: { status: 200, headers: {} } });
    await f.broker.withSession(f.req, async (s) => { await expect(asOci(s).transport.request(request)).rejects.toMatchObject({ reason: "runner_unavailable" }); });
  });
  it("passes abort signals to awaiting and refuses already cancelled requests", async () => {
    const f = await setup(); const controller = new AbortController(); controller.abort();
    await f.broker.withSession(f.req, async (s) => { await expect(asOci(s).transport.request(request, { signal: controller.signal })).rejects.toThrow(); }); expect(jobs.read).not.toHaveBeenCalled();
  });
  it("refuses C4 reads without an environment grant", async () => {
    const f = await setup(); delete f.req.grant.env;
    await f.broker.withSession(f.req, async (s) => { await expect(asOci(s).transport.request(request)).rejects.toMatchObject({ reason: "grant_invalid" }); }); expect(jobs.read).not.toHaveBeenCalled();
  });
});
