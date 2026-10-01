/** Built workload compile/release contracts over synthetic GCP responses only. */
import { describe, expect, it } from "vitest";
import type { ResourceNode } from "@/lib/resources/types";
import { findDriver } from "@/lib/drivers/types";
import { compileGraph } from "@/lib/execution/compile";
import { registerGcpDrivers } from "@/lib/providers/gcp/drivers";
import { createGcpBuildPort, createGcpWorkloadsPort } from "@/lib/platform/release-gcp";
import { BOOTSTRAP_JOB_IMAGE, BOOTSTRAP_SERVICE_IMAGE, IMAGE_DIGEST_ANNOTATION } from "@/lib/providers/gcp/drivers/compute/run-image";
import { driverFor, environmentNodes, graphOf, TAGS, REGION as COMPILE_REGION } from "./_fixtures";
import { bundle, bucket, DIGEST, IMAGE, pipeline, registry, service, tagged, world, PROJECT, REGION } from "./release-fixtures";

type Json = Record<string, unknown>;
const artifact = { type: "built", pipeline: "resource/pipeline", registry: "resource/registry" };
const builtNodes = () => environmentNodes().map((node) => ["container_service", "scheduled_job"].includes(node.kind) ? { ...node, spec: { ...node.spec, artifact } } : node);
const compiled = (nodes = builtNodes()) => {
  registerGcpDrivers();
  return compileGraph({ graph: graphOf(nodes), environmentId: "env_1", region: COMPILE_REGION, tags: TAGS, drivers: findDriver }).fragments;
};
const body = (nodes: ResourceNode[], address: string, type: string): Json => Object.values(compiled(nodes).get(address)!.resource![type])[0];
const input = () => ({ service, registry, pipeline, source: { ...bundle, bucket, objectKey: bundle.s3Key, uri: `gs://${bucket}/${bundle.s3Key}` }, idempotencyKey: "op-1:build:web" });

describe("built Cloud Run compilation", () => {
  it("compiles services and jobs before a build result exists, retaining all other desired configuration", () => {
    const nodes = builtNodes();
    const svc = body(nodes, "service/web", "google_cloud_run_v2_service");
    const job = body(nodes, "job/nightly", "google_cloud_run_v2_job");
    const template = (svc.template as Json[])[0];
    expect((template.containers as Json[])[0]).toMatchObject({ image: BOOTSTRAP_SERVICE_IMAGE, env: expect.any(Array), resources: expect.any(Array), ports: expect.any(Array) });
    expect(template).toMatchObject({ service_account: expect.any(String), vpc_access: expect.any(Array), scaling: expect.any(Array) });
    expect((((job.template as Json[])[0].template as Json[])[0].containers as Json[])[0].image).toBe(BOOTSTRAP_JOB_IMAGE);
    expect((svc.lifecycle as Json).ignore_changes).toContain("template[0].containers[0].image");
    expect((svc.lifecycle as Json).ignore_changes).toContain(`template[0].annotations["${IMAGE_DIGEST_ANNOTATION}"]`);
    expect((job.lifecycle as Json).ignore_changes).toEqual(["template[0].template[0].containers[0].image", `template[0].annotations["${IMAGE_DIGEST_ANNOTATION}"]`]);
    for (const image of [BOOTSTRAP_SERVICE_IMAGE, BOOTSTRAP_JOB_IMAGE]) expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify([...compiled(nodes)])).not.toContain(":latest");
  });

  it("retains image delegation when CPU and environment change, and compiles deterministically", () => {
    const nodes = builtNodes().map((node) => node.address === "service/web" ? { ...node, spec: { ...node.spec, vcpu: 2, env: [{ key: "MODE", value: "changed" }] } } : node);
    const svc = body(nodes, "service/web", "google_cloud_run_v2_service");
    expect((svc.lifecycle as Json).ignore_changes).toContain("template[0].containers[0].image");
    const container = ((svc.template as Json[])[0].containers as Json[])[0];
    expect(container).toMatchObject({ resources: [{ limits: { cpu: "2" } }], env: [{ name: "MODE", value: "changed" }] });
    expect(compiled([...nodes].reverse())).toEqual(compiled(nodes));
  });

  it("keeps image artifacts declarative and referenced workloads read-only", () => {
    const nodes = environmentNodes();
    const svc = body(nodes, "service/web", "google_cloud_run_v2_service");
    expect((svc.lifecycle as Json).ignore_changes).not.toContain("template[0].containers[0].image");
    expect(body(nodes, "job/nightly", "google_cloud_run_v2_job").lifecycle).toBeUndefined();
    const refs = builtNodes().map((node) => node.address === "service/web" ? { ...node, ownership: "referenced" as const, externalRef: `projects/${PROJECT}/locations/${REGION}/services/external` } : node);
    const f = compiled(refs).get("service/web")!;
    expect(f.resource).toBeUndefined();
    expect(f.data).toHaveProperty("google_cloud_run_v2_service");
  });

  it.each([
    ["missing pipeline", (nodes: ResourceNode[]) => nodes.filter((n) => n.address !== "resource/pipeline")],
    ["missing registry", (nodes: ResourceNode[]) => nodes.filter((n) => n.address !== "resource/registry")],
    ["foreign registry", (nodes: ResourceNode[]) => nodes.map((n) => n.address === "resource/registry" ? { ...n, provider: "aws" as const } : n)],
    ["foreign region", (nodes: ResourceNode[]) => nodes.map((n) => n.address === "resource/registry" ? { ...n, region: "us-central1" } : n)],
    ["unmanaged registry", (nodes: ResourceNode[]) => nodes.map((n) => n.address === "resource/registry" ? { ...n, ownership: "referenced" as const } : n)],
    ["unmanaged pipeline", (nodes: ResourceNode[]) => nodes.map((n) => n.address === "resource/pipeline" ? { ...n, ownership: "external" as const } : n)],
    ["non-customer pipeline", (nodes: ResourceNode[]) => nodes.map((n) => n.address === "resource/pipeline" ? { ...n, spec: { ...n.spec, location: "platform" } } : n)],
    ["mismatched output", (nodes: ResourceNode[]) => nodes.map((n) => n.address === "resource/pipeline" ? { ...n, spec: { ...n.spec, output: { registry: "other" } } } : n)],
  ])("refuses %s before generating the workload fragment", (_, change) => {
    const nodes = change(builtNodes());
    expect(() => driverFor(nodes.find((n) => n.address === "service/web")!).compile!(nodes.find((n) => n.address === "service/web")!, { environmentId: "env_1", namePrefix: "zn-env1", region: COMPILE_REGION, tags: TAGS, node: (a) => nodes.find((n) => n.address === a), ref: () => "unused" })).toThrow(/pipeline and registry/);
  });
});

