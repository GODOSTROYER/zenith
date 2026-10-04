/** Real provider ownership assessors over modeled REST/runner receipts and isolated execution ports; no cloud or SQL proof. */
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialRequest, ProviderConnection, ProviderSession } from "@/lib/credentials/types";
import type { Observation } from "@/lib/resources/types";
import { createExecutionActivities } from "@/lib/execution/activities";
import { TofuPlanChangedError } from "@/lib/execution/errors";
import { assertDeletionAllowed } from "@/lib/tofu/plan";
import { isAllowed } from "@/lib/providers/oci/allowlist";
import { createRunnerOciTransport } from "@/lib/providers/oci/runner-transport";
import { gcpDnsWorld } from "../providers/gcp/dns-ownership-fixtures";
import { azureDnsWorld } from "../providers/azure/dns-ownership-fixtures";
import { ociDnsWorld } from "../providers/oci/dns-ownership-fixtures";
import { createWorld, type World } from "./fakes/world";
import { change, makePlan, providerConnection, OP, WS, ENV, REVISION, PROJECT, CANARY_SECRET, CANARY_SESSION_KEY } from "./fakes/fixtures";

const factories = { gcp: gcpDnsWorld, azure: azureDnsWorld, oci: ociDnsWorld };
type Provider = keyof typeof factories;
type Cloud = ReturnType<typeof gcpDnsWorld> | ReturnType<typeof azureDnsWorld> | ReturnType<typeof ociDnsWorld>;
const worlds: World[] = [];
afterEach(() => { worlds.splice(0).forEach(world => world.dispose()); vi.restoreAllMocks(); });

