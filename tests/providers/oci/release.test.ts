/** OCI release contract tests exercise serialized runner jobs, never label fakes live. */
import { describe, expect, it } from "vitest";
import { StepFailedError } from "@/lib/execution/errors";
import { createReleasePorts } from "@/lib/platform/release";
import { isAllowed, OCI_ALLOWLIST } from "@/lib/providers/oci/allowlist";
import { createRunnerOciTransport } from "@/lib/providers/oci/runner-transport";
import { containerInstanceDriver } from "@/lib/providers/oci/drivers/compute/container-instance";
import { MIGRATION_TAG } from "@/lib/providers/oci/naming";
import { createOciBuildPort } from "@/lib/platform/release-oci";
import { command, DIGEST, IMAGE, migrationOpts, service, world, type Native } from "./release-fixtures";
import { ocid, zenithTagsFor } from "./_support";

const ports = () => createReleasePorts();
const image = { uri: IMAGE, digest: DIGEST };
const deployOpts = { idempotencyKey: "op:deploy" };
const body = (w: ReturnType<typeof world>) => JSON.parse(Buffer.from(w.jobs.find((j) => j.method === "POST")!.bodyB64!, "base64").toString("utf8"));
const source = (w: ReturnType<typeof world>) => [...w.objects.values()][0];
const sourceContainer = (w: ReturnType<typeof world>) => [...w.containers.values()][0];

describe("OCI release composition and preconditions", () => {
  it("refuses source builds clearly without runner calls", async () => {
    const w = world();
    const input = { service, pipeline: service, source: { s3Key: "unused", digest: DIGEST }, idempotencyKey: "build" };
    await expect(ports().build.startBuild(w.ctx, input)).rejects.toThrow("bring a pre-built OCIR image");
    await expect(createOciBuildPort().waitForBuild(w.ctx, { buildId: "unknown" }, { timeoutMs: 10 })).rejects.toThrow("bring a pre-built OCIR image");
    expect(w.jobs).toHaveLength(0);
  });
  it.each(["workspace", "environment", "region", "expiry", "capability"])("rejects a foreign or invalid %s before calls", async (which) => {
    const w = world();
    if (which === "workspace") w.ctx.workspaceId = "foreign";
    if (which === "environment") w.ctx.environmentId = "foreign";
    if (which === "region") w.ctx.region = "eu-frankfurt-1";
    if (which === "expiry") w.ctx.session = { ...w.ctx.session, expiresAt: "2000-01-01T00:00:00Z" };
    if (which === "capability") w.ctx.session = { ...w.ctx.session, capability: "infrastructure.observe" };
    await expect(ports().workloads.waitSteady(w.ctx, service, { timeoutMs: 10 })).rejects.toThrow(StepFailedError);
    expect(w.jobs).toHaveLength(0);
  });
  it.each(["referenced", "external"] as const)("refuses %s workloads before calls", async (ownership) => {
    const w = world();
    await expect(ports().migrations.runOneOffTask(w.ctx, { ...service, ownership }, command, migrationOpts)).rejects.toThrow(StepFailedError);
    expect(w.jobs).toHaveLength(0);
  });
  it.each([0, -1, Number.NaN, 1.5, 1_800_001])("refuses invalid timeout %s", async (timeoutMs) => {
    const w = world();
    await expect(ports().workloads.waitSteady(w.ctx, service, { timeoutMs })).rejects.toThrow(StepFailedError);
    expect(w.jobs).toHaveLength(0);
  });
});

