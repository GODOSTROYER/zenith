/** Azure release contract evidence only: synthetic ARM, blob upload and journal. */
import { describe, expect, it } from "vitest";
import { createAzureBuildPort, createAzureWorkloadsPort, createAzureMigrationsPort } from "@/lib/platform/release-azure";
import { world, node, tagged, pipeline, service, registry, bundle, DIGEST, IMAGE, environmentId, registryId, ROOT, SUB } from "./release-fixtures";

const buildInput = () => ({ pipeline, service, registry, source: { ...bundle }, idempotencyKey: "op-1:build" });
const rollout = { idempotencyKey: "op-1:deploy" };
const migration = { idempotencyKey: "op-1:migrate", timeoutMs: 1000 };
const command = ["node", "migrate.js", "$(external-data)"];

describe("Azure customer-account ACR build", () => {
  it("reuses runAcrBuild, verifies source bytes, sends SAS only to plain upload fetch, and recovers the native digest on another port", async () => {
    const w = world(); const h = await createAzureBuildPort(w.options).startBuild(w.ctx, buildInput());
    expect(w.state.schedules).toBe(1); expect(w.readSource).toHaveBeenCalledWith(expect.objectContaining({ session: w.ctx.session }), bundle);
    const schedule = w.fetcher.mock.calls.find(([u]) => u.includes("scheduleRun"))!;
    expect(JSON.parse(String(schedule[1]?.body))).toMatchObject({ type: "DockerBuildRequest", isPushEnabled: true, dockerFilePath: "docker/Dockerfile", sourceLocation: "source/upload.tar.gz", imageNames: ["web:latest", expect.stringMatching(/^web:zn-[a-f0-9]{64}$/)] });
    expect(w.uploadFetch).toHaveBeenCalledWith(expect.stringContaining("sig=secret-sas-sentinel"), expect.objectContaining({ method: "PUT", redirect: "error", headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/octet-stream" } }));
    expect(w.fetcher.mock.calls.every(([u]) => !u.includes("sig="))).toBe(true);
    expect(await createAzureBuildPort().waitForBuild(w.ctx, h, { timeoutMs: 1000 })).toEqual({ status: "succeeded", imageUri: IMAGE, digest: DIGEST });
    expect(h.buildId).not.toContain("secret-sas"); expect(w.ctx.log).not.toHaveBeenCalled();
  });
  it("persists identifier-only receipts and avoids duplicate scheduling across port instances", async () => {
    const w = world(); const h = await createAzureBuildPort(w.options).startBuild(w.ctx, buildInput());
    expect(await createAzureBuildPort(w.options).startBuild(w.ctx, buildInput())).toEqual(h); expect(w.state.schedules).toBe(1);
    const [scope, receipt] = (w.receipts.port.record as ReturnType<typeof import("vitest").vi.fn>).mock.calls[0];
    expect(scope).toEqual({ workspaceId: w.ctx.workspaceId, environmentId: w.ctx.environmentId, key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(Object.keys(JSON.parse(receipt)).sort()).toEqual(["version", "scope", "registryId", "registryAddress", "loginServer", "repository", "runId", "tag"].sort());
    expect(receipt).not.toContain("secret-sas-sentinel"); expect(receipt).not.toContain("session");
  });
  it("refuses missing production dependencies before requesting any upload", async () => {
    const w = world(); await expect(createAzureBuildPort().startBuild(w.ctx, buildInput())).rejects.toThrow("source reader"); expect(w.fetcher).not.toHaveBeenCalled();
  });
  it.each(["workspace", "environment", "managed", "resource"])("refuses a foreign %s registry before loading source", async (tag) => {
    const w = world(); (w.state.registry.tags as Record<string, string>)[`zenith:${tag}`] = "foreign";
    await expect(createAzureBuildPort(w.options).startBuild(w.ctx, buildInput())).rejects.toThrow("outside"); expect(w.readSource).not.toHaveBeenCalled(); expect(w.state.schedules).toBe(0);
  });
  it("refuses foreign subscription, wrong pipeline, source digest mismatch and signed metadata", async () => {
    const w = world(); const port = createAzureBuildPort(w.options);
    await expect(port.startBuild(w.ctx, { ...buildInput(), registry: { ...registry, externalRef: registryId.replace(SUB, "99999999-2222-3333-4444-555555555555") } })).rejects.toThrow("external id");
    await expect(port.startBuild(w.ctx, { ...buildInput(), service: { ...service, spec: { artifact: { type: "built", pipeline: "other", registry: registry.address } } } })).rejects.toThrow("inputs");
    await expect(port.startBuild(w.ctx, { ...buildInput(), source: { ...bundle, s3Key: "https://blob/source?sig=secret" } })).rejects.toThrow("inputs");
    await expect(port.startBuild(w.ctx, { ...buildInput(), source: { ...bundle, digest: "b".repeat(64) } })).rejects.toThrow("bytes"); expect(w.state.schedules).toBe(0);
  });
  it.each([undefined, "bad-digest"])("refuses a successful run without a verified image digest %s", async (imageDigest) => {
    const w = world(); w.state.runDigest = imageDigest; const h = await createAzureBuildPort(w.options).startBuild(w.ctx, buildInput());
    expect(await createAzureBuildPort().waitForBuild(w.ctx, h, { timeoutMs: 1000 })).toMatchObject({ status: "failed" });
  });
  it("rejects foreign output repository/tag/digest handles", async () => {
    const w = world(); const h = await createAzureBuildPort(w.options).startBuild(w.ctx, buildInput());
    await expect(createAzureBuildPort().waitForBuild({ ...w.ctx, workspaceId: "foreign" }, h, { timeoutMs: 1000 })).rejects.toThrow("handle");
    (w.state.run!.properties as { outputImages: Record<string, unknown>[] }).outputImages.forEach((i) => { i.registry = "foreign.azurecr.io"; });
    expect(await createAzureBuildPort().waitForBuild(w.ctx, h, { timeoutMs: 1000 })).toMatchObject({ status: "failed" });
  });
  it.each(["Canceled", "Timeout", "Failed", "Error"])("maps native terminal state %s when recovering", async (status) => {
    const w = world(); const h = await createAzureBuildPort(w.options).startBuild(w.ctx, buildInput()); (w.state.run!.properties as Record<string, unknown>).status = status;
    expect(await createAzureBuildPort().waitForBuild(w.ctx, h, { timeoutMs: 1000 })).toMatchObject({ status: status === "Canceled" ? "stopped" : status === "Timeout" ? "timed_out" : "failed" });
  });
  it("reports bounded timeout and refuses unknown build status", async () => {
    const w = world(); const h = await createAzureBuildPort(w.options).startBuild(w.ctx, buildInput()); (w.state.run!.properties as Record<string, unknown>).status = "Running";
    expect(await createAzureBuildPort().waitForBuild(w.ctx, h, { timeoutMs: 10 })).toEqual({ status: "timed_out" });
    (w.state.run!.properties as Record<string, unknown>).status = "opaque-secret-sentinel";
    await expect(createAzureBuildPort().waitForBuild(w.ctx, h, { timeoutMs: 1000 })).rejects.toThrow("state is unknown");
  });
  it("leaves a lost schedule response uncertain and never schedules the same launch again", async () => {
    const w = world(); w.state.before = (u) => u.pathname.endsWith("/scheduleRun") ? w.json({ error: { message: "opaque-secret-sentinel" } }, 503) : undefined;
    await expect(createAzureBuildPort(w.options).startBuild(w.ctx, buildInput())).rejects.toThrow("consumed launch key");
    await expect(createAzureBuildPort(w.options).startBuild(w.ctx, buildInput())).rejects.toThrow("will not launch again");
    expect(w.fetcher.mock.calls.filter(([u]) => u.includes("scheduleRun"))).toHaveLength(1);
  });
});

describe("Azure digest rollout", () => {
  it("creates a deterministic revision suffix, preserves network/configuration, and retries do not create revisions", async () => {
    const w = world(); const port = createAzureWorkloadsPort(); const imageDigest = `sha256:${"b".repeat(64)}`; const uri = IMAGE.replace(DIGEST, imageDigest);
    const config = structuredClone((w.state.app.properties as Record<string, unknown>).configuration);
    await port.deployImage(w.ctx, service, { uri, digest: imageDigest }, rollout); await port.deployImage(w.ctx, service, { uri, digest: imageDigest }, rollout);
    const patches = w.fetcher.mock.calls.filter(([, i]) => i?.method === "PATCH"); expect(patches).toHaveLength(1);
    expect(patches[0][1]?.headers).toMatchObject({ "if-match": "etag-1" });
    expect(JSON.parse(String(patches[0][1]?.body))).toMatchObject({ properties: { template: { revisionSuffix: expect.stringMatching(/^zn-[a-f0-9]{32}$/), containers: [{ name: "web", image: uri, resources: { cpu: 0.5, memory: "1Gi" }, env: [{ name: "DB", secretRef: "database" }] }] } } });
    expect((w.state.app.properties as Record<string, unknown>).configuration).toEqual(config);
  });
  it("rejects latest, inconsistent digests and foreign workspace before any write", async () => {
    const w = world(); const port = createAzureWorkloadsPort();
    await expect(port.deployImage(w.ctx, service, { uri: "zenithregistry.azurecr.io/web:latest", digest: DIGEST }, rollout)).rejects.toThrow("pinned");
    await expect(port.deployImage(w.ctx, service, { uri: IMAGE, digest: `sha256:${"b".repeat(64)}` }, rollout)).rejects.toThrow("matching");
    await expect(port.deployImage({ ...w.ctx, workspaceId: "foreign" }, service, { uri: IMAGE, digest: DIGEST }, rollout)).rejects.toThrow("outside");
    expect(w.fetcher.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(false);
  });
  it("requires a healthy active target revision at the exact image digest", async () => {
    const w = world(); const port = createAzureWorkloadsPort();
    expect(await port.waitSteady(w.ctx, service, { timeoutMs: 1000 })).toMatchObject({ steady: true });
    (w.state.revision.properties as { template: { containers: Record<string, unknown>[] } }).template.containers[0].image = IMAGE.replace(DIGEST, `sha256:${"c".repeat(64)}`);
    expect(await port.waitSteady(w.ctx, service, { timeoutMs: 1000 })).toMatchObject({ steady: false, detail: expect.stringContaining("does not match") });
  });
  it("does not accept an older healthy revision or unknown health", async () => {
    const w = world(); const props = w.state.app.properties as Record<string, unknown>; props.latestReadyRevisionName = "web--older";
    expect(await createAzureWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 10 })).toMatchObject({ steady: false });
    props.latestReadyRevisionName = props.latestRevisionName; delete (w.state.revision.properties as Record<string, unknown>).healthState;
    expect(await createAzureWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 10 })).toMatchObject({ steady: false });
  });
  it("refuses mixed revision mode and stale traffic to an old revision", async () => {
    const w = world(); const configuration = (w.state.app.properties as { configuration: Record<string, unknown> }).configuration;
    configuration.activeRevisionsMode = "Multiple";
    await expect(createAzureWorkloadsPort().deployImage(w.ctx, service, { uri: IMAGE, digest: DIGEST }, rollout)).rejects.toThrow("Single");
    expect(await createAzureWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 1000 })).toMatchObject({ steady: false });
    configuration.activeRevisionsMode = "Single"; configuration.ingress = { traffic: [{ revisionName: "web--older", weight: 100 }] };
    expect(await createAzureWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 10 })).toMatchObject({ steady: false });
  });
  it("updates a scheduled job definition without starting it or changing its trigger", async () => {
    const w = world(); const id = `${ROOT}/Microsoft.App/jobs/worker`; const job = { ...node("scheduled_job/worker", "scheduled_job"), externalRef: id };
    w.state.jobs.set(id, { id, name: "worker", type: "Microsoft.App/jobs", location: w.ctx.region, tags: tagged(job), properties: { provisioningState: "Succeeded", configuration: { triggerType: "Schedule", scheduleTriggerConfig: { cronExpression: "0 * * * *" } }, template: { containers: [{ name: "worker", image: IMAGE, resources: { cpu: 0.5, memory: "1Gi" } }] } } });
    const imageDigest = `sha256:${"b".repeat(64)}`;
    await createAzureWorkloadsPort().deployImage(w.ctx, job, { uri: IMAGE.replace(DIGEST, imageDigest), digest: imageDigest }, rollout);
    expect(w.state.jobs.get(id)).toMatchObject({ properties: { configuration: { triggerType: "Schedule" }, template: { containers: [{ image: IMAGE.replace(DIGEST, imageDigest) }] } } }); expect(w.state.starts).toBe(0);
  });
  it("reports failed target revision and a rejected mutation without leaking cloud errors", async () => {
    const w = world(); (w.state.revision.properties as Record<string, unknown>).healthState = "Unhealthy";
    expect(await createAzureWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: 1000 })).toMatchObject({ steady: false });
    w.state.patchStatus = 412;
    await expect(createAzureWorkloadsPort().deployImage(w.ctx, service, { uri: IMAGE.replace(DIGEST, `sha256:${"b".repeat(64)}`), digest: `sha256:${"b".repeat(64)}` }, rollout)).rejects.toThrow("not confirmed");
  });
});