function recordReads(cloud: Cloud): number {
  return "jobs" in cloud ? cloud.jobs.filter(job => job.path.includes("/records/")).length
    : cloud.fetch.mock.calls.filter(([url]) => url.includes("/rrsets/") || url.includes("/CNAME/") || url.includes("/A/")).length;
}
function repoint(cloud: Cloud): void {
  if ("records" in cloud.state) cloud.state.records = { items: [{ domain: "app.example.com", rtype: "A", rdata: "203.0.113.99" }] };
  else if ("rule" in cloud.state) cloud.state.record.rrdatas = ["203.0.113.99"];
  else cloud.state.record.properties = { CNAMERecord: { cname: "foreign-target-canary.example.test" } };
}
async function fixture(provider: Provider, cloud: Cloud = factories[provider](WS, ENV)) {
  const w = createWorld({ op: { capability: "infrastructure.destroy" } }); worlds.push(w);
  w.product.base.environment.provider = provider;
  w.product.base.environment.region = cloud.node.region;
  w.product.base.environment.deployedRevisionId = REVISION;
  w.product.setManifest({ version: 1, services: [], resources: [], routes: [], bindings: [] }, REVISION);
  const config: ProviderConnection["config"] = provider === "gcp" ? {
    provider, mode: "oidc_web_identity", region: cloud.node.region, projectId: "acme-prod-123456",
    workloadIdentityProvider: "projects/123/locations/global/workloadIdentityPools/owned/providers/owned",
    observeServiceAccount: "observe@acme-prod-123456.iam.gserviceaccount.com", deployServiceAccount: "deploy@acme-prod-123456.iam.gserviceaccount.com",
  } : provider === "azure" ? {
    provider, mode: "oidc_web_identity", region: cloud.node.region, tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    clientId: "99999999-8888-7777-6666-555555555555", subscriptionId: "11111111-2222-3333-4444-555555555555",
  } : {
    provider, mode: "runner", region: cloud.node.region, runnerId: "modeled-owning-runner",
    tenancyOcid: "ocid1.tenancy.oc1..owned1", compartmentOcid: "ocid1.compartment.oc1..owned1",
  };
  w.connections.connections = [providerConnection({ config })];
  for (const node of cloud.nodes) await w.resources.upsertDesired({ workspaceId: WS, projectId: PROJECT, environmentId: ENV, node });
  const requests: CredentialRequest[] = [];
  const control: { beforeDispatch?: () => void; session?: (session: ProviderSession, req: CredentialRequest) => ProviderSession } = {};
  const credentials = {
    verifyConnection: w.credentials.verifyConnection.bind(w.credentials),
    async withSession<T>(req: CredentialRequest, fn: (session: ProviderSession) => Promise<T>): Promise<T> {
      requests.push(req);
      expect(req.grant).toMatchObject({ ws: WS, proj: PROJECT, env: ENV, op: OP });
      expect(req.purpose === "observe").toBe(["infrastructure.plan", "infrastructure.observe"].includes(req.grant.cap));
      let session: ProviderSession = cloud.ctx.session;
      if (session.provider === "oci" && "dispatch" in cloud) session = { ...session, capability: req.grant.cap,
        scope: { workspaceId: req.grant.ws, projectId: req.grant.proj, environmentId: req.grant.env, resources: [] },
        transport: createRunnerOciTransport(cloud.dispatch, { capability: req.grant.cap }) };
      return fn(control.session?.(session, req) ?? session);
    },
  };
  w.tofu.planFactory = ws => makePlan({ configDigest: ws.configDigest, lockDigest: ws.lockDigest,
    changes: cloud.nodes.map(node => change({ address: `terraform_data.${node.address.replace(/[^a-z0-9]/g, "_")}`, type: "terraform_data", nodeAddress: node.address, action: "delete" })) });
  w.activities = createExecutionActivities({ ...w.deps, credentials,
    tofuWorkspace: { providerSet: () => "builtin", backend: () => ({ backend: { kind: "local", path: path.join(w.planDir, "state") } }) },
    tofu: {
      planWorkspace: w.tofu.planWorkspace.bind(w.tofu),
      async applyVerifiedPlan(ws, args) {
        // Model the existing engine's inspection then dispatch then effect order.
        // Keep the real activity guards and isolated original custody callback.
        const plan = w.tofu.planFactory(ws, 0);
        if (plan.planDigest !== args.approvedDigest) throw new TofuPlanChangedError(args.approvedDigest, plan.planDigest);
        await args.inspectPlan?.(plan, {});
        assertDeletionAllowed(plan, args.deletionNodes ?? []);
        control.beforeDispatch?.();
        await args.beforeDispatch?.();
        return w.tofu.applyVerifiedPlan(ws, { ...args, beforeDispatch: undefined });
      },
    },
  });
  await w.activities.markOperation({ operationId: OP, status: "running" });
  return { w, cloud, requests, control };
}
async function reviewed(f: Awaited<ReturnType<typeof fixture>>) {
  const lease = await f.w.lease();
  const plan = await f.w.activities.planDestroyInfrastructure({ operationId: OP, lease });
  f.w.broker.approval = { approved: true, rejected: false, approvalId: "human-browser-contract" };
  return { operationId: OP, planDigest: plan.planDigest, lease };
}

