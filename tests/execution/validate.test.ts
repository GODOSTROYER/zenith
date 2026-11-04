/**
 * validateDesiredState: manifest → graph → problems, and what it persists.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import { expandManifest } from "@/lib/resources/expand";
import { upgradeManifest } from "@/lib/resources/upgrade";
import { environmentIdProblem } from "@/lib/execution/session";
import { StepFailedError } from "@/lib/execution/errors";
import { FAILURE_TYPES } from "@/lib/workflows/types";
import { bucketManifest, builtManifest, ENV, OP, OTHER_WS, webDbManifest } from "./fakes/fixtures";
import { createWorld, type World } from "./fakes/world";

const worlds: World[] = [];
const world = (...args: Parameters<typeof createWorld>): World => {
  const w = createWorld(...args);
  worlds.push(w);
  return w;
};
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});

describe("validateDesiredState", () => {
  it("returns the graph digest and node count, and persists every desired node once", async () => {
    const w = world();
    const result = await w.activities.validateDesiredState({ operationId: OP });
    expect(result.problems).toEqual([]);

    const expected = expandManifest(upgradeManifest(webDbManifest(), { provider: "aws", region: "us-east-1", policies: { approvalRequired: false, allowStatefulDeletion: false } }), {
      id: ENV,
      name: "production",
      class: "production",
      provider: "aws",
      region: "us-east-1",
      baseDomain: "atlas.zenith.test",
    });
    expect(result.graphDigest).toBe(expected.graphDigest);
    expect(result.nodes).toBe(expected.nodes.length);
    expect(w.resources.rows.size).toBe(expected.nodes.length);
    expect([...w.resources.rows.values()].every((r) => r.workspaceId === "ws-act-1" && r.environmentId === ENV && r.revisionId === "rev-act-1")).toBe(true);

    // idempotent: a retried activity changes nothing
    const again = await w.activities.validateDesiredState({ operationId: OP });
    expect(again).toEqual(result);
    expect(w.resources.rows.size).toBe(expected.nodes.length);
  });

  it("upgrades a V1 manifest in memory only: the stored revision stays V1", async () => {
    const w = world();
    const before = structuredClone(w.product.revisions.get("rev-act-1")!.manifest);
    await w.activities.validateDesiredState({ operationId: OP });
    expect(w.product.revisions.get("rev-act-1")!.manifest).toEqual(before);
    expect((before as { version: number }).version).toBe(1);
  });

  it("reports a manifest that does not parse as problems, with no graph and nothing persisted", async () => {
    const w = world();
    w.product.setManifest({ version: 2, services: [{ id: "s", name: "Bad Name", kind: "web", source: { type: "image", image: "x" } }] });
    const result = await w.activities.validateDesiredState({ operationId: OP });
    expect(result.graphDigest).toBe("");
    expect(result.nodes).toBe(0);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.join(" ")).toMatch(/manifest/);
    expect(w.resources.rows.size).toBe(0);
  });

  it("flags a managed node whose provider has no registered driver, and persists nothing", async () => {
    const w = world({ missingDrivers: ["aws:s3_bucket"] });
    w.product.setManifest(bucketManifest());
    const result = await w.activities.validateDesiredState({ operationId: OP });
    expect(result.problems).toEqual([expect.stringContaining("no driver is registered for aws aws:s3_bucket")]);
    expect(w.resources.rows.size).toBe(0);
  });

  it("flags a managed node whose driver cannot compile (observe-only)", async () => {
    const w = world({ overrides: { "aws:s3_bucket": { omit: ["compile"] } } });
    w.product.setManifest(bucketManifest());
    const result = await w.activities.validateDesiredState({ operationId: OP });
    expect(result.problems.join("\n")).toMatch(/cannot compile/);
  });

  it("flags nodes with no native realization on the environment's provider (unsupported native types)", async () => {
    const w = world();
    w.product.base.environment.provider = "localstack";
    w.product.setManifest(builtManifest());
    const result = await w.activities.validateDesiredState({ operationId: OP });
    expect(result.problems.join("\n")).toMatch(/no native realization on localstack/);
    expect(w.resources.rows.size).toBe(0);
  });

  it("flags a referenced data node that has no externalRef, but accepts one that has", async () => {
    const referenced = (externalRef?: string) => ({
      version: 1 as const,
      services: [],
      resources: [{ id: "res-db", name: "legacy-db", kind: "postgres", config: {}, size: "small", ownership: "referenced", ...(externalRef ? { externalRef } : {}) }],
      routes: [],
      bindings: [],
    });
    const w = world();
    w.product.setManifest(referenced());
    const missing = await w.activities.validateDesiredState({ operationId: OP });
    expect(missing.problems).toEqual([expect.stringContaining("referenced but has no externalRef")]);

    w.product.setManifest(referenced("arn:aws:rds:us-east-1:123456789012:db:legacy"));
    const ok = await w.activities.validateDesiredState({ operationId: OP });
    expect(ok.problems).toEqual([]);
    expect(w.resources.byAddress("postgres/legacy-db")).toMatchObject({ ownership: "referenced", externalId: "arn:aws:rds:us-east-1:123456789012:db:legacy" });
  });

  it("flags a node placed on a provider other than the environment's", async () => {
    const w = world();
    w.product.setManifest({
      ...upgradeManifest(webDbManifest(), { provider: "aws", region: "us-east-1" }),
      nodePlacement: { db: { provider: "gcp", region: "us-central1" } },
    });
    const result = await w.activities.validateDesiredState({ operationId: OP });
    expect(result.problems.join("\n")).toMatch(/placed on gcp\/us-central1 but this environment executes on aws/);
  });

  it("flags a blueprint source on a real provider", async () => {
    const w = world();
    const m = webDbManifest();
    (m.services[0] as { source: unknown }).source = { type: "blueprint", blueprint: "hello-web" };
    w.product.setManifest(m);
    const result = await w.activities.validateDesiredState({ operationId: OP });
    expect(result.problems.join("\n")).toMatch(/blueprint source "hello-web", which only the sandbox provider can run/);
  });

  it("turns an ownership conflict in the store into a problem instead of a crash", async () => {
    const w = world();
    w.product.setManifest(bucketManifest());
    await w.resources.upsertDesired({
      workspaceId: "ws-act-1",
      environmentId: ENV,
      node: { address: "object_store/assets", kind: "object_store", provider: "aws", region: "us-east-1", nativeType: "aws:s3_bucket", ownership: "referenced", spec: {}, origin: [], dependsOn: [], specDigest: "0".repeat(64), labels: {} },
    });
    const result = await w.activities.validateDesiredState({ operationId: OP });
    expect(result.problems.join("\n")).toMatch(/object_store\/assets: .*ownership never changes/);
  });

  it("refuses an operation it cannot find, and one whose environment is in another workspace, with a definitive failure", async () => {
    const w = world();
    await expect(w.activities.validateDesiredState({ operationId: "op-missing" })).rejects.toBeInstanceOf(StepFailedError);

    w.ops.seed({ id: "op-foreign", workspaceId: OTHER_WS });
    const err = await w.activities.validateDesiredState({ operationId: "op-foreign" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).type).toBe(FAILURE_TYPES.stepFailed);
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
  });

  it("caps the problem list and keeps each problem a short single line", async () => {
    const w = world({ missingDrivers: ["aws:vpc", "aws:subnet", "aws:security_group_rule", "aws:alb", "aws:ecs_service", "aws:rds_instance"] });
    const result = await w.activities.validateDesiredState({ operationId: OP });
    expect(result.problems.length).toBeGreaterThan(3);
    expect(result.problems.length).toBeLessThanOrEqual(50);
    for (const p of result.problems) expect(p).not.toMatch(/[\n\r]/);
  });
});

describe("environment ids as cloud names", () => {
  it("accepts lowercase ids and refuses ones that cannot be part of an S3, ALB or IAM name", () => {
    expect(environmentIdProblem("m1abc123xyz456")).toBeUndefined();
    expect(environmentIdProblem("env-prod-1")).toBeUndefined();
    expect(environmentIdProblem("Env_Prod")).toMatch(/cannot be used in cloud resource names/);
    expect(environmentIdProblem("a".repeat(60))).toMatch(/cannot be used/);
    expect(environmentIdProblem("-leading")).toMatch(/cannot be used/);
  });
});
