/** GCP release contract tests: synthetic REST and broker sessions, never a live account. */
import { describe, expect, it } from "vitest";
import { createGcpBuildPort, createGcpWorkloadsPort, createGcpMigrationsPort } from "@/lib/platform/release-gcp";
import { IMAGE_DIGEST_ANNOTATION } from "@/lib/providers/gcp/drivers/compute/run-image";
import { CLOUD_BUILD_DOCKER_IMAGE } from "@/lib/providers/gcp/drivers/build/build-api";
import { world, node, tagged, service, registry, pipeline, bundle, bucket, sa, DIGEST, IMAGE, PROJECT, REGION, WS, ENV, serviceName, revisionName } from "./release-fixtures";

const buildInput = () => ({ service, registry, pipeline, source: { ...bundle, bucket }, idempotencyKey: "op-1:build:web" });
const deploy = { idempotencyKey: "op-1:deploy" };
const migrate = { idempotencyKey: "op-1:migrate", timeoutMs: 1000 };
const command = ["node", "migrate.js", "$(external-data)"];

describe("GCP customer-account build", () => {
  it("uses a versioned customer-bucket source and dedicated identity, then verifies the digest in Artifact Registry", async () => {
    const w = world(); const h = await createGcpBuildPort().startBuild(w.ctx, buildInput());
    const started = w.fetcher.mock.calls.find(([u, i]) => u.includes("cloudbuild") && i?.method === "POST")!;
    const body = JSON.parse(String(started[1]?.body));
    expect(body).toMatchObject({ source: { storageSource: { bucket, object: bundle.s3Key, generation: "7" } }, serviceAccount: `projects/${PROJECT}/serviceAccounts/${sa}`, options: { logging: "CLOUD_LOGGING_ONLY" }, steps: [{ name: CLOUD_BUILD_DOCKER_IMAGE, args: ["build", "--file=docker/Dockerfile", expect.stringMatching(/^--tag=.*:zn-[a-f0-9]{64}$/), "."] }] });
    // Another port/worker instance has no process-local build cache.
    expect(await createGcpBuildPort().waitForBuild(w.ctx, h, { timeoutMs: 1000 })).toEqual({ status: "succeeded", digest: DIGEST, imageUri: IMAGE });
    expect(h.buildId).not.toContain("https://example.com");
    expect(w.ctx.log).not.toHaveBeenCalled();
  });
  it("reuses a sequential build retry but gives another workload its own operation tag", async () => {
    const w = world(); const port = createGcpBuildPort();
    const h = await port.startBuild(w.ctx, buildInput()); await port.startBuild(w.ctx, buildInput());
    expect(w.fetcher.mock.calls.filter(([u, i]) => u.includes("cloudbuild") && i?.method === "POST")).toHaveLength(1);
    expect(await port.waitForBuild(w.ctx, h, { timeoutMs: 1000 })).toMatchObject({ status: "succeeded" });
    const firstTag = (w.state.build!.tags as string[])[1];
    await port.startBuild(w.ctx, { ...buildInput(), service: { ...service, address: "container_service/worker" } });
    expect((w.state.build!.tags as string[])[1]).not.toBe(firstTag);
    expect(w.fetcher.mock.calls.filter(([u, i]) => u.includes("cloudbuild") && i?.method === "POST")).toHaveLength(2);
  });
  it.each(["workspace", "environment", "managed", "resource"])("rejects a foreign %s bucket label before starting", async (tag) => {
    const w = world(); (w.state.bucket.labels as Record<string, string>)[`zenith_${tag}`] = "foreign";
    await expect(createGcpBuildPort().startBuild(w.ctx, buildInput())).rejects.toThrow("labels");
    expect(w.state.build).toBeUndefined();
  });
  it("rejects pipeline mismatch, foreign bucket, unsafe source and foreign registry without a build", async () => {
    for (const input of [
      { ...buildInput(), pipeline: { ...pipeline, ownership: "external" as const } },
      { ...buildInput(), source: { ...bundle, bucket: "foreign-bucket" } },
      { ...buildInput(), source: { ...bundle, s3Key: "../evil.tar.gz" } },
      { ...buildInput(), registry: { ...registry, externalRef: `projects/foreign-project/locations/${REGION}/repositories/evil` } },
      { ...buildInput(), service: { ...service, spec: { artifact: { type: "built", pipeline: "build_pipeline/other", registry: registry.address } } } },
    ]) { const w = world(); await expect(createGcpBuildPort().startBuild(w.ctx, input)).rejects.toThrow(); expect(w.state.build).toBeUndefined(); }
  });
  it("rejects a foreign build identity and unverifiable object generation", async () => {
    const w = world(); w.state.account.email = "foreign@other.iam.gserviceaccount.com";
    await expect(createGcpBuildPort().startBuild(w.ctx, buildInput())).rejects.toThrow("service account");
    const other = world(); delete other.state.metadata.generation;
    await expect(createGcpBuildPort().startBuild(other.ctx, buildInput())).rejects.toThrow("generation");
  });
  it.each(["FAILURE", "INTERNAL_ERROR", "CANCELLED", "TIMEOUT", "EXPIRED"])("maps native terminal state %s", async (status) => {
    const w = world(); w.state.buildStatus = status; const port = createGcpBuildPort(); const h = await port.startBuild(w.ctx, buildInput());
    expect(await port.waitForBuild(w.ctx, h, { timeoutMs: 1000 })).toMatchObject({ status: status === "CANCELLED" ? "stopped" : ["TIMEOUT", "EXPIRED"].includes(status) ? "timed_out" : "failed" });
  });
  it.each([undefined, "latest", `sha256:${"b".repeat(63)}`])("refuses missing/malformed output digest %s", async (imageDigest) => {
    const w = world(); const port = createGcpBuildPort(); const h = await port.startBuild(w.ctx, buildInput());
    (w.state.build!.results as Record<string, unknown>).images = [{ name: (w.state.build!.images as string[])[0], digest: imageDigest }];
    expect(await port.waitForBuild(w.ctx, h, { timeoutMs: 1000 })).toMatchObject({ status: "failed" });
  });
  it("refuses foreign handles, changed metadata, and mismatched Artifact Registry digest evidence", async () => {
    const w = world(); const port = createGcpBuildPort(); const h = await port.startBuild(w.ctx, buildInput());
    await expect(port.waitForBuild({ ...w.ctx, workspaceId: "foreign" }, h, { timeoutMs: 1000 })).rejects.toThrow("handle");
    w.state.registryImage = { name: "foreign", uri: IMAGE };
    await expect(port.waitForBuild(w.ctx, h, { timeoutMs: 1000 })).rejects.toThrow("verify");
    w.state.build!.tags = [];
    await expect(port.waitForBuild(w.ctx, h, { timeoutMs: 1000 })).rejects.toThrow("metadata");
  });
  it("reports bounded timeout and unknown state without exporting response content", async () => {
    const w = world(); w.state.buildStatus = "WORKING"; const port = createGcpBuildPort(); const h = await port.startBuild(w.ctx, buildInput());
    expect(await port.waitForBuild(w.ctx, h, { timeoutMs: 10 })).toEqual({ status: "timed_out" });
    w.state.build!.status = "opaque-secret-sentinel";
    await expect(port.waitForBuild(w.ctx, h, { timeoutMs: 1000 })).rejects.toThrow("state is unknown");
  });
});