describe.each(["gcp", "azure", "oci"] as const)("%s destroy DNS ownership [modeled provider contracts]", provider => {
  it("reviews current owned DNS, requires human approval, rereads before dispatch and retains separate absence verification", async () => {
    const f = await fixture(provider), args = await reviewed(f);
    expect(recordReads(f.cloud)).toBe(1);
    await f.w.activities.finalDestroyPlan({ ...args, approvedPlanDigest: args.planDigest });
    expect(recordReads(f.cloud)).toBe(2);
    f.w.broker.approval = { approved: true, rejected: false };
    await expect(f.w.activities.applyDestroyInfrastructure(args)).rejects.toThrow(/approval/);
    expect(recordReads(f.cloud)).toBe(2);
    f.w.broker.approval.approvalId = "human-browser-contract";
    await expect(f.w.activities.applyDestroyInfrastructure(args)).resolves.toEqual({ deleted: f.cloud.nodes.length });
    expect(recordReads(f.cloud)).toBe(5);
    expect(f.w.tofu.applyCalls).toHaveLength(1);
    expect(f.w.resources.rows.values().next().value?.status).not.toBe("deleted");
    expect(f.requests.filter(req => req.purpose === "deploy").map(req => req.grant.cap)).toEqual(["infrastructure.destroy"]);
    expect(f.w.stored() + JSON.stringify(f.w.logs)).not.toContain(CANARY_SECRET);
    expect(f.w.stored() + JSON.stringify(f.w.logs)).not.toContain(CANARY_SESSION_KEY);
    expect(f.w.stored() + JSON.stringify(f.w.logs)).not.toContain("domain-proof-canary");
  });

  it.each(["foreign target", "unreadable record", "transport error"] as const)("refuses %s during review before invoking the engine, without cloud values in the refusal", async fault => {
    const f = await fixture(provider);
    if (fault === "foreign target") repoint(f.cloud);
    if (fault === "unreadable record") f.cloud.state.recordStatus = 403;
    if (fault === "transport error") {
      if ("fetch" in f.cloud) f.cloud.fetch.mockRejectedValue(new Error("secret-provider-canary"));
      else f.cloud.dispatch.mockRejectedValue(new Error("secret-provider-canary"));
    }
    const error: unknown = await f.w.activities.planDestroyInfrastructure({ operationId: OP, lease: await f.w.lease() }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/target ownership/);
    expect((error as Error).message + f.w.stored() + JSON.stringify(f.w.logs)).not.toContain("secret-provider-canary");
    expect((error as Error).message + f.w.stored() + JSON.stringify(f.w.logs)).not.toContain("foreign-target-canary");
    expect(f.w.tofu.planCalls).toHaveLength(0);
    expect(f.w.tofu.applyCalls).toHaveLength(0);
  });

  it("refuses a target changed after inspection during the final human approval lookup before original dispatch", async () => {
    const f = await fixture(provider), args = await reviewed(f);
    let checks = 0;
    vi.spyOn(f.w.broker, "approvalStatus").mockImplementation(async () => {
      if (++checks === 2) repoint(f.cloud);
      return f.w.broker.approval;
    });
    await expect(f.w.activities.applyDestroyInfrastructure(args)).rejects.toThrow(/target ownership/);
    expect(recordReads(f.cloud)).toBe(4);
    expect(f.w.tofu.applyCalls).toHaveLength(0);
    expect(f.w.ops.uncertain).toHaveLength(0);
    expect(f.w.evidence.ofKind("tofu_apply")).toHaveLength(0);
  });

  it.each(["workspace", "environment"] as const)("refuses a live target owned by a foreign %s during review", async scope => {
    const cloud = factories[provider](scope === "workspace" ? "ws-foreign" : WS, scope === "environment" ? "env-foreign" : ENV);
    const f = await fixture(provider, cloud);
    await expect(f.w.activities.planDestroyInfrastructure({ operationId: OP, lease: await f.w.lease() })).rejects.toThrow(/target ownership/);
    expect(recordReads(cloud)).toBe(1);
    expect(f.w.tofu.planCalls).toHaveLength(0);
    expect(f.w.tofu.applyCalls).toHaveLength(0);
  });

  it.each(["unmapped type", "non-managed record", "missing historical target", "foreign provider session", "wrong environment lease"] as const)("refuses %s without widening ownership or touching the provider", async fault => {
    const f = await fixture(provider);
    const record = f.w.resources.rows.get(`${ENV}|${f.cloud.node.address}`)!;
    if (fault === "unmapped type") record.nativeType = "unsupported:dns_record";
    if (fault === "non-managed record") record.ownership = "referenced";
    if (fault === "missing historical target") f.w.resources.rows.delete(`${ENV}|${String(record.spec.target)}`);
    if (fault === "foreign provider session") f.control.session = () => provider === "gcp"
      ? azureDnsWorld(WS, ENV).ctx.session : gcpDnsWorld(WS, ENV).ctx.session;
    const lease = await f.w.lease();
    await expect(f.w.activities.planDestroyInfrastructure({ operationId: OP, lease: fault === "wrong environment lease" ? { ...lease, scope: "env:foreign" } : lease })).rejects.toThrow();
    expect(recordReads(f.cloud)).toBe(0);
    expect(f.w.tofu.applyCalls).toHaveLength(0);
  });

  it("retains reviewed digest and current human approval refusals despite safe DNS ownership", async () => {
    const f = await fixture(provider), args = await reviewed(f);
    await expect(f.w.activities.applyDestroyInfrastructure({ ...args, planDigest: "f".repeat(64) })).rejects.toThrow(/digest/);
    f.w.broker.approval = { approved: false, rejected: true, approvalId: "human-browser-contract" };
    await expect(f.w.activities.applyDestroyInfrastructure(args)).rejects.toThrow(/approval/);
    expect(recordReads(f.cloud)).toBe(1);
    expect(f.w.tofu.applyCalls).toHaveLength(0);
  });

  it("refuses a revoked current connection after inspection before dispatch", async () => {
    const f = await fixture(provider), args = await reviewed(f);
    f.control.beforeDispatch = () => { f.w.connections.connections[0].status = "revoked"; };
    await expect(f.w.activities.applyDestroyInfrastructure(args)).rejects.toThrow(/connection/);
    expect(f.w.tofu.applyCalls).toHaveLength(0);
    expect(f.w.evidence.ofKind("tofu_apply")).toHaveLength(0);
  });

  it("keeps a provider timeout after accepted dispatch uncertain and never claims resource absence", async () => {
    const f = await fixture(provider), args = await reviewed(f);
    f.w.tofu.apply = "timeout";
    await expect(f.w.activities.applyDestroyInfrastructure(args)).rejects.toThrow(/confirmed outcome/);
    expect(f.w.ops.ops.get(OP)?.status).toBe("uncertain");
    expect([...f.w.resources.rows.values()].every(row => row.status !== "deleted")).toBe(true);
    expect(f.w.evidence.ofKind("tofu_apply")).toHaveLength(0);
  });

  it.each(["missing", "present", "inaccessible", "simulated missing"] as const)("independent readback treats %s honestly after accepted DNS dispatch", async outcome => {
    const f = await fixture(provider), args = await reviewed(f);
    await f.w.activities.applyDestroyInfrastructure(args);
    for (const node of f.cloud.nodes) f.w.drivers(provider, node.nativeType)!.observe = async (_ctx, current) => ({
      address: current.address, presence: outcome === "simulated missing" ? "missing" : outcome,
      attributes: {}, source: "modeled-provider-readback", observedAt: "2026-10-04T00:00:00Z", simulated: outcome === "simulated missing",
    } satisfies Observation);
    const verified = await f.w.activities.verifyDestroyedInfrastructure(args);
    expect(verified.status).toBe(outcome === "missing" ? "passed" : outcome === "present" ? "failed" : "unknown");
    expect([...f.w.resources.rows.values()].every(row => row.status === (outcome === "missing" ? "deleted" : "unknown"))).toBe(true);
    expect(f.requests.at(-1)).toMatchObject({ purpose: "observe", grant: { cap: "infrastructure.observe", op: OP, ws: WS, env: ENV } });
  });
});

