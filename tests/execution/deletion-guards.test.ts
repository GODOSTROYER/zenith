/** Fake tofu port + mocked AWS SDK contracts. No cloud resources are changed. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { mockClient } from "aws-sdk-client-mock";
import { ListHostedZonesByNameCommand, ListResourceRecordSetsCommand, Route53Client } from "@aws-sdk/client-route-53";
import { DescribeLoadBalancersCommand, DescribeTagsCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { createExecutionActivities } from "@/lib/execution/activities";
import { StepFailedError, TofuPlanChangedError } from "@/lib/execution/errors";
import { assertDeletionAllowed } from "@/lib/tofu/plan";
import { upgradeManifest } from "@/lib/resources/upgrade";
import { buildDesiredState } from "@/lib/execution/graph";
import type { EngineOptions } from "@/lib/tofu/engine";
import type { TofuWorkspace, PlanResourceChange } from "@/lib/tofu/types";
import type { Manifest } from "@/lib/domain/types";
import type { ResourceNode } from "@/lib/resources/types";
import { createWorld, type World } from "./fakes/world";
import { bucketManifest, CANARY_GRANT, CANARY_SECRET, CANARY_SESSION_KEY, change, ENV, makePlan, OP, PROJECT, REVISION, webDbManifest, WS } from "./fakes/fixtures";

const worlds: World[] = [];
const dns = mockClient(Route53Client);
const elb = mockClient(ElasticLoadBalancingV2Client);
const OLD = "rev-deployed";
const empty = (): Manifest => ({ version: 1, services: [], resources: [], routes: [], bindings: [] });
const policyManifest = (manifest: Manifest, deletion: "allow" | "approval" | "deny") => {
  const v2 = upgradeManifest(manifest, { provider: "aws", region: "us-east-1" });
  v2.policies = { ...v2.policies, backup: "daily", deletion };
  return v2;
};

afterEach(() => { worlds.splice(0).forEach((w) => w.dispose()); dns.reset(); elb.reset(); vi.restoreAllMocks(); });

/** The shared fake ignores inspectors; this adapter exercises the engine contract. */
function world() {
  const w = createWorld(); worlds.push(w);
  const requests: EngineOptions[] = [];
  w.activities = createExecutionActivities({ ...w.deps, tofu: {
    async planWorkspace(ws, session, opts = {}) {
      const result = await w.tofu.planWorkspace(ws, session, opts);
      await opts.inspectPlan?.(result.plan, {});
      assertDeletionAllowed(result.plan, opts.deletionNodes ?? []);
      return result;
    },
    async applyVerifiedPlan(ws, args) {
      requests.push(args);
      const plan = w.tofu.planFactory(ws, w.tofu.planCalls.length + 1);
      if (plan.planDigest !== args.approvedDigest) throw new TofuPlanChangedError(args.approvedDigest, plan.planDigest);
      await args.inspectPlan?.(plan, {});
      assertDeletionAllowed(plan, args.deletionNodes ?? []);
      return w.tofu.applyVerifiedPlan(ws, args);
    },
  } });
  return { w, requests };
}

function drop(w: World, before: unknown = policyManifest(bucketManifest(), "allow"), after: unknown = empty()) {
  w.product.setManifest(before, OLD);
  w.product.setManifest(after, REVISION);
  w.product.base.environment.deployedRevisionId = OLD;
}

/** Emulate normalization's authoritative addressMap join; never invent nodeAddress. */
function scripted(w: World, changes: PlanResourceChange[]) {
  w.tofu.planFactory = (ws: TofuWorkspace) => makePlan({ configDigest: ws.configDigest, lockDigest: ws.lockDigest,
    changes: changes.map((c) => ({ ...c, nodeAddress: Object.entries(ws.addressMap).find(([, addresses]) => addresses.includes(c.address))?.[0] })) });
}