describe("OCI manifest-owned image rollout", () => {
  it("verifies every replica image through oci.http and waits for ACTIVE", async () => {
    const w = world();
    expect(await ports().workloads.deployImage(w.ctx, service, image, deployOpts)).toMatchObject({ detail: expect.stringContaining("OpenTofu") });
    expect(await ports().workloads.waitSteady(w.ctx, service, { timeoutMs: 1000 })).toMatchObject({ steady: true });
    expect(w.jobs.filter((j) => j.path.includes("/containers/"))).toHaveLength(4);
    expect(w.jobs.every((j) => j.method === "GET" && isAllowed("deployment.deploy", j))).toBe(true);
  });
  it("refuses a different digest or a mutable manifest tag without a fabricated update", async () => {
    const w = world();
    await expect(ports().workloads.deployImage(w.ctx, service, { uri: IMAGE.replace(DIGEST, `sha256:${"b".repeat(64)}`), digest: `sha256:${"b".repeat(64)}` }, deployOpts)).rejects.toThrow("immutable");
    await expect(ports().workloads.waitSteady(w.ctx, { ...service, spec: { ...service.spec, artifact: { type: "image", ref: "iad.ocir.io/acme/app:latest" } } }, { timeoutMs: 10 })).rejects.toThrow("pinned");
    expect(w.jobs).toHaveLength(0);
  });
  it.each(["wrong image", "foreign compartment", "foreign workspace", "missing container", "duplicate", "truncated", "failed"])("never reports %s as steady", async (which) => {
    const w = world();
    if (which === "wrong image") sourceContainer(w).imageUrl = IMAGE.replace(DIGEST, `sha256:${"b".repeat(64)}`);
    if (which === "foreign compartment") source(w).compartmentId = ocid("compartment", "foreign");
    if (which === "foreign workspace") (source(w).freeformTags as Native).zenith_workspace = "foreign";
    if (which === "missing container") source(w).containers = [];
    if (which === "failed") source(w).lifecycleState = "FAILED";
    if (["duplicate", "truncated"].includes(which)) w.state.override = (req) => req.path === "/20210415/containerInstances" ? {
      status: 200, headers: Object.fromEntries(which === "truncated" ? [["opc-next-page", "repeated"]] : []),
      body: { items: which === "duplicate" ? [source(w), source(w)] : [] } } : undefined;
    expect(await ports().workloads.waitSteady(w.ctx, service, { timeoutMs: 20 })).toMatchObject({ steady: false });
    expect(w.jobs.every((j) => j.method === "GET")).toBe(true);
  });
  it("handles zero replicas only after a complete listing", async () => {
    const w = world(); w.objects.clear();
    expect(await ports().workloads.waitSteady(w.ctx, { ...service, spec: { ...service.spec, replicas: 0 } }, { timeoutMs: 100 })).toMatchObject({ steady: true });
    expect(w.jobs).toHaveLength(1);
  });
  it("bounds pending polling and honours cancellation", async () => {
    const w = world(); sourceContainer(w).lifecycleState = "CREATING";
    expect(await ports().workloads.waitSteady(w.ctx, service, { timeoutMs: 20 })).toMatchObject({ steady: false });
    const abort = new AbortController(); abort.abort(); w.ctx.signal = abort.signal; w.jobs.length = 0;
    expect(await ports().workloads.waitSteady(w.ctx, service, { timeoutMs: 100 })).toMatchObject({ steady: false });
    expect(w.jobs).toHaveLength(0);
  });
});