describe("Azure one-off migration", () => {
  it("creates one manual, zero-retry job with the workload identity/network/references and literal argv; replay reads its execution", async () => {
    const w = world(); expect(await createAzureMigrationsPort(w.receipts.port).runOneOffTask(w.ctx, service, command, migration)).toEqual({ exitCode: 0 });
    const job = [...w.state.jobs.values()][0]; expect(job).toMatchObject({ identity: w.state.app.identity, properties: { environmentId, configuration: { triggerType: "Manual", replicaRetryLimit: 0, manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }, registries: expect.any(Array), secrets: [{ keyVaultUrl: "https://zenithvault.vault.azure.net/secrets/database", identity: expect.any(String), name: "database" }] }, template: { containers: [{ name: "web", image: IMAGE, command: ["node"], args: ["migrate.js", "$(external-data)"], env: [{ name: "DB", secretRef: "database" }] }] } } });
    expect(await createAzureMigrationsPort(w.receipts.port).runOneOffTask(w.ctx, service, command, migration)).toEqual({ exitCode: 0 }); expect(w.state.starts).toBe(1);
    expect(JSON.stringify([...w.receipts.references.values()])).not.toContain("session"); expect(w.ctx.log).not.toHaveBeenCalled();
  });
  it("uses an atomic journal to prevent concurrent double starts", async () => {
    const w = world(); const results = await Promise.allSettled([createAzureMigrationsPort(w.receipts.port).runOneOffTask(w.ctx, service, command, migration), createAzureMigrationsPort(w.receipts.port).runOneOffTask(w.ctx, service, command, migration)]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true); expect(w.state.starts).toBe(1); expect(w.state.jobs.size).toBe(1);
  });
  it("requires a durable launch journal and bounded argv", async () => {
    const w = world(); await expect(createAzureMigrationsPort().runOneOffTask(w.ctx, service, command, migration)).rejects.toThrow("durable");
    await expect(createAzureMigrationsPort(w.receipts.port).runOneOffTask(w.ctx, service, ["node\0evil"], migration)).rejects.toThrow("argv"); expect(w.state.starts).toBe(0);
  });
  it("fails a native failed execution without manufacturing a numeric process exit", async () => {
    const w = world(); w.state.executionStatus = "Failed";
    await expect(createAzureMigrationsPort(w.receipts.port).runOneOffTask(w.ctx, service, command, migration)).rejects.toThrow("does not expose its numeric exit code");
  });
  it("refuses to start again when a launch response was lost", async () => {
    const w = world(); w.state.launchStatus = 503; const port = createAzureMigrationsPort(w.receipts.port);
    await expect(port.runOneOffTask(w.ctx, service, command, migration)).rejects.toThrow("unconfirmed");
    await expect(port.runOneOffTask(w.ctx, service, command, migration)).rejects.toThrow("will not launch again"); expect(w.state.starts).toBe(1);
  });
  it("never copies a plaintext secret into the migration job", async () => {
    const w = world(); const props = w.state.app.properties as { configuration: { secrets: Record<string, unknown>[] } }; props.configuration.secrets[0].value = "opaque-secret-sentinel";
    await expect(createAzureMigrationsPort(w.receipts.port).runOneOffTask(w.ctx, service, command, migration)).rejects.toThrow("references only"); expect(w.state.jobs.size).toBe(0); expect(w.state.starts).toBe(0);
  });
  it("refuses a system-assigned identity because a new job cannot reuse its principal", async () => {
    const w = world(); w.state.app.identity = { type: "SystemAssigned", principalId: "opaque-principal" };
    await expect(createAzureMigrationsPort(w.receipts.port).runOneOffTask(w.ctx, service, command, migration)).rejects.toThrow("reusable user-assigned identity"); expect(w.state.starts).toBe(0);
  });
  it("rejects a secret wired to an identity outside the owning workload", async () => {
    const w = world(); const props = w.state.app.properties as { configuration: { secrets: Record<string, unknown>[] } }; props.configuration.secrets[0].identity = "system";
    await expect(createAzureMigrationsPort(w.receipts.port).runOneOffTask(w.ctx, service, command, migration)).rejects.toThrow("workload's own"); expect(w.state.jobs.size).toBe(0);
  });
  it("reports a running migration timeout as unknown and never restarts it", async () => {
    const w = world(); w.state.executionStatus = "Running"; const port = createAzureMigrationsPort(w.receipts.port);
    await expect(port.runOneOffTask(w.ctx, service, command, { ...migration, timeoutMs: 20 })).rejects.toThrow("timed out");
    await expect(port.runOneOffTask(w.ctx, service, command, { ...migration, timeoutMs: 20 })).rejects.toThrow("timed out"); expect(w.state.starts).toBe(1);
  });
  it("rejects ambiguous executions and changed migration commands without a second start", async () => {
    const w = world(); const port = createAzureMigrationsPort(w.receipts.port);
    await port.runOneOffTask(w.ctx, service, command, migration);
    await expect(port.runOneOffTask(w.ctx, service, ["node", "other.js"], migration)).rejects.toThrow("does not match");
    const job = [...w.state.executions.keys()][0]; w.state.executions.get(job)!.push({ name: "other-execution" });
    await expect(port.runOneOffTask(w.ctx, service, command, migration)).rejects.toThrow("ambiguous"); expect(w.state.starts).toBe(1);
  });
  it("refuses a recovered job with changed environment or secret references", async () => {
    const w = world(); const port = createAzureMigrationsPort(w.receipts.port); await port.runOneOffTask(w.ctx, service, command, migration);
    const job = [...w.state.jobs.values()][0]; (job.properties as Record<string, unknown>).environmentId = environmentId.replace("zenith-env-1", "foreign-environment");
    await expect(port.runOneOffTask(w.ctx, service, command, migration)).rejects.toThrow("differs from its owning workload"); expect(w.state.starts).toBe(1);
  });
  it("refuses a foreign workload and an unpinned image before launch", async () => {
    const w = world(); const port = createAzureMigrationsPort(w.receipts.port);
    await expect(port.runOneOffTask({ ...w.ctx, workspaceId: "foreign" }, service, command, migration)).rejects.toThrow("outside");
    (w.state.app.properties as { template: { containers: Record<string, unknown>[] } }).template.containers[0].image = "zenithregistry.azurecr.io/web:latest";
    await expect(port.runOneOffTask(w.ctx, service, command, migration)).rejects.toThrow("pinned"); expect(w.state.starts).toBe(0);
  });
  it("honors cancellation and refuses unbounded timeouts", async () => {
    const w = world(); const aborted = new AbortController(); aborted.abort();
    await expect(createAzureMigrationsPort(w.receipts.port).runOneOffTask({ ...w.ctx, signal: aborted.signal }, service, command, migration)).rejects.toThrow();
    await expect(createAzureWorkloadsPort().waitSteady(w.ctx, service, { timeoutMs: NaN })).rejects.toThrow("timeout"); expect(w.fetcher).not.toHaveBeenCalled();
  });
});