const bucketDelete = (action: "delete" | "replace" = "delete") => change({ address: "terraform_data.object_store_assets", type: "terraform_data", action });
const dnsAddress = "terraform_data.dns_record_app_atlas_zenith_test";
const dnsDelete = (action: "delete" | "replace" = "delete") => change({ address: dnsAddress, type: "terraform_data", action });

async function plan(w: World) {
  const lease = await w.lease();
  const result = await w.activities.planInfrastructure({ operationId: OP, lease });
  return { lease, operationId: OP, planDigest: result.planDigest };
}

function ownedDns(target = "owned.example.com") {
  dns.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [{ Id: "Z123", Name: "atlas.zenith.test.", CallerReference: "contract" }] });
  dns.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [{ Name: "app.atlas.zenith.test.", Type: "A", AliasTarget: { DNSName: target, HostedZoneId: "ZELB", EvaluateTargetHealth: true } }] });
  const arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/owned/123";
  elb.on(DescribeLoadBalancersCommand).resolves({ LoadBalancers: [{ LoadBalancerArn: arn, Type: "application", DNSName: "owned.example.com" }] });
  elb.on(DescribeTagsCommand).resolves({ TagDescriptions: [{ ResourceArn: arn, Tags: Object.entries({ "zenith:workspace": WS, "zenith:environment": ENV, "zenith:managed": "true", "zenith:resource": "load_balancer/public" }).map(([Key, Value]) => ({ Key, Value })) }] });
}