describe("GCP digest revision rollout", () => {
  it("patches only the workload template, preserving network/resources/secrets, and a retry is a no-op", async () => {
    const w = world(); const prior = structuredClone(w.state.service.template); const image = IMAGE.replace(DIGEST, `sha256:${"b".repeat(64)}`); const port = createGcpWorkloadsPort();
    await port.deployImage(w.ctx, service, { uri: image, digest: `sha256:${"b".repeat(64)}` }, deploy);
    const patch = w.fetcher.mock.calls.find(([, i]) => i?.method === "PATCH")!;
    expect(patch[0]).toBe(`https://run.googleapis.com/v2/${serviceName}?updateMask=template,traffic`);
    const body = JSON.parse(String(patch[1]?.body));
    expect(body.etag).toBe("etag-1"); expect(body.template).toMatchObject({ ...(prior as object), annotations: { [IMAGE_DIGEST_ANNOTATION]: `sha256:${"b".repeat(64)}` }, containers: [expect.objectContaining({ image, env: expect.any(Array), resources: expect.any(Object) })] });
    expect(body.traffic).toEqual([{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }]);
    await port.deployImage(w.ctx, service, { uri: image, digest: `sha256:${"b".repeat(64)}` }, deploy);
    expect(w.fetcher.mock.calls.filter(([, i]) => i?.method === "PATCH")).toHaveLength(1);
  });
  it.each(["workspace", "environment", "managed", "resource"])("rejects a foreign %s service before mutation", async (tag) => {
    const w = world(); (w.state.service.labels as Record<string, string>)[`zenith_${tag}`] = "foreign";
    await expect(createGcpWorkloadsPort().deployImage(w.ctx, { ...service, externalRef: serviceName }, { uri: IMAGE, digest: DIGEST }, deploy)).rejects.toThrow("labels");
    expect(w.fetcher.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(false);
  });
  it("rejects tags, digest mismatch and foreign external ids", async () => {
    const w = world(); const port = createGcpWorkloadsPort();
    await expect(port.deployImage(w.ctx, service, { uri: IMAGE.replace(`@${DIGEST}`, ":latest"), digest: DIGEST }, deploy)).rejects.toThrow("pinned");
    await expect(port.deployImage(w.ctx, service, { uri: IMAGE, digest: `sha256:${"b".repeat(64)}` }, deploy)).rejects.toThrow("matching");
    await expect(port.deployImage(w.ctx, { ...service, externalRef: `projects/foreign/locations/${REGION}/services/web` }, { uri: IMAGE, digest: DIGEST }, deploy)).rejects.toThrow("external id");
    expect(w.fetcher).not.toHaveBeenCalled();
  });
  it("requires the observed generation and ready revision to match the pinned target", async () => {
    const w = world(); expect(await createGcpWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 1000 })).toEqual({ steady: true, detail: "The digest-pinned Cloud Run revision is ready." });
    w.state.service.latestReadyRevision = `${serviceName}/revisions/older`;
    expect(await createGcpWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 10 })).toMatchObject({ steady: false });
    w.state.service.latestReadyRevision = revisionName; w.state.service.observedGeneration = "1";
    expect(await createGcpWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 10 })).toMatchObject({ steady: false });
  });
  it("does not accept an old image in an otherwise ready revision", async () => {
    const w = world(); w.state.revision.containers = [{ image: IMAGE.replace(DIGEST, `sha256:${"c".repeat(64)}`) }];
    expect(await createGcpWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 1000 })).toMatchObject({ steady: false, detail: expect.stringContaining("does not match") });
  });
  it("routes a pinned image to the newest revision and refuses stale observed traffic", async () => {
    const w = world(); w.state.service.traffic = [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "older", percent: 100 }];
    await createGcpWorkloadsPort().deployImage(w.ctx, service, { uri: IMAGE, digest: DIGEST }, deploy);
    expect(w.state.service.traffic).toEqual([{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }]);
    w.state.service.trafficStatuses = [{ revision: `${serviceName}/revisions/older`, percent: 100 }];
    expect(await createGcpWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 10 })).toMatchObject({ steady: false });
  });
  it("updates the scheduled job's nested template, preserves retry settings and never runs it", async () => {
    const w = world(); const name = `projects/${PROJECT}/locations/${REGION}/jobs/worker`;
    const job = { ...node("scheduled_job/worker", "scheduled_job"), externalRef: name };
    w.state.jobs.set(name, { name, labels: tagged(job), generation: "1", observedGeneration: "1", reconciling: false, terminalCondition: { state: "CONDITION_SUCCEEDED" }, template: { taskCount: 1, parallelism: 1, template: { maxRetries: 1, timeout: "600s", containers: [{ image: IMAGE }] } } });
    const imageDigest = `sha256:${"b".repeat(64)}`;
    await createGcpWorkloadsPort().deployImage(w.ctx, job, { uri: IMAGE.replace(DIGEST, imageDigest), digest: imageDigest }, deploy);
    expect(w.state.jobs.get(name)).toMatchObject({ template: { template: { maxRetries: 1, timeout: "600s", containers: [{ image: IMAGE.replace(DIGEST, imageDigest) }] } } });
    expect(w.state.starts).toBe(0);
  });
  it("reports known rollout failure and treats a rejected patch as unconfirmed without cloud error text", async () => {
    const w = world(); w.state.service.terminalCondition = { state: "CONDITION_FAILED" };
    expect(await createGcpWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 1000 })).toMatchObject({ steady: false });
    w.state.patchStatus = 412;
    await expect(createGcpWorkloadsPort().deployImage(w.ctx, service, { uri: IMAGE.replace(DIGEST, `sha256:${"c".repeat(64)}`), digest: `sha256:${"c".repeat(64)}` }, deploy)).rejects.toThrow("not confirmed");
  });
});