describe("OCI one-off migrations", () => {
  it("launches argv without a shell, on the same private subnet/NSGs, with NEVER and suppressed logs", async () => {
    const w = world();
    expect(await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).toEqual({ exitCode: 0 });
    expect(body(w)).toMatchObject({ containerRestartPolicy: "NEVER", compartmentId: w.ctx.session.compartmentOcid,
      containers: [{ imageUrl: IMAGE, command, arguments: [], isResourcePrincipalDisabled: false,
        environmentVariables: { LOG_LEVEL: "info", ZENITH_SECRET_OCID_DATABASE_PASSWORD: ocid("vaultsecret", "db") } }],
      vnics: [{ subnetId: w.vnic.subnetId, nsgIds: w.vnic.nsgIds, isPublicIpAssigned: false }] });
    const serialized = JSON.stringify(body(w));
    expect(serialized).not.toMatch(/PRIVATE_CLOUD_ENV_CANARY|RAW_LOG_CANARY|healthChecks|UNDECLARED_SECRET/);
    expect(w.ctx.log).toHaveBeenCalledWith("OCI migration exited with code 0; container logs suppressed.", "info");
    expect(w.jobs.every((j) => isAllowed("deployment.deploy", j))).toBe(true);
    expect(w.jobs.filter((j) => j.method === "POST")).toHaveLength(1);
  });
  it("recovers completed executions on another adapter without launching again", async () => {
    const w = world();
    await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts);
    expect(await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).toEqual({ exitCode: 0 });
    expect(w.state.launches).toBe(1); expect(w.jobs.filter((j) => j.method === "POST")).toHaveLength(1);
  });
  it("concurrent launches use the same retry token and create one instance", async () => {
    const w = world();
    const results = await Promise.all([
      ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts),
      ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts),
    ]);
    expect(results).toEqual([{ exitCode: 0 }, { exitCode: 0 }]);
    expect(w.state.launches).toBe(1);
    expect(new Set(w.jobs.filter((j) => j.method === "POST").map((j) => j.headers["opc-retry-token"])).size).toBe(1);
  });
  it("a lost launch response stays uncertain and can be observed without relaunch", async () => {
    const w = world(); w.state.throwAfterLaunch = true;
    const failure = await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(StepFailedError);
    expect(String(failure)).toContain("unknown"); expect(String(failure)).not.toContain("CANARY");
    w.state.throwAfterLaunch = false;
    expect(await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).toEqual({ exitCode: 0 });
    expect(w.state.launches).toBe(1);
  });
  it("uses stable launch tokens bound to tenant, command and operation", async () => {
    const a = world(); const b = world();
    await ports().migrations.runOneOffTask(a.ctx, service, command, migrationOpts);
    await ports().migrations.runOneOffTask(b.ctx, service, command, migrationOpts);
    const token = (w: ReturnType<typeof world>) => w.jobs.find((j) => j.method === "POST")!.headers["opc-retry-token"];
    expect(token(a)).toBe(token(b)); expect(token(a)).toMatch(/^zenith-[a-f0-9]{48}$/);
    const changed = world(); changed.ctx.operationId = "another-operation";
    await ports().migrations.runOneOffTask(changed.ctx, service, command, migrationOpts);
    expect(token(changed)).not.toBe(token(a));
    const argv = world(); await ports().migrations.runOneOffTask(argv.ctx, service, ["node", "different.js"], migrationOpts);
    expect(token(argv)).not.toBe(token(a));
  });
  it("returns observed nonzero exits without claiming successful migration", async () => {
    const w = world(); w.state.exitCode = 7;
    expect(await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).toEqual({ exitCode: 7 });
  });
  it.each([undefined, -1, 256, 1.5])("missing/invalid exit %s remains unknown", async (exitCode) => {
    const w = world(); w.state.exitCode = exitCode;
    await expect(ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).rejects.toThrow("observed exit code");
    expect(w.ctx.log).not.toHaveBeenCalled(); expect(w.state.launches).toBe(1);
  });
  it("times out a running migration without relaunch, fabricated exit or cleanup", async () => {
    const w = world(); w.state.lifecycle = "ACTIVE";
    await expect(ports().migrations.runOneOffTask(w.ctx, service, command, { ...migrationOpts, timeoutMs: 25 })).rejects.toThrow("unknown");
    expect(w.state.launches).toBe(1); expect(w.ctx.log).not.toHaveBeenCalled();
    expect(w.jobs.some((j) => j.path.includes("/actions/"))).toBe(false);
  });
  it.each([
    { argv: [] }, { argv: [""] }, { argv: ["node", "bad\0arg"] },
    { argv: ["node", "password=CANARY"] }, { argv: ["node", "https://CANARY@host/path"] },
  ])("refuses invalid argv $argv before calls", async ({ argv }) => {
    const w = world();
    await expect(ports().migrations.runOneOffTask(w.ctx, service, argv, migrationOpts)).rejects.toThrow(StepFailedError);
    expect(w.jobs).toHaveLength(0);
  });
  it.each(["public network", "extra volume", "raw registry secret", "secret env", "env drift"])("refuses %s without launch", async (which) => {
    const w = world(); let node = service;
    if (which === "public network") w.vnic.publicIp = "203.0.113.1";
    if (which === "extra volume") source(w).volumes = [{ name: "extra" }];
    if (which === "raw registry secret") source(w).imagePullSecrets = [{ password: "CANARY" }];
    if (which === "secret env") node = { ...service, spec: { ...service.spec, env: [{ key: "PASSWORD", value: "CANARY" }] } };
    if (which === "env drift") (sourceContainer(w).environmentVariables as Native).LOG_LEVEL = "changed";
    await expect(ports().migrations.runOneOffTask(w.ctx, node, command, migrationOpts)).rejects.toThrow(StepFailedError);
    expect(w.state.launches).toBe(0);
  });
  it("refuses incomplete listings before launch and suppresses provider/transport diagnostics", async () => {
    const w = world(); w.state.override = () => ({ status: 403, headers: {}, body: { message: "PRIVATE_PROVIDER_BODY_CANARY" } });
    await expect(ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).rejects.toThrow("unknown");
    expect(w.state.launches).toBe(0); expect(w.ctx.log).not.toHaveBeenCalled();
  });
  it("refuses a truncated prelaunch listing without using absence as permission", async () => {
    const w = world(); w.state.override = (req) => req.path === "/20210415/containerInstances" ?
      { status: 200, headers: { "opc-next-page": "repeated" }, body: { items: [] } } : undefined;
    await expect(ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).rejects.toThrow("incomplete");
    expect(w.state.launches).toBe(0);
  });
  it("does not count, discover or restart one-off instances as workload replicas", async () => {
    const w = world(); await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts);
    expect(await ports().workloads.waitSteady(w.ctx, service, { timeoutMs: 1000 })).toMatchObject({ steady: true });
    const runtime = await containerInstanceDriver.runtime!(w.ctx, service);
    expect(runtime.counts.running).toBe(2);
    const discovered = await containerInstanceDriver.discover!(w.ctx);
    expect(discovered).toHaveLength(2);
    w.ctx.session = { ...w.ctx.session, transport: createRunnerOciTransport(w.dispatch, { capability: "service.restart" }) };
    w.state.override = (req) => req.path.endsWith("/actions/restart") ? { status: 204, headers: {}, body: undefined } : undefined;
    expect(await containerInstanceDriver.operations!["service.restart"](w.ctx, service, {})).toMatchObject({ ok: true });
    expect(w.jobs.filter((j) => j.path.endsWith("/actions/restart"))).toHaveLength(2);
  });
  it.each(["image", "command", "tag", "restart policy"])("refuses recovered execution with changed %s without relaunch", async (which) => {
    const w = world(); await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts);
    const migration = [...w.objects.values()].find((o) => (o.freeformTags as Native)[MIGRATION_TAG])!;
    const c = [...w.containers.values()].find((o) => o.containerInstanceId === migration.id)!;
    if (which === "image") c.imageUrl = IMAGE.replace(DIGEST, `sha256:${"b".repeat(64)}`);
    if (which === "command") c.command = ["different-command"];
    if (which === "tag") w.state.override = (req) => req.path.endsWith(String(migration.id)) ?
      { status: 200, headers: {}, body: { ...migration, freeformTags: { ...migration.freeformTags as Native, [MIGRATION_TAG]: "different" } } } : undefined;
    if (which === "restart policy") migration.containerRestartPolicy = "ALWAYS";
    await expect(ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).rejects.toThrow("unknown");
    expect(w.state.launches).toBe(1);
  });
  it("duplicate recovered executions are unknown and never relaunched", async () => {
    const w = world(); await ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts);
    const migration = [...w.objects.values()].find((o) => (o.freeformTags as Native)[MIGRATION_TAG])!;
    w.objects.set(ocid("computecontainerinstance", "duplicate"), { ...migration, id: ocid("computecontainerinstance", "duplicate") });
    await expect(ports().migrations.runOneOffTask(w.ctx, service, command, migrationOpts)).rejects.toThrow("duplicate");
    expect(w.state.launches).toBe(1);
  });
});