describe("normal deploy deletion guards", () => {
  it.each(["approval", "deny"] as const)("refuses removed stateful resources with deployed policy %s, despite new allow", async (policy) => {
    const { w } = world(); drop(w, policyManifest(bucketManifest(), policy), policyManifest(empty(), "allow")); scripted(w, [bucketDelete()]);
    await expect(plan(w)).rejects.toThrow(/deletionPolicy/);
    expect(w.tofu.applyCalls).toHaveLength(0);
    expect(w.evidence.rows).toHaveLength(0);
  });

  it("recovers exact removed addresses without restoring their resource blocks, and emits policy facts", async () => {
    const { w } = world(); drop(w); scripted(w, [bucketDelete()]);
    const read = vi.spyOn(w.product, "loadRevision");
    const args = await plan(w);
    const request = w.tofu.planCalls[0];
    expect(read).toHaveBeenCalledWith({ workspaceId: WS, environmentId: ENV, revisionId: OLD });
    expect(request.opts).toMatchObject({ lock: false, deletionNodes: [expect.objectContaining({ address: "object_store/assets", spec: expect.objectContaining({ deletionPolicy: "allow" }) })] });
    expect(request.ws.addressMap["object_store/assets"]).toEqual([bucketDelete().address]);
    expect(request.ws.files.find((f) => f.path === "main.tf.json")!.content).not.toContain("object_store_assets");
    await w.activities.evaluatePolicy(args);
    expect(w.evidence.rows[0].summary).toMatchObject({ statefulDeletes: [bucketDelete().address], dnsDeletes: [] });
    expect(w.broker.reevaluations[0].plan).toMatchObject({ destroysData: true, destroyedStatefulAddresses: [bucketDelete().address] });
    expect(w.credentials.sessions[0]).toMatchObject({ purpose: "observe", capability: "infrastructure.plan", revoked: true });
  });

  it.each(["delete", "replace"] as const)("requires digest-bound human approval for stateful %s", async (action) => {
    const { w, requests } = world(); drop(w); scripted(w, [bucketDelete(action)]);
    const args = await plan(w);
    await expect(w.activities.applyInfrastructure(args)).rejects.toThrow(/human approval/);
    w.broker.approval = { approved: true, rejected: false }; // policy auto-allow is insufficient
    await expect(w.activities.applyInfrastructure(args)).rejects.toThrow(/human approval/);
    w.broker.approval = { approved: true, rejected: true, approvalId: "app-1" };
    await expect(w.activities.applyInfrastructure(args)).rejects.toThrow(/human approval/);
    expect(w.tofu.applyCalls).toHaveLength(0);
    w.broker.approval = { approved: true, rejected: false, approvalId: "app-1" };
    await expect(w.activities.applyInfrastructure(args)).resolves.toMatchObject({ applied: 1 });
    expect(requests.at(-1)).toMatchObject({ deletionNodes: [expect.objectContaining({ address: "object_store/assets" })], inspectPlan: expect.any(Function) });
    expect(w.ops.uncertain).toHaveLength(0);
    expect(existsSync(path.join(w.planDir, `${args.planDigest}.tfplan`))).toBe(false);
    for (const secret of [CANARY_SECRET, CANARY_SESSION_KEY, CANARY_GRANT]) expect(w.stored() + JSON.stringify(w.logs)).not.toContain(secret);
  });

  it("refuses an unreviewed or incomplete deletion list even when the broker reports approval", async () => {
    const { w } = world(); drop(w); scripted(w, [bucketDelete()]); const args = await plan(w);
    w.broker.approval = { approved: true, rejected: false, approvalId: "app-1" };
    w.evidence.rows[0].summary.statefulDeletes = [];
    await expect(w.activities.applyInfrastructure(args)).rejects.toThrow(/evidence covers/);
    w.evidence.rows[0].summary.statefulDeletes = [bucketDelete().address];
    w.ops.ops.get(OP)!.planDigest = "f".repeat(64);
    await expect(w.activities.applyInfrastructure(args)).rejects.toThrow(/reviewed plan digest/);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });

  it("preserves deployed retention for a replacement still present in the new manifest", async () => {
    const { w } = world(); drop(w, policyManifest(bucketManifest(), "deny"), policyManifest(bucketManifest(), "allow"));
    await w.activities.validateDesiredState({ operationId: OP }); // overwrites the desired-store row
    scripted(w, [bucketDelete("replace")]);
    await expect(plan(w)).rejects.toThrow(/deletionPolicy/);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });

  it.each(["simulated", "foreign"] as const)("refuses %s deletion evidence", async (fault) => {
    const { w } = world(); drop(w); scripted(w, [bucketDelete()]); const args = await plan(w);
    w.broker.approval = { approved: true, rejected: false, approvalId: "app-1" };
    const row = w.evidence.rows[0];
    vi.spyOn(w.evidence, "find").mockResolvedValue({ ...row, ...(fault === "simulated" ? { simulated: true } : { workspaceId: "foreign" }) });
    await expect(w.activities.applyInfrastructure(args)).rejects.toThrow(/evidence covers/);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });

  it("recovers auxiliary tofu addresses owned by a removed node", async () => {
    const { w } = world(); drop(w);
    w.drivers("aws", "aws:s3_bucket")!.compile = () => ({ resource: { terraform_data: { object_store_assets: { input: "bucket" }, assets_policy: { input: "policy" } } }, addresses: [bucketDelete().address, "terraform_data.assets_policy"] });
    scripted(w, [change({ address: "terraform_data.assets_policy", type: "terraform_data", action: "delete" })]);
    await plan(w);
    expect(w.tofu.planCalls[0].ws.addressMap["object_store/assets"]).toContain("terraform_data.assets_policy");
    expect(w.evidence.rows[0].summary.statefulDeletes).toEqual(["terraform_data.assets_policy"]);
  });

  it("refuses a tofu address shared by a removed and a new node", async () => {
    const { w } = world(); drop(w, policyManifest(bucketManifest(), "allow"), bucketManifest("next"));
    w.drivers("aws", "aws:s3_bucket")!.compile = () => ({ resource: { terraform_data: { shared: { input: "contract" } } }, addresses: ["terraform_data.shared"] });
    await expect(plan(w)).rejects.toThrow(/ambiguous ownership/);
    expect(w.tofu.planCalls).toHaveLength(0);
  });

  it("rechecks retention at apply if the trusted store changes after review", async () => {
    const { w } = world(); drop(w); scripted(w, [bucketDelete()]); const args = await plan(w);
    w.broker.approval = { approved: true, rejected: false, approvalId: "app-1" };
    w.product.setManifest(policyManifest(bucketManifest(), "deny"), OLD);
    await expect(w.activities.applyInfrastructure(args)).rejects.toThrow(/deletionPolicy/);
    expect(w.tofu.applyCalls).toHaveLength(0);
    expect(w.ops.uncertain).toHaveLength(0);
  });

  it("fails closed when the deployed revision is missing", async () => {
    const { w } = world(); drop(w); w.product.revisions.delete(OLD);
    await expect(plan(w)).rejects.toThrow(/deployed revision could not be loaded/);
    expect(w.tofu.planCalls).toHaveLength(0);
  });

  it("retains policies from scoped rows left by earlier failed deploys", async () => {
    const { w } = world(); drop(w, empty());
    const product = await w.product.loadContext({ workspaceId: WS, environmentId: ENV, revisionId: REVISION });
    const node = buildDesiredState({ ...product, revision: { id: "older", number: 1, manifest: policyManifest(bucketManifest(), "allow") } }).graph!.nodes[0];
    await w.resources.upsertDesired({ workspaceId: WS, environmentId: ENV, node, revisionId: "older" });
    scripted(w, [bucketDelete()]);
    const list = vi.spyOn(w.resources, "list"); await plan(w);
    expect(list).toHaveBeenCalledWith(WS, ENV);
    expect(w.tofu.planCalls[0].opts.deletionNodes).toContainEqual(expect.objectContaining({ address: node.address, spec: expect.objectContaining({ deletionPolicy: "allow" }) }));
  });

  it("refuses a foreign row returned by a faulty store port", async () => {
    const { w } = world(); drop(w);
    const product = await w.product.loadContext({ workspaceId: WS, environmentId: ENV, revisionId: OLD });
    const node = buildDesiredState(product).graph!.nodes[0];
    const row = await w.resources.upsertDesired({ workspaceId: WS, environmentId: ENV, node });
    vi.spyOn(w.resources, "list").mockResolvedValue([{ ...row, workspaceId: "foreign" }]);
    await expect(plan(w)).rejects.toThrow(/outside.*scope/);
    expect(w.tofu.planCalls).toHaveLength(0);
  });

  it("refuses unmapped native stateful deletions", async () => {
    const { w } = world(); drop(w, empty()); scripted(w, [change({ address: "aws_db_instance.foreign", type: "aws_db_instance", action: "delete", destroysData: true })]);
    await expect(plan(w)).rejects.toThrow(/deletionPolicy/);
  });

  it("does not require destructive approval for a stateless deletion", async () => {
    const { w } = world(); const manifest = webDbManifest(); manifest.resources = []; manifest.routes = []; manifest.bindings = [];
    drop(w, manifest); scripted(w, [change({ address: "terraform_data.container_service_web", type: "terraform_data", action: "delete" })]);
    await expect(w.activities.applyInfrastructure(await plan(w))).resolves.toMatchObject({ applied: 1 });
  });
});