describe("C3 GCS bundle to recorded workload digest", () => {
  it("builds from the GCS aliases and replaces bootstrap with the verified digest and a revision record", async () => {
    const w = world();
    const template = w.state.service.template as Json;
    (template.containers as Json[])[0].image = BOOTSTRAP_SERVICE_IMAGE;
    template.annotations = { "example.com/operator": "preserved" };
    expect(await createGcpWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 1000 })).toMatchObject({ steady: false, detail: expect.stringContaining("released image digest") });
    const build = createGcpBuildPort();
    const handle = await build.startBuild(w.ctx, input());
    const result = await build.waitForBuild(w.ctx, handle, { timeoutMs: 1000 });
    expect(result).toEqual({ status: "succeeded", digest: DIGEST, imageUri: IMAGE });
    await createGcpWorkloadsPort().deployImage(w.ctx, service, { uri: result.imageUri!, digest: result.digest! }, { idempotencyKey: "op:deploy:web" });
    expect(w.state.service.template).toMatchObject({ annotations: { "example.com/operator": "preserved", [IMAGE_DIGEST_ANNOTATION]: DIGEST }, containers: [{ image: IMAGE }] });
    expect(await createGcpWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 1000 })).toMatchObject({ steady: true });
    expect(w.ctx.log).not.toHaveBeenCalled();
  });

  it.each(["objectKey", "uri"])("rejects a contradictory C3 %s without launching a build", async (field) => {
    const w = world(); const original = input();
    await expect(createGcpBuildPort().startBuild(w.ctx, { ...original, source: { ...original.source, [field]: "foreign" } })).rejects.toThrow("GCS identifiers");
    expect(w.state.build).toBeUndefined();
  });

  it.each(["null", "[]", "\"opaque-secret-sentinel\"", "{bad"])("rejects malformed build handle %s safely", async (buildId) => {
    const w = world();
    await expect(createGcpBuildPort().waitForBuild(w.ctx, { buildId }, { timeoutMs: 1000 })).rejects.toThrow("Invalid GCP build handle");
    expect(w.fetcher).not.toHaveBeenCalled();
  });

  it("repairs a missing digest record even when the container already targets that digest", async () => {
    const w = world(); (w.state.service.template as Json).annotations = {};
    await createGcpWorkloadsPort().deployImage(w.ctx, service, { uri: IMAGE, digest: DIGEST }, { idempotencyKey: "op:deploy:web" });
    expect((w.state.service.template as Json).annotations).toEqual({ [IMAGE_DIGEST_ANNOTATION]: DIGEST });
    expect(w.fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("refuses a foreign project's built image and mismatched recorded digest", async () => {
    const w = world(); const port = createGcpWorkloadsPort();
    await expect(port.deployImage(w.ctx, service, { uri: IMAGE.replace(PROJECT, "foreign-project"), digest: DIGEST }, { idempotencyKey: "op:deploy:web" })).rejects.toThrow("Artifact Registry");
    expect(w.fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    (w.state.service.template as Json).annotations = { [IMAGE_DIGEST_ANNOTATION]: `sha256:${"b".repeat(64)}` };
    expect(await port.waitSteady(w.ctx, service, { timeoutMs: 1000 })).toMatchObject({ steady: false });
  });

  it("records a job digest on its execution template, preserves annotations and never starts an execution", async () => {
    const w = world(); const name = `projects/${PROJECT}/locations/${REGION}/jobs/worker`;
    const job = { ...service, kind: "scheduled_job" as const, address: "scheduled_job/worker", externalRef: name };
    w.state.jobs.set(name, { name, labels: tagged(job), generation: "1", observedGeneration: "1", reconciling: false, terminalCondition: { state: "CONDITION_SUCCEEDED" }, template: { annotations: { "example.com/operator": "preserved" }, taskCount: 1, parallelism: 1, template: { maxRetries: 1, timeout: "600s", containers: [{ image: BOOTSTRAP_JOB_IMAGE }] } } });
    await createGcpWorkloadsPort().deployImage(w.ctx, job, { uri: IMAGE, digest: DIGEST }, { idempotencyKey: "op:deploy:worker" });
    expect(w.state.jobs.get(name)).toMatchObject({ template: { annotations: { "example.com/operator": "preserved", [IMAGE_DIGEST_ANNOTATION]: DIGEST }, template: { containers: [{ image: IMAGE }], maxRetries: 1 } } });
    expect(w.state.starts).toBe(0);
    await createGcpWorkloadsPort().deployImage(w.ctx, job, { uri: IMAGE, digest: DIGEST }, { idempotencyKey: "op:deploy:worker" });
    expect(w.fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });
});