describe("OCI release capability boundary", () => {
  it("adds only migration creation to deploy; all other capabilities refuse it", () => {
    const launch = { service: "containerinstances", method: "POST", path: "/20210415/containerInstances" } as const;
    expect(Object.entries(OCI_ALLOWLIST).filter(([cap]) => isAllowed(cap, launch)).map(([cap]) => cap)).toEqual(["deployment.deploy"]);
    expect(OCI_ALLOWLIST["deployment.deploy"].filter((r) => r.method !== "GET")).toEqual([{ service: "containerinstances", method: "POST", pattern: "containerInstances" }]);
  });
  it("an observe-only transport refuses the migration POST even with a forged session capability", async () => {
    const w = world("infrastructure.observe"); w.ctx.session = { ...w.ctx.session, capability: "deployment.deploy" };
    // Direct boundary check avoids depending on whether ancillary deploy reads
    // also happen to be available to an observe session.
    await expect(w.ctx.session.transport.request({ service: "containerinstances", region: w.ctx.region,
      method: "POST", path: "/20210415/containerInstances", headers: { "opc-retry-token": "token" },
      body: { freeformTags: zenithTagsFor(service.address) } })).rejects.toThrow("allowlist");
    expect(w.dispatch).not.toHaveBeenCalled();
  });
});
