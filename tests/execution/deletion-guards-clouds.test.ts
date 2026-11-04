/** Fake execution ports plus mocked provider REST/runner responses; no clouds. */
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import type { CredentialRequest, ProviderSession } from "@/lib/credentials/types";
import { createExecutionActivities } from "@/lib/execution/activities";
import { TofuPlanChangedError } from "@/lib/execution/errors";
import { assertDeletionAllowed } from "@/lib/tofu/plan";
import { createRunnerOciTransport } from "@/lib/providers/oci/runner-transport";
import { inspectDeployDeletions, assertDeployDeletionApproval, deployDeletionFacts } from "@/lib/execution/plan";
import { createRuntime } from "@/lib/execution/runtime";
import { loadExecContext } from "@/lib/execution/context";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { gcpDnsWorld } from "../providers/gcp/dns-ownership-fixtures";
import { azureDnsWorld } from "../providers/azure/dns-ownership-fixtures";
import { ociDnsWorld } from "../providers/oci/dns-ownership-fixtures";
import { createWorld, type World } from "./fakes/world";
import { change, makePlan, OP, WS, ENV, REVISION, PROJECT } from "./fakes/fixtures";

const factories = { gcp: gcpDnsWorld, azure: azureDnsWorld, oci: ociDnsWorld };
const worlds: World[] = [];
afterEach(() => worlds.splice(0).forEach((w) => w.dispose()));