describe("DNS deletion ownership", () => {
  it.each(["delete", "replace"] as const)("rechecks AWS target ownership for %s at final plan and exact apply", async (action) => {
    const { w } = world(); drop(w, webDbManifest()); scripted(w, [dnsDelete(action)]); ownedDns();
    const args = await plan(w);
    await w.activities.evaluatePolicy(args);
    expect(w.evidence.rows[0].summary).toMatchObject({ statefulDeletes: [], dnsDeletes: [dnsAddress] });
    expect(w.broker.reevaluations[0].plan).toMatchObject({ dnsChanges: [dnsAddress] });
    await w.activities.finalPlan({ ...args, approvedPlanDigest: args.planDigest });
    await expect(w.activities.applyInfrastructure(args)).rejects.toThrow(/human approval/);
    w.broker.approval = { approved: true, rejected: false, approvalId: "app-1" };
    ownedDns("foreign.example.com");
    const failure = await w.activities.applyInfrastructure(args).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StepFailedError);
    expect((failure as Error).message).toMatch(/target ownership/);
    expect((failure as Error).message).not.toContain("foreign.example.com");
    expect(w.tofu.applyCalls).toHaveLength(0);
    expect(w.ops.uncertain).toHaveLength(0);
    ownedDns();
    await expect(w.activities.applyInfrastructure(args)).resolves.toMatchObject({ applied: 1 });
    expect(dns.commandCalls(ListResourceRecordSetsCommand).length).toBeGreaterThanOrEqual(5);
  });

  it("refuses DNS removal with a deny policy", async () => {
    const { w } = world(); drop(w, policyManifest(webDbManifest(), "deny")); scripted(w, [dnsDelete()]); ownedDns();
    await expect(plan(w)).rejects.toThrow(/DNS.*deletionPolicy/);
    expect(dns.commandCalls(ListResourceRecordSetsCommand)).toHaveLength(0);
  });

  it("does not read ownership for DNS creates or updates", async () => {
    const { w } = world(); drop(w, webDbManifest(), webDbManifest());
    scripted(w, [dnsDelete()].map((c) => ({ ...c, action: "update" })));
    await expect(plan(w)).resolves.toMatchObject({ planDigest: expect.any(String) });
    expect(dns.calls()).toHaveLength(0);
  });

  it("fails closed on unreadable DNS without leaking SDK payloads", async () => {
    const { w } = world(); drop(w, webDbManifest()); scripted(w, [dnsDelete()]);
    dns.on(ListHostedZonesByNameCommand).rejects(Object.assign(new Error(CANARY_SECRET), { name: "AccessDenied" }));
    const failure = await plan(w).catch((e: unknown) => e);
    expect((failure as Error).message).toMatch(/DNS.*ownership/);
    expect((failure as Error).message + w.stored()).not.toContain(CANARY_SECRET);
  });

  it("refuses unmapped DNS types even when stateful flags are false", async () => {
    const { w } = world(); drop(w, empty()); scripted(w, [change({ address: "aws_route53_record.foreign", type: "aws_route53_record", action: "delete" })]);
    await expect(plan(w)).rejects.toThrow(/trusted managed resource/);
  });

  it.each(["gcp", "azure", "oci"] as const)("fails closed for %s until its DNS target guard exists", async (provider) => {
    const { w } = world(); drop(w, empty());
    w.product.base.environment.provider = provider;
    w.deps.tofuWorkspace = { providerSet: () => "builtin", backend: () => ({ backend: { kind: "local", path: path.join(w.planDir, "state") } }) };
    // Runtime uses the same deps object; override backend without credentials.
    w.activities = createExecutionActivities({ ...w.deps, tofu: {
      async planWorkspace(ws, session, opts = {}) { const result = await w.tofu.planWorkspace(ws, session, opts); await opts.inspectPlan?.(result.plan, {}); return result; },
      applyVerifiedPlan: w.tofu.applyVerifiedPlan.bind(w.tofu),
    } });
    const nativeType = { gcp: "gcp:dns_record_set", azure: "azure:dns_a_record", oci: "oci:dns_rrset" }[provider];
    const node: ResourceNode = { address: "dns_record/app.example.com", kind: "dns_record", provider, nativeType, region: "test", ownership: "managed", spec: { deletionPolicy: "allow" }, specDigest: "f".repeat(64), labels: {}, origin: [], dependsOn: [] };
    await w.resources.upsertDesired({ workspaceId: WS, projectId: PROJECT, environmentId: ENV, node });
    scripted(w, [change({ address: "terraform_data.dns_record_app_example_com", type: "terraform_data", action: "delete" })]);
    await expect(plan(w)).rejects.toThrow(/provider target ownership guard/);
    expect(dns.calls()).toHaveLength(0);
  });
});
