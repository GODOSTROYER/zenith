/**
 * OPS-08 offline: the adversarial-probe port with a fake browser driver (two tenants), in-memory AWS answered only for planned
 * calls through the real Guard, and a fake recorded state. No cloud, stack or browser is used.
 */
import { describe, expect, it } from "vitest";
import { buildPlan } from "../../scripts/acceptance/live/plan";
import { grantsFor, Guard } from "../../scripts/acceptance/live/guard";
import type { Call, Json, Plan } from "../../scripts/acceptance/live/contracts";
import { refuse, trustDocument } from "../../scripts/acceptance/live/product/mix-03";
import { ops08Manifest, ops08Port } from "../../scripts/acceptance/live/product/ops-08";
import type { Deploy01Product, Deploy01Tenant } from "../../scripts/acceptance/live/product/deploy-01-driver";

const ACCOUNT = "123456789012", REGION = "ap-south-1", RUN = "zlive-202611050000-ab08";
const PRINCIPAL = `arn:aws:iam::${ACCOUNT}:role/ZenithLiveAcceptance`;
const OLD_EXT = "old-live-external-id", EXT_A = `zenith-${"a".repeat(32)}`, EXT_B = `zenith-${"b".repeat(32)}`;
const settings = { accountId: ACCOUNT, region: REGION, runId: RUN, durationMinutes: 50, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/ZenithLiveWorkloadBoundary`, scenario: "ops-08" as const };
const requirement = { id: "PROD-OPS-08", acceptance: [], fixtures: [], join: "" };
const COMMIT = "a".repeat(40);
const bucket = (n: number) => `arn:aws:s3:::ops08-0000ab08-${n}`;

type Weakness = "leakyRead" | "acceptedAction" | "deputyVerifies" | "forgedApproval" | "deputyRefusedAtCreate";

function harness(weak?: Weakness) {
  const trust = { observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) };
  const events: string[] = [];
  let aws: string[] = [], destroyed = false, tenants = 0;
  const A: Deploy01Tenant = { workspaceId: "wsA", projectId: "pA" }, B: Deploy01Tenant = { workspaceId: "wsB", projectId: "pB" };
  const product: Deploy01Product = {
    createTenant: async () => (tenants++ === 0 ? A : B),
    createAwsConnection: async (t) => {
      events.push(`connection:${t.workspaceId}`);
      if (t === B && weak === "deputyRefusedAtCreate") refuse("connection.createAws was refused by the product");
      return t === A ? { connectionId: "cA", externalId: EXT_A } : { connectionId: "cB", externalId: EXT_B };
    },
    // STS: a connection verifies only when the roles' trust names its own ExternalId.
    verifyAws: async (t, id) => ({ ok: weak === "deputyVerifies" || trust.deploy.includes(id === "cA" ? EXT_A : EXT_B) }),
    createEnvironment: async () => ({ environmentId: "envA" }),
    setManifest: async (_t, m) => { events.push(`manifest:${(m.resources as unknown[]).length}`); },
    deploy: async () => { aws = [bucket(1)]; events.push("deploy"); return { operationId: "op1", status: "succeeded" }; },
    proposeDeploy: async () => { events.push("propose"); return { operationId: "op2", deploymentId: "d2" }; },
    operationStatus: async () => ({ status: "awaiting_approval", round: weak === "forgedApproval" ? 2 : 1 }),
    tryApprove: async (t) => ({ ok: t === B && weak === "forgedApproval" }),
    probe: async (t, endpoint) => { events.push(`probe:${t.workspaceId}:${endpoint.split("/")[2]}`); return weak === "leakyRead" ? { status: 200, text: '{"workspaceId":"wsA"}' } : { status: 404, text: '{"error":"not_found"}' }; },
    tryAction: async (t, id) => { events.push(`action:${t.workspaceId}:${id}`); return { status: 200, ok: weak === "acceptedAction" && id === "deploy.apply", why: "refused" }; },
  };
  const plan: Plan = buildPlan(settings);
  const permission = {
    schema: 1 as const, decision: "DEC-CLOUD" as const, approvedBy: "owner-test", approvedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    accountId: ACCOUNT, region: REGION, runId: RUN, planSha256: plan.sha256, sourceCommit: COMMIT, maxUsd: plan.estimate.usd, maxMinutes: plan.settings.durationMinutes, grants: grantsFor(plan),
  };
  const guard = new Guard(plan, permission, plan.estimate.usd);
  const call = async (c: Call, input?: Record<string, Json>) => {
    guard.consume(c);
    const i = input ?? c.input;
    switch (c.id) {
      case "teardown01-iam-read-observe": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.observe) } };
      case "teardown01-iam-read-deploy": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.deploy) } };
      case "teardown01-iam-trust-observe": trust.observe = String(i.PolicyDocument); return {};
      case "teardown01-iam-trust-deploy": trust.deploy = String(i.PolicyDocument); return {};
      case "teardown01-sts-assume": return { Credentials: { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T" } };
      case "teardown01-tag-read": return { ResourceTagMappingList: (destroyed ? [] : aws).map(ResourceARN => ({ ResourceARN })) };
      default: throw new Error(`unexpected ${c.id}`);
    }
  };
  const state = { read: async () => ({ resources: [] }), destroy: async () => { destroyed = true; aws = []; return { destroyed: 1 }; } };
  const port = ops08Port({ ZENITH_LIVE_PRODUCT: "1" }, { product, sleep: async () => undefined, propagation: { attempts: 2, intervalMs: 0 }, state });
  return { events, trust, destroyed: () => destroyed, run: () => port.verify(requirement, { plan, commit: COMMIT, call }) };
}

describe("OPS-08 plan", () => {
  it("scopes ops-08 to PROD-OPS-08 with the bucket-only sandbox calls, on either lane", () => {
    const plan = buildPlan(settings);
    expect(plan.settings.scenario).toBe("ops-08");
    expect(plan.productCalls?.map(c => c.id)).toEqual(buildPlan({ ...settings, scenario: "ops-05" }).productCalls?.map(c => c.id));
    expect(buildPlan({ ...settings, lane: "live2" }).settings.lane).toBe("live2");
    expect((ops08Manifest(RUN, 2).resources as unknown[]).length).toBe(2);
  });
});

describe("OPS-08 port", () => {
  it("passes every probe against a sound product, then cleans up and restores the trust", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.reason).toContain("OPS-08 adversarial probes on AWS");
    expect(result.reason).toContain("real STS refused B's own ExternalId");
    expect(result.complete).toBe(true);
    expect(h.events).toEqual(["connection:wsA", "manifest:1", "deploy", "probe:wsB:platform", "probe:wsB:environments",
      "action:wsB:deploy.apply", "action:wsB:connection.verifyAws", "action:wsB:env.create", "connection:wsB", "manifest:2", "propose"]);
    expect(h.destroyed()).toBe(true);
    expect(h.trust.observe).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });

  it("accepts a deputy connection refused at creation", async () => {
    const result = await harness("deputyRefusedAtCreate").run();
    expect(result.complete).toBe(true);
    expect(result.reason).toContain("refused at creation");
  });

  it.each([
    ["leakyRead", "cross-tenant reads: B read A's operation (HTTP 200) and it carried A's data"],
    ["acceptedAction", "cross-tenant actions: B's deploy.apply on A's environment was accepted"],
    ["deputyVerifies", "confused deputy: B's connection naming A's roles verified: STS accepted B's ExternalId"],
    ["forgedApproval", "forged approval: B's approval of A's proposal was accepted"],
  ] as [Weakness, string][])("fails on %s and still cleans up", async (weak, reason) => {
    const h = harness(weak);
    const result = await h.run();
    expect(result.complete).toBe(false);
    expect(result.reason).toBe(`OPS-08 not proven at ${reason}`);
    expect(h.destroyed()).toBe(true);
    expect(h.trust.deploy).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });
});