describe.each(["gcp", "azure", "oci"] as const)("%s deploy DNS guards", (provider) => {
  it("runs plan, final plan and exact apply through broker callbacks, requiring human approval", async () => {
    const cloud = factories[provider](WS, ENV);
    const w = createWorld(); worlds.push(w);
    w.product.base.environment.provider = provider;
    w.product.base.environment.region = cloud.node.region;
    w.product.setManifest({ version: 1, services: [], resources: [], routes: [], bindings: [] }, REVISION);
    for (const node of cloud.nodes) await w.resources.upsertDesired({ workspaceId: WS, environmentId: ENV, projectId: PROJECT, node });
    const brokerRequests: CredentialRequest[] = [];
    const credentials = {
      verifyConnection: w.credentials.verifyConnection.bind(w.credentials),
      async withSession<T>(req: CredentialRequest, fn: (session: ProviderSession) => Promise<T>): Promise<T> {
        brokerRequests.push(req);
        let session: ProviderSession = cloud.ctx.session;
        if (session.provider === "oci" && "dispatch" in cloud) session = { ...session, capability: req.grant.cap, transport: createRunnerOciTransport(cloud.dispatch, { capability: req.grant.cap }) };
        return fn(session);
      },
    };
    w.tofu.planFactory = (ws) => makePlan({ configDigest: ws.configDigest, lockDigest: ws.lockDigest, changes: [change({ address: "terraform_data.dns_record_app_example_com", type: "terraform_data", action: "delete", nodeAddress: cloud.node.address })] });
    w.activities = createExecutionActivities({ ...w.deps, credentials,
      tofuWorkspace: { providerSet: () => "builtin", backend: () => ({ backend: { kind: "local", path: path.join(w.planDir, "state") } }) },
      tofu: {
        async planWorkspace(ws, session, opts = {}) {
          const result = await w.tofu.planWorkspace(ws, session, opts);
          if (opts.expectedDigest !== undefined && result.plan.planDigest !== opts.expectedDigest) return result;
          await opts.inspectPlan?.(result.plan, {});
          assertDeletionAllowed(result.plan, opts.deletionNodes ?? []);
          return result;
        },
        async applyVerifiedPlan(ws, args) {
          const plan = w.tofu.planFactory(ws, 0);
          if (plan.planDigest !== args.approvedDigest) throw new TofuPlanChangedError(args.approvedDigest, plan.planDigest);
          await args.inspectPlan?.(plan, {});
          assertDeletionAllowed(plan, args.deletionNodes ?? []);
          return w.tofu.applyVerifiedPlan(ws, args);
        },
      },
    });
    const lease = await w.lease();
    const planned = await w.activities.planInfrastructure({ operationId: OP, lease });
    const args = { operationId: OP, lease, planDigest: planned.planDigest };
    await w.activities.finalPlan({ ...args, approvedPlanDigest: args.planDigest });
    await expect(w.activities.applyInfrastructure(args)).rejects.toThrow(/human approval/);
    expect(w.tofu.applyCalls).toHaveLength(0);
    w.broker.approval = { approved: true, rejected: false, approvalId: "human-browser-contract" };
    cloud.state.recordStatus = 403;
    await expect(w.activities.applyInfrastructure(args)).rejects.toThrow(/target ownership/);
    expect(w.tofu.applyCalls).toHaveLength(0);
    cloud.state.recordStatus = 200;
    await expect(w.activities.applyInfrastructure(args)).resolves.toMatchObject({ applied: 1 });
    expect(w.tofu.applyCalls).toHaveLength(1);
    expect(brokerRequests.map((r) => r.grant.cap)).toEqual(["infrastructure.plan", "infrastructure.plan", "deployment.deploy", "deployment.deploy", "deployment.deploy"]);
    expect(w.stored() + JSON.stringify(w.logs)).not.toContain("domain-proof-canary");
    expect(w.ops.uncertain).toHaveLength(0);
  });

  it.each(["delete", "replace"] as const)("allows owned %s after digest-bound human approval and rechecks at apply", async (action) => {
    const cloud = factories[provider](WS, ENV);
    const w = createWorld(); worlds.push(w);
    w.product.base.environment.provider = provider;
    const rt = createRuntime(w.deps); const ec = await loadExecContext(rt, OP); const lease = await w.lease();
    const address = `${provider}_dns_record.app`;
    const plan = makePlan({ changes: [change({ address, nodeAddress: cloud.node.address, type: { gcp: "google_dns_record_set", azure: "azurerm_dns_cname_record", oci: "oci_dns_rrset" }[provider], action })] });
    const guard = inspectDeployDeletions(rt, ec, cloud.nodes, cloud.nodes, cloud.ctx.session, cloud.ctx.signal, lease);
    // Planning and the final plan both read current ownership.
    await expect(guard(plan, {})).resolves.toBeUndefined();
    await expect(guard(plan, {})).resolves.toBeUndefined();
    const facts = { ...extractPlanFacts(plan), ...deployDeletionFacts(plan, cloud.nodes) };
    const evidence = planEvidence({ plan, facts, cost: {}, graphDigest: "a".repeat(64), stage: "plan" });
    await w.evidence.append({ workspaceId: WS, operationId: OP, kind: "tofu_plan", digest: plan.planDigest, summary: { ...evidence.summary, ...deployDeletionFacts(plan, cloud.nodes) }, simulated: false });
    await w.ops.setPlanDigest({ workspaceId: WS, operationId: OP, planDigest: plan.planDigest });
    await expect(assertDeployDeletionApproval(rt, ec, plan, cloud.nodes, plan.planDigest)).rejects.toThrow(/human approval/);
    w.broker.approval = { approved: true, rejected: false }; // auto-allow never suffices
    await expect(assertDeployDeletionApproval(rt, ec, plan, cloud.nodes, plan.planDigest)).rejects.toThrow(/human approval/);
    w.broker.approval = { approved: true, rejected: false, approvalId: "human-browser-contract" };
    await expect(assertDeployDeletionApproval(rt, ec, plan, cloud.nodes, plan.planDigest)).resolves.toBeUndefined();
    const canary = "foreign-target-canary";
    if ("record" in cloud.state) {
      if (provider === "gcp") cloud.state.record.rrdatas = [canary];
      else cloud.state.record.properties = { CNAMERecord: { cname: canary } };
    } else cloud.state.records = { items: [{ domain: "app.example.com", rtype: "A", rdata: canary }] };
    // The same immutable plan and human approval cannot override live repointing.
    const failure = await Promise.resolve().then(() => guard(plan, {})).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/target ownership/);
    expect((failure as Error).message + w.stored() + JSON.stringify(w.logs)).not.toContain(canary);
    expect(w.tofu.applyCalls).toHaveLength(0);
    await expect(assertDeployDeletionApproval(rt, ec, { ...plan, planDigest: "f".repeat(64) }, cloud.nodes, plan.planDigest)).rejects.toThrow(/reviewed plan digest/);
  });

  it("fails closed on unreadable records after approval, without leaking payloads", async () => {
    const cloud = factories[provider](WS, ENV);
    const w = createWorld(); worlds.push(w); w.product.base.environment.provider = provider;
    w.broker.approval = { approved: true, rejected: false, approvalId: "human-browser-contract" };
    const rt = createRuntime(w.deps); const ec = await loadExecContext(rt, OP); const lease = await w.lease();
    const plan = makePlan({ changes: [change({ address: "record.app", nodeAddress: cloud.node.address, type: "terraform_data", action: "delete" })] });
    const canary = "secret-response-canary";
    if ("fetch" in cloud) cloud.fetch.mockRejectedValue(new Error(canary));
    else cloud.dispatch.mockRejectedValue(new Error(canary));
    const failure = await Promise.resolve().then(() => inspectDeployDeletions(rt, ec, cloud.nodes, cloud.nodes, cloud.ctx.session, cloud.ctx.signal, lease)(plan, {})).catch((e: unknown) => e);
    expect((failure as Error).message).toMatch(/target ownership/);
    expect((failure as Error).message + w.stored() + JSON.stringify(w.logs)).not.toContain(canary);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });

  it("refuses unmapped native types and deny policies before any live read", async () => {
    const cloud = factories[provider](WS, ENV);
    const w = createWorld(); worlds.push(w); w.product.base.environment.provider = provider;
    const rt = createRuntime(w.deps); const ec = await loadExecContext(rt, OP); const lease = await w.lease();
    const plan = makePlan({ changes: [change({ address: "record.app", nodeAddress: cloud.node.address, type: "terraform_data", action: "delete" })] });
    const guard = inspectDeployDeletions(rt, ec, cloud.nodes, cloud.nodes, cloud.ctx.session, cloud.ctx.signal, lease);
    const native = cloud.node.nativeType; cloud.node.nativeType = "unsupported:dns_record";
    await expect(guard(plan, {})).rejects.toThrow(/provider target ownership guard/);
    cloud.node.nativeType = native; cloud.node.spec.deletionPolicy = "deny";
    await expect(guard(plan, {})).rejects.toThrow(/deletionPolicy/);
    if ("fetch" in cloud) expect(cloud.fetch).not.toHaveBeenCalled();
    else expect(cloud.dispatch).not.toHaveBeenCalled();
  });

  it("ignores creates and updates and refuses a missing historical mapping", async () => {
    const cloud = factories[provider](WS, ENV);
    const w = createWorld(); worlds.push(w); w.product.base.environment.provider = provider;
    const rt = createRuntime(w.deps); const ec = await loadExecContext(rt, OP); const lease = await w.lease();
    const guard = inspectDeployDeletions(rt, ec, cloud.nodes, cloud.nodes, cloud.ctx.session, cloud.ctx.signal, lease);
    for (const action of ["create", "update"] as const) {
      const plan = makePlan({ changes: [change({ address: "record.app", nodeAddress: cloud.node.address, type: "terraform_data", action })] });
      await expect(guard(plan, {})).resolves.toBeUndefined();
    }
    const plan = makePlan({ changes: [change({ address: "google_dns_record_set.unmapped", type: "google_dns_record_set", action: "delete" })] });
    await expect(guard(plan, {})).rejects.toThrow(/trusted managed resource/);
    if ("fetch" in cloud) expect(cloud.fetch).not.toHaveBeenCalled();
    else expect(cloud.dispatch).not.toHaveBeenCalled();
  });
});