describe("GCP one-off migration", () => {
  it("copies the owning workload's identity/network/secret references, uses argv and zero retries, and recovers on a different port", async () => {
    const w = world(); expect(await createGcpMigrationsPort().runOneOffTask(w.ctx, service, command, migrate)).toEqual({ exitCode: 0 });
    const job = [...w.state.jobs.values()][0]; const task = (job.template as { template: Record<string, unknown> }).template;
    expect(task).toMatchObject({ maxRetries: 0, serviceAccount: `web@${PROJECT}.iam.gserviceaccount.com`, vpcAccess: expect.any(Object), containers: [{ name: "web", image: IMAGE, command: ["node"], args: ["migrate.js", "$(external-data)"], env: expect.any(Array), resources: expect.any(Object) }] });
    expect((task.containers as Record<string, unknown>[])[0]).not.toHaveProperty("ports");
    expect(await createGcpMigrationsPort().runOneOffTask(w.ctx, service, command, migrate)).toEqual({ exitCode: 0 }); expect(w.state.starts).toBe(1);
  });
  it("lets only the creator launch under a concurrent duplicate", async () => {
    const w = world(); const runs = await Promise.allSettled([createGcpMigrationsPort().runOneOffTask(w.ctx, service, command, migrate), createGcpMigrationsPort().runOneOffTask(w.ctx, service, command, migrate)]);
    expect(runs.some((r) => r.status === "fulfilled")).toBe(true); expect(w.state.starts).toBe(1); expect(w.state.jobs.size).toBe(1);
  });
  it("returns an observed nonzero exit without inventing success", async () => {
    const w = world(); w.state.taskExit = 7;
    expect(await createGcpMigrationsPort().runOneOffTask(w.ctx, service, command, migrate)).toEqual({ exitCode: 7 });
  });
  it("refuses a recovered migration job with changed networking before another launch", async () => {
    const w = world(); const port = createGcpMigrationsPort(); await port.runOneOffTask(w.ctx, service, command, migrate);
    const task = ([...w.state.jobs.values()][0].template as { template: Record<string, unknown> }).template; task.vpcAccess = { egress: "ALL_TRAFFIC" };
    await expect(port.runOneOffTask(w.ctx, service, command, migrate)).rejects.toThrow("differs from its owning workload"); expect(w.state.starts).toBe(1);
  });
  it("does not infer a missing task exit from execution completion", async () => {
    const w = world(); w.state.taskExit = undefined;
    await expect(createGcpMigrationsPort().runOneOffTask(w.ctx, service, command, migrate)).rejects.toThrow("observed exit");
  });
  it("does not accept ambiguous task or execution results", async () => {
    const w = world(); w.state.before = (url) => url.pathname.endsWith("/tasks") ? w.json({ tasks: [{}, {}] }) : undefined;
    await expect(createGcpMigrationsPort().runOneOffTask(w.ctx, service, command, migrate)).rejects.toThrow("ambiguous"); expect(w.state.starts).toBe(1);
    w.state.before = (url) => url.pathname.endsWith("/executions") ? w.json({ executions: [{}, {}] }) : undefined;
    await expect(createGcpMigrationsPort().runOneOffTask(w.ctx, service, command, migrate)).rejects.toThrow("ambiguous"); expect(w.state.starts).toBe(1);
  });
  it("reports a running execution timeout as unknown and retains the launch claim", async () => {
    const w = world(); w.state.before = (url) => url.pathname.includes("/executions/zn-exec-1") && !url.pathname.endsWith("/tasks") ? w.json({ name: decodeURIComponent(url.pathname).slice(4), job: decodeURIComponent(url.pathname).slice(4).split("/executions/")[0], taskCount: 1 }) : undefined;
    const port = createGcpMigrationsPort();
    await expect(port.runOneOffTask(w.ctx, service, command, { ...migrate, timeoutMs: 20 })).rejects.toThrow("timed out");
    await expect(port.runOneOffTask(w.ctx, service, command, { ...migrate, timeoutMs: 20 })).rejects.toThrow("timed out"); expect(w.state.starts).toBe(1);
  });
  it("refuses to rerun after a lost launch response and reports unknown", async () => {
    const w = world(); w.state.launchStatus = 503;
    await expect(createGcpMigrationsPort().runOneOffTask(w.ctx, service, command, migrate)).rejects.toThrow("unconfirmed");
    await expect(createGcpMigrationsPort().runOneOffTask(w.ctx, service, command, migrate)).rejects.toThrow("will not launch again"); expect(w.state.starts).toBe(1);
  });
  it("refuses argv injection shapes, unpinned images, and foreign workspace before launch", async () => {
    const w = world(); const port = createGcpMigrationsPort();
    await expect(port.runOneOffTask(w.ctx, service, ["node\0evil"], migrate)).rejects.toThrow("argv");
    await expect(port.runOneOffTask({ ...w.ctx, workspaceId: "foreign" }, service, command, migrate)).rejects.toThrow();
    (w.state.service.template as { containers: Record<string, unknown>[] }).containers[0].image = "registry/web:latest";
    await expect(port.runOneOffTask(w.ctx, service, command, migrate)).rejects.toThrow("pinned"); expect(w.state.starts).toBe(0);
  });
  it("honors caller cancellation and rejects invalid timeout", async () => {
    const w = world(); const aborted = new AbortController(); aborted.abort();
    await expect(createGcpMigrationsPort().runOneOffTask({ ...w.ctx, signal: aborted.signal }, service, command, migrate)).rejects.toThrow();
    await expect(createGcpWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: -1 })).rejects.toThrow("timeout"); expect(w.fetcher).not.toHaveBeenCalled();
  });
  it("retains no credentials or response text in returned evidence", async () => {
    const w = world(); const result = await createGcpMigrationsPort().runOneOffTask(w.ctx, service, command, migrate);
    expect(JSON.stringify(result)).toBe('{"exitCode":0}'); expect(w.ctx.log).not.toHaveBeenCalled();
    expect(w.ctx.workspaceId).toBe(WS); expect(w.ctx.environmentId).toBe(ENV);
  });
});