describe("Azure companion DNS and OCI scoped read authorization [modeled provider contracts]", () => {
  it.each(["foreign TXT", "unreadable TXT", "absent primary with foreign TXT"] as const)("Azure refuses %s after approval even when its routed CNAME is owned", async fault => {
    const cloud = azureDnsWorld(WS, ENV), f = await fixture("azure", cloud), args = await reviewed(f);
    if (fault !== "unreadable TXT") cloud.state.txt.properties = { TXTRecords: [{ value: ["foreign-proof-canary"] }] };
    else cloud.state.txtStatus = 403;
    if (fault === "absent primary with foreign TXT") cloud.state.recordStatus = 404;
    await expect(f.w.activities.applyDestroyInfrastructure(args)).rejects.toThrow(/target ownership/);
    expect(f.w.tofu.applyCalls).toHaveLength(0);
    expect(f.w.stored() + JSON.stringify(f.w.logs)).not.toContain("foreign-proof-canary");
  });

  it.each(["apex", "static site"] as const)("Azure retains its existing owned %s target contract through review and dispatch", async shape => {
    const cloud = azureDnsWorld(WS, ENV, shape === "apex", shape === "static site");
    const f = await fixture("azure", cloud), args = await reviewed(f);
    await expect(f.w.activities.applyDestroyInfrastructure(args)).resolves.toEqual({ deleted: cloud.nodes.length });
    expect(recordReads(cloud)).toBe(4);
    expect(cloud.fetch.mock.calls.some(([url]) => url.includes("/TXT/"))).toBe(shape === "apex");
    expect(f.w.stored() + JSON.stringify(f.w.logs)).not.toContain("domain-proof-canary");
  });

  it("OCI uses new read grants for ownership while retaining the exact destroy grant and original custody effect", async () => {
    const cloud = ociDnsWorld(WS, ENV), f = await fixture("oci", cloud), args = await reviewed(f);
    expect(isAllowed("infrastructure.destroy", cloud.jobs[0])).toBe(false);
    await f.w.activities.applyDestroyInfrastructure(args);
    expect(f.requests.map(req => [req.purpose, req.grant.cap])).toEqual([
      ["observe", "infrastructure.plan"], ["deploy", "infrastructure.destroy"],
      ["observe", "infrastructure.plan"], ["observe", "infrastructure.plan"], ["observe", "infrastructure.plan"],
    ]);
    for (const req of f.requests) expect(req.grant).toMatchObject({ op: OP, ws: WS, proj: PROJECT, env: ENV, fence: args.lease.fenceToken });
    expect(new Set(f.requests.map(req => req.grant.jti)).size).toBe(f.requests.length);
    expect(cloud.jobs.every(job => job.method === "GET" && job.bodyB64 === undefined && isAllowed("infrastructure.plan", job))).toBe(true);
    expect(f.w.tofu.applyCalls).toHaveLength(1);
  });

  it.each(["denied read grant", "foreign read scope", "wrong read capability", "truncated runner receipt"] as const)("OCI refuses %s without a destroy-grant fallback or original effect", async fault => {
    const cloud = ociDnsWorld(WS, ENV), f = await fixture("oci", cloud), args = await reviewed(f);
    if (fault === "denied read grant") {
      const original = f.w.broker.issueGrant.bind(f.w.broker);
      vi.spyOn(f.w.broker, "issueGrant").mockImplementation((id, audience, fence, opts) => opts?.capability === "infrastructure.plan"
        ? Promise.reject(new Error("secret-denial-canary")) : original(id, audience, fence, opts));
    }
    if (fault === "foreign read scope" || fault === "wrong read capability") f.control.session = (session, req) => session.provider === "oci" && req.purpose === "observe"
      ? fault === "foreign read scope" ? { ...session, scope: { ...session.scope, environmentId: "foreign" } } : { ...session, capability: "infrastructure.destroy" }
      : session;
    if (fault === "truncated runner receipt") cloud.dispatch.mockResolvedValue({ status: 200, headers: {}, bodyB64: Buffer.from("{}").toString("base64"), truncated: true });
    const error: unknown = await f.w.activities.applyDestroyInfrastructure(args).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/target ownership/);
    expect((error as Error).message + f.w.stored() + JSON.stringify(f.w.logs)).not.toContain("secret-denial-canary");
    expect(f.w.tofu.applyCalls).toHaveLength(0);
    expect(f.w.evidence.ofKind("tofu_apply")).toHaveLength(0);
  });
});
