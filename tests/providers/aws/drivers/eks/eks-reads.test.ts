/** Mocked EKS SDK contracts only. No AWS credentials, calls or live evidence. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DescribeClusterCommand, DescribeNodegroupCommand, EKSClient,
  ListNodegroupsCommand, ListTagsForResourceCommand, type Cluster, type Nodegroup,
} from "@aws-sdk/client-eks";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { EKS_ATTRIBUTES, eksClusterDriver as driver } from "@/lib/providers/aws/drivers/eks/eks-cluster";
import type { Observation } from "@/lib/resources/types";
import { ACCOUNT, REGION, awsError, driverCtx, mkNode, tagList, tagRecord } from "../data/_helpers";

const sdk = mockClient(EKSClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
const NAME = "zenith-env_test-apps";
const ARN = `arn:aws:eks:${REGION}:${ACCOUNT}:cluster/${NAME}`;
const KEY = `arn:aws:kms:${REGION}:${ACCOUNT}:key/12345678-1234-1234-1234-123456789012`;
const ADDRESS = "kubernetes_cluster/apps";
const node = (spec: Record<string, unknown> = {}) => mkNode(ADDRESS, "kubernetes_cluster", { version: "1.35", ...spec });
const cluster = (over: Partial<Cluster> = {}): Cluster => ({
  name: NAME, arn: ARN, version: "1.35", status: "ACTIVE", tags: tagRecord(ADDRESS),
  endpoint: `https://abc.gr7.${REGION}.eks.amazonaws.com`,
  identity: { oidc: { issuer: `https://oidc.eks.${REGION}.amazonaws.com/id/ABC123` } },
  resourcesVpcConfig: { endpointPrivateAccess: true, endpointPublicAccess: false, publicAccessCidrs: ["0.0.0.0/0"] },
  logging: { clusterLogging: [{ enabled: true, types: ["scheduler", "api", "audit", "controllerManager", "authenticator"] }] },
  encryptionConfig: [{ resources: ["secrets"], provider: { keyArn: KEY } }],
  accessConfig: { authenticationMode: "API", bootstrapClusterCreatorAdminPermissions: false },
  ...over,
});
const group = (name = "apps-nodes", over: Partial<Nodegroup> = {}): Nodegroup => ({
  clusterName: NAME, nodegroupName: name, nodegroupArn: `arn:aws:eks:${REGION}:${ACCOUNT}:nodegroup/${NAME}/${name}/abc-123`,
  status: "ACTIVE", health: { issues: [] }, version: "1.35", tags: tagRecord(ADDRESS),
  scalingConfig: { minSize: 1, desiredSize: 2, maxSize: 3 }, instanceTypes: ["t3.medium"],
  ...over,
});
const observe = (spec: Record<string, unknown> = {}) => driver.observe!(driverCtx(), node(spec), ARN);
const runtime = () => driver.runtime!(driverCtx(), node(), ARN);
const value = (o: Observation, name: string) => {
  const a = o.attributes[name];
  expect(a.state).toBe("known");
  return a.state === "known" ? a.value : undefined;
};

beforeEach(() => {
  sdk.reset(); tagging.reset();
  sdk.on(DescribeClusterCommand).resolves({ cluster: cluster() });
  sdk.on(ListNodegroupsCommand).resolves({ nodegroups: ["apps-nodes"] });
  sdk.on(DescribeNodegroupCommand).resolves({ nodegroup: group() });
  sdk.on(ListTagsForResourceCommand).resolves({ tags: tagRecord(ADDRESS) });
  tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ARN, Tags: tagList(ADDRESS) }] });
});
afterAll(() => { sdk.restore(); tagging.restore(); });

describe("EKS observation", () => {
  it("reads every desired attribute in matching units using broker SDK clients", async () => {
    const n = node({ kmsKeyArn: KEY });
    const ctx = driverCtx();
    const o = await driver.observe!(ctx, n, ARN);
    expect(o).toMatchObject({ presence: "present", externalId: ARN, source: driver.id, simulated: false });
    expect(Object.keys(o.attributes).sort()).toEqual([...EKS_ATTRIBUTES].sort());
    for (const [name, want] of Object.entries(driver.expectedAttributes!(n))) expect(value(o, name)).toEqual(want);
    expect(o.native?.tags).toEqual(tagRecord(ADDRESS));
    expect(value(o, "oidcIssuer")).toContain("/id/ABC123");
    expect(sdk.commandCalls(DescribeClusterCommand)[0].args[0].input).toEqual({ name: NAME });
    const args: readonly unknown[] = sdk.commandCalls(DescribeClusterCommand)[0].args;
    expect(args[1]).toEqual({ abortSignal: ctx.signal });
    expect(tagging.calls()).toHaveLength(0);
    expect(ctx.logs).toEqual([]);
  });
  it("normalizes public CIDRs and log type sets independently of ordering and duplicates", async () => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ resourcesVpcConfig: { endpointPrivateAccess: true, endpointPublicAccess: true, publicAccessCidrs: ["203.0.113.1/32", "192.0.2.0/24", "192.0.2.0/24"] } }) });
    const n = node({ endpointPublicAccess: true, publicAccessCidrs: ["192.0.2.0/24", "203.0.113.1/32"] });
    const o = await driver.observe!(driverCtx(), n, ARN);
    expect(value(o, "publicAccessCidrs")).toEqual(driver.expectedAttributes!(n).publicAccessCidrs);
  });
  it("resolves by tenant tags when no exact identifier is available", async () => {
    expect((await driver.observe!(driverCtx(), node())).presence).toBe("present");
    expect(tagging.commandCalls(GetResourcesCommand)[0].args[0].input).toMatchObject({ ResourceTypeFilters: ["eks:cluster"], TagFilters: [
      { Key: "zenith:environment", Values: ["env_test"] }, { Key: "zenith:resource", Values: [ADDRESS] }, { Key: "zenith:workspace", Values: ["ws_test"] },
    ] });
  });
  it("supports an exact referenced cluster name without claiming managed ownership", async () => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ tags: {} }) });
    const n = { ...node(), ownership: "referenced" as const, externalRef: NAME };
    expect((await driver.observe!(driverCtx(), n)).presence).toBe("present");
    expect(driver.expectedAttributes!(n)).toEqual({});
  });
  it("reads current cluster and group tags when describe responses omit them", async () => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ tags: undefined }) });
    sdk.on(DescribeNodegroupCommand).resolves({ nodegroup: group("apps-nodes", { tags: undefined }) });
    expect((await observe()).presence).toBe("present");
    expect(sdk.commandCalls(ListTagsForResourceCommand).map((c) => c.args[0].input.resourceArn)).toEqual([ARN, group().nodegroupArn]);
  });
  it.each(["invalid/name", `arn:aws:eks:us-east-1:${ACCOUNT}:cluster/${NAME}`, `arn:aws:eks:${REGION}:999999999999:cluster/${NAME}`, `${ARN}/extra`, `arn:aws-cn:eks:${REGION}:${ACCOUNT}:cluster/${NAME}`, "$(read-secret)"])("refuses an invalid or foreign identifier before SDK reads: %s", async (hint) => {
    const o = await driver.observe!(driverCtx(), node(), hint);
    expect(o.presence).toBe("unknown"); expect(sdk.calls()).toHaveLength(0);
  });
  it.each(["workspace", "environment", "resource"])("refuses a managed cluster with a foreign %s tag", async (tag) => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ tags: tagRecord(ADDRESS, { [`zenith:${tag}`]: "foreign" }) }) });
    const o = await observe();
    expect(o.presence).toBe("unknown"); expect(o.native).toBeUndefined();
    expect(sdk.commandCalls(ListNodegroupsCommand)).toHaveLength(0);
  });
  it.each([
    { name: "other" }, { arn: ARN.replace(ACCOUNT, "999999999999") }, { arn: ARN.replace(REGION, "us-east-1") }, { arn: undefined },
  ])("refuses mismatched or incomplete cluster identity", async (over) => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster(over) });
    expect((await observe()).presence).toBe("unknown");
  });
  it.each([
    { ResourceTagMappingList: [] },
    { ResourceTagMappingList: [{ ResourceARN: ARN, Tags: tagList(ADDRESS) }, { ResourceARN: `${ARN}-other`, Tags: tagList(ADDRESS) }] },
    { ResourceTagMappingList: [{ ResourceARN: ARN, Tags: tagList(ADDRESS) }], PaginationToken: "stuck" },
  ])("leaves absent, ambiguous or truncated tag-index results unknown", async (out) => {
    tagging.on(GetResourcesCommand).resolves(out);
    expect((await driver.observe!(driverCtx(), node())).presence).toBe("unknown");
    expect(sdk.calls()).toHaveLength(0);
  });
  it.each([
    ["ResourceNotFoundException", "missing", "not_applicable"], ["AccessDeniedException", "inaccessible", "access_denied"],
    ["ThrottlingException", "unknown", "error"], ["ServiceUnavailableException", "unknown", "error"],
  ])("classifies %s and never retains provider error text", async (name, presence, reason) => {
    sdk.on(DescribeClusterCommand).rejects(awsError(name, "secret=short-secret token=also-secret AKIAABCDEFGHIJKLMNOP"));
    const o = await observe();
    expect(o.presence).toBe(presence);
    for (const a of Object.values(o.attributes)) expect(a).toMatchObject({ state: "unknown", reason });
    expect(JSON.stringify(o)).not.toMatch(/short-secret|also-secret|AKIAABCDEFGHIJKLMNOP/);
  });
  it("treats an omitted cluster response as unknown rather than a provider-confirmed absence", async () => {
    sdk.on(DescribeClusterCommand).resolves({}); expect((await observe()).presence).toBe("unknown");
  });
  it("does not invent configuration values when provider fields are omitted", async () => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ resourcesVpcConfig: undefined, logging: undefined, encryptionConfig: undefined, accessConfig: undefined, identity: undefined, endpoint: undefined }) });
    const o = await observe();
    for (const name of ["endpointPrivateAccess", "logTypes", "encrypted", "oidcIssuer", "endpoint", "authenticationMode"]) expect(o.attributes[name].state).toBe("unknown");
  });
  it("distinguishes explicit disabled logs and absent encryption from unread fields", async () => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ logging: { clusterLogging: [{ enabled: false, types: ["api", "audit"] }] }, encryptionConfig: [] }) });
    const o = await observe(); expect(value(o, "logTypes")).toEqual([]); expect(value(o, "encrypted")).toBe(false); expect(value(o, "kmsKeyArn")).toBeNull();
  });
  it.each([{ encryptionConfig: [{}] }, { encryptionConfig: [{ resources: ["secrets"] }] }])("does not infer disabled encryption from an incomplete response", async ({ encryptionConfig }) => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ encryptionConfig }) });
    expect((await observe()).attributes.encrypted.state).toBe("unknown");
  });
  it("does not retain malformed encryption-key fields", async () => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ encryptionConfig: [{ resources: ["secrets"], provider: { keyArn: "secret=short-secret" } }] }) });
    expect(JSON.stringify(await observe())).not.toContain("short-secret");
  });
  it.each(["AccessDeniedException", "ResourceNotFoundException", "ThrottlingException"])("keeps cluster configuration after nodegroup %s", async (name) => {
    sdk.on(DescribeNodegroupCommand).rejects(awsError(name, "secret=short-secret"));
    const o = await observe(); expect(o.presence).toBe("present"); expect(value(o, "version")).toBe("1.35");
    expect(o.attributes.nodeDesired.state).toBe("unknown"); expect(JSON.stringify(o)).not.toContain("short-secret");
  });
  it("bounds/redacts metadata and drops unused provider fields", async () => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ tags: { ...tagRecord(ADDRESS), secret: "short-secret", description: "x".repeat(9000) }, clientRequestToken: "request-secret" }) });
    const o = await observe();
    expect(Buffer.byteLength(JSON.stringify(o.native))).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(o)).not.toMatch(/short-secret|request-secret/);
  });
  it.each(["https://user:password@host.example", "https://host.example?token=short-secret", "http://host.example"])("does not retain credential-bearing or insecure URLs", async (url) => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ endpoint: url, identity: { oidc: { issuer: url } } }) });
    const o = await observe(); expect(value(o, "endpoint")).toBeNull(); expect(value(o, "oidcIssuer")).toBeNull(); expect(JSON.stringify(o)).not.toContain("password");
  });
  it("returns no desired comparison for unusable specs", () => { expect(driver.expectedAttributes!(node({ version: "latest" }))).toEqual({}); });
});

describe("EKS runtime", () => {
  it("reports EKS group health and configured counts, never a Kubernetes running-node count", async () => {
    expect(await runtime()).toMatchObject({ health: "healthy", counts: { nodegroups: 1, desired: 2, min: 1, max: 3 }, signals: [], simulated: false });
    expect((await runtime()).counts).not.toHaveProperty("running");
  });
  it("paginates, deduplicates and aggregates all fully scoped groups", async () => {
    sdk.on(ListNodegroupsCommand).resolvesOnce({ nodegroups: ["b"], nextToken: "page2" }).resolves({ nodegroups: ["a", "b"] });
    sdk.on(DescribeNodegroupCommand, { nodegroupName: "a" }).resolves({ nodegroup: group("a") });
    sdk.on(DescribeNodegroupCommand, { nodegroupName: "b" }).resolves({ nodegroup: group("b") });
    const r = await runtime(); expect(r.health).toBe("healthy"); expect(r.counts.desired).toBe(4);
    expect(sdk.commandCalls(DescribeNodegroupCommand).map((c) => c.args[0].input.nodegroupName)).toEqual(["a", "b"]);
    expect(sdk.commandCalls(ListNodegroupsCommand)[1].args[0].input.nextToken).toBe("page2");
  });
  it.each(["CREATE_FAILED", "DELETE_FAILED", "DEGRADED"] as const)("reports %s as unhealthy", async (status) => {
    sdk.on(DescribeNodegroupCommand).resolves({ nodegroup: group("apps-nodes", { status }) }); expect((await runtime()).health).toBe("unhealthy");
  });
  it("reports nodegroup health issues without exposing messages or resource IDs", async () => {
    sdk.on(DescribeNodegroupCommand).resolves({ nodegroup: group("apps-nodes", { health: { issues: [{ code: "NodeCreationFailure", message: "secret=short-secret", resourceIds: ["foreign-resource"] }] } }) });
    const r = await runtime(); expect(r.health).toBe("unhealthy"); expect(JSON.stringify(r)).not.toMatch(/short-secret|foreign-resource/);
  });
  it.each(["CREATING", "UPDATING", "DELETING"] as const)("reports transitioning %s groups as degraded", async (status) => {
    sdk.on(DescribeNodegroupCommand).resolves({ nodegroup: group("apps-nodes", { status }) }); expect((await runtime()).health).toBe("degraded");
  });
  it.each([{ health: undefined }, { health: {} }, { status: undefined }])("keeps omitted group health/status unknown", async (over) => {
    sdk.on(DescribeNodegroupCommand).resolves({ nodegroup: group("apps-nodes", over) }); expect((await runtime()).health).toBe("unknown");
  });
  it("keeps omitted scaling counts unknown without discarding read health", async () => {
    sdk.on(DescribeNodegroupCommand).resolves({ nodegroup: group("apps-nodes", { scalingConfig: undefined }) });
    const r = await runtime(); expect(r.health).toBe("healthy"); expect(r.counts).toEqual({ nodegroups: 1 });
  });
  it("reports an explicitly empty inventory as unhealthy", async () => {
    sdk.on(ListNodegroupsCommand).resolves({ nodegroups: [] }); expect((await runtime()).health).toBe("unhealthy"); expect(value(await observe(), "nodeGroupCount")).toBe(0);
  });
  it.each([
    { tags: tagRecord(ADDRESS, { "zenith:workspace": "other" }) }, { clusterName: "other" },
    { nodegroupName: "other" }, { nodegroupArn: group().nodegroupArn!.replace(ACCOUNT, "999999999999") }, {},
  ])("never reports healthy for mismatched or missing group identity", async (over) => {
    sdk.on(DescribeNodegroupCommand).resolves(Object.keys(over).length ? { nodegroup: group("apps-nodes", over) } : {});
    const r = await runtime(); expect(r.health).toBe("unknown"); expect(r.counts).toEqual({});
  });
  it.each([{ nextToken: "stuck", nodegroups: ["apps-nodes"] }, {}, { nodegroups: ["$(read-secret)"] }])("keeps incomplete or invalid inventory unknown", async (out) => {
    sdk.on(ListNodegroupsCommand).resolves(out); expect((await runtime()).health).toBe("unknown"); expect(sdk.commandCalls(DescribeNodegroupCommand)).toHaveLength(0);
  });
  it("caps pagination at five pages and refuses an incomplete inventory", async () => {
    sdk.on(ListNodegroupsCommand).resolves({ nodegroups: [], nextToken: "page-0" });
    for (let i = 0; i < 4; i++) sdk.on(ListNodegroupsCommand, { nextToken: `page-${i}` }).resolves({ nodegroups: [], nextToken: `page-${i + 1}` });
    expect((await runtime()).health).toBe("unknown"); expect(sdk.commandCalls(ListNodegroupsCommand)).toHaveLength(5);
  });
  it.each(["AccessDeniedException", "ResourceNotFoundException", "ThrottlingException"])("keeps partial group reads unknown after %s", async (name) => {
    sdk.on(DescribeNodegroupCommand).rejects(awsError(name)); expect((await runtime()).health).toBe("unknown");
  });
  it.each([["ACTIVE", "healthy"], ["CREATING", "degraded"], ["UPDATING", "degraded"], ["DELETING", "degraded"], ["FAILED", "unhealthy"]] as const)("handles cluster %s as %s", async (status, health) => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ status }) }); expect((await runtime()).health).toBe(health);
  });
  it("keeps a known cluster failure unhealthy even if nodegroup reads fail", async () => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ status: "FAILED" }) }); sdk.on(ListNodegroupsCommand).rejects(awsError("AccessDeniedException")); expect((await runtime()).health).toBe("unhealthy");
  });
  it.each([["ResourceNotFoundException", "unhealthy"], ["AccessDeniedException", "unknown"], ["ThrottlingException", "unknown"]])("handles cluster read %s as %s", async (name, health) => {
    sdk.on(DescribeClusterCommand).rejects(awsError(name, "secret=short-secret")); const r = await runtime(); expect(r.health).toBe(health); expect(JSON.stringify(r)).not.toContain("short-secret");
  });
});

describe("EKS verification and cancellation", () => {
  it("passes complete compliant observations and EKS runtime evidence", async () => {
    const o = await observe({ kmsKeyArn: KEY }); const r = await runtime();
    const v = await driver.verify!(driverCtx(), node({ kmsKeyArn: KEY }), o, r);
    expect(v.status).toBe("passed"); expect(v.checks.every((check) => check.passed === true)).toBe(true);
  });
  it.each([`https://oidc.eks.${REGION}.amazonaws.com/id/ABC123`, `https://oidc-eks.${REGION}.api.aws/id/ABC123`])("accepts the regional legacy or dual-stack issuer %s", async (issuer) => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ identity: { oidc: { issuer } } }) });
    expect(value(await observe(), "oidcIssuer")).toBe(issuer);
    expect((await driver.verify!(driverCtx(), node(), await observe(), await runtime())).status).toBe("passed");
  });
  it.each([
    ["endpointPrivateAccess", false], ["endpointPublicAccess", true], ["logTypes", ["api"]], ["encrypted", false],
    ["kmsKeyArn", KEY.replace("12345678-", "aaaaaaaa-")], ["version", "1.34"], ["oidcIssuer", "http://issuer.example"],
    ["endpoint", "http://endpoint.example"], ["nodeDesired", 1], ["authenticationMode", "CONFIG_MAP"],
  ])("fails drifted %s", async (name, changed) => {
    const o = await observe({ kmsKeyArn: KEY }); o.attributes[name] = { state: "known", value: changed, observedAt: o.observedAt };
    expect((await driver.verify!(driverCtx(), node({ kmsKeyArn: KEY }), o, await runtime())).status).toBe("failed");
  });
  it("keeps a desired security field unknown when unread", async () => {
    const o = await observe(); o.attributes.encrypted = { state: "unknown", reason: "access_denied" };
    expect((await driver.verify!(driverCtx(), node(), o, await runtime())).status).toBe("unknown");
  });
  it.each(["https://issuer.example/id/ABC123", "https://oidc.eks.us-east-1.amazonaws.com/id/ABC123", `https://oidc.eks.${REGION}.amazonaws.com/id/ABC123?token=secret`])("rejects an issuer outside the cluster's regional EKS identity", async (issuer) => {
    sdk.on(DescribeClusterCommand).resolves({ cluster: cluster({ identity: { oidc: { issuer } } }) });
    expect((await driver.verify!(driverCtx(), node(), await observe(), await runtime())).status).toBe("failed");
  });
  it("never passes verification for an unusable managed desired spec", async () => {
    expect((await driver.verify!(driverCtx(), node({ version: "latest" }), await observe(), await runtime())).status).toBe("unknown");
  });
  it("keeps missing runtime evidence unknown and fails unhealthy runtime", async () => {
    const o = await observe(); expect((await driver.verify!(driverCtx(), node(), o)).status).toBe("unknown");
    const r = await runtime(); r.health = "unhealthy"; expect((await driver.verify!(driverCtx(), node(), o, r)).status).toBe("failed");
  });
  it.each(["observation", "runtime", "simulated"])("refuses foreign or simulated %s evidence", async (mode) => {
    const o = await observe(); const r = await runtime();
    if (mode === "observation") o.address = "kubernetes_cluster/other";
    if (mode === "runtime") r.address = "kubernetes_cluster/other";
    if (mode === "simulated") o.simulated = true;
    expect((await driver.verify!(driverCtx(), node(), o, r)).status).toBe("unknown");
  });
  it.each(["observe", "runtime"] as const)("honors already-aborted %s without SDK reads", async (method) => {
    const abort = new AbortController(); abort.abort();
    await expect(driver[method]!(driverCtx({ signal: abort.signal }), node(), ARN)).rejects.toMatchObject({ name: "AbortError" }); expect(sdk.calls()).toHaveLength(0);
  });
  it.each(["observe", "runtime"] as const)("propagates an in-flight %s abort", async (method) => {
    const abort = new AbortController();
    sdk.on(ListNodegroupsCommand).callsFake(() => { abort.abort(); return { nodegroups: ["apps-nodes"] }; });
    await expect(driver[method]!(driverCtx({ signal: abort.signal }), node(), ARN)).rejects.toMatchObject({ name: "AbortError" }); expect(sdk.commandCalls(DescribeNodegroupCommand)).toHaveLength(0);
  });
  it("declares no native mutations or discovery", () => { expect(driver.operations).toBeUndefined(); expect(driver.discover).toBeUndefined(); });
});
