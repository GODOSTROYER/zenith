/**
 * Day-two operations and write helpers against the fake API:
 * service.restart / service.scale (Cloud Run), database.snapshot (Cloud SQL),
 * syncSecretValue (Secret Manager) and the ADR-0016 build helpers.
 */
import { afterEach, describe, expect, it } from "vitest";
import { gcpDrivers } from "@/lib/providers/gcp/drivers";
import { getBuild, startBuild, validateBuildInput, type StartBuildInput } from "@/lib/providers/gcp/drivers/build/build-api";
import { crc32c, syncSecretValue, SYNC_ANNOTATION } from "@/lib/providers/gcp/drivers/data/secret-manager-secret";
import { ACCESS_TOKEN, FakeGoogle, fakeGoogle } from "./_fake-google";
import { PROJECT, REGION } from "./_fixtures";
import { ctxFor, labelsFor, node, readCases, type Json } from "./_reads";

const servers: FakeGoogle[] = [];
async function fake(): Promise<FakeGoogle> {
  const f = await fakeGoogle();
  servers.push(f);
  return f;
}
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

const cases = Object.fromEntries(readCases().map((c) => [c.name, c]));
const op = (nativeType: string, name: string) => gcpDrivers.find((d) => d.nativeType === nativeType)!.operations![name];
const svc = cases.cloud_run_service;
const SVC_PATH = `run.googleapis.com/v2/${svc.externalId}`;
const OP_NAME = `projects/${PROJECT}/locations/${REGION}/operations/op-uuid-1`;
const OP_PATH = `run.googleapis.com/v2/${OP_NAME}`;

async function serviceFake(over: { body?: Json; patch?: Json; operation?: Json; patchStatus?: number } = {}) {
  const f = await fake();
  f.get(SVC_PATH, { json: { ...svc.body, ...over.body } });
  f.on("PATCH", SVC_PATH, over.patchStatus ? { status: over.patchStatus, json: { error: { status: "ABORTED", message: "etag mismatch" } } } : { json: over.patch ?? { name: OP_NAME, done: false } });
  f.get(OP_PATH, { json: over.operation ?? { name: OP_NAME, done: true, response: {} } });
  return f;
}
const patches = (f: FakeGoogle) => f.requestsTo("PATCH", SVC_PATH);

describe("service.restart", () => {
  it("creates a new revision by stamping the restart annotation, preserving the rest of the template", async () => {
    const f = await serviceFake();
    const ctx = ctxFor(await f.session({ purpose: "deploy" }), { operationId: "op_restart_1", fence: { scope: "env:env_1", token: 42 } });
    const r = await op("gcp:cloud_run_service", "service.restart")(ctx, node("service/web"), { externalId: svc.externalId });
    expect(r).toMatchObject({ ok: true, simulated: false });
    expect(r.summary).toContain("new revision");
    expect(r.requestIds).toContain(OP_NAME);
    const [p] = patches(f);
    expect(p.query.get("updateMask")).toBe("template");
    const body = p.body as { template: Json; etag: string };
    expect(body.etag).toBe('"etag-1"');
    expect((body.template.annotations as Json)).toEqual({ "zenith.dev/restart-token": "op_restart_1", "zenith.dev/fence-token": "42" });
    // nothing else in the template was changed
    expect((body.template as Json).containers).toEqual((svc.body.template as Json).containers);
    expect((body.template as Json).scaling).toEqual((svc.body.template as Json).scaling);
    expect(JSON.stringify(r)).not.toContain(ACCESS_TOKEN);
  });

  it("is idempotent per operation id: replaying it does not restart again", async () => {
    const template = { ...(svc.body.template as Json), annotations: { "zenith.dev/restart-token": "op_restart_1" } };
    const f = await serviceFake({ body: { template } });
    const ctx = ctxFor(await f.session(), { operationId: "op_restart_1" });
    const r = await op("gcp:cloud_run_service", "service.restart")(ctx, node("service/web"), { externalId: svc.externalId });
    expect(r).toMatchObject({ ok: true });
    expect(r.summary).toContain("already");
    expect(patches(f)).toHaveLength(0);
    // a different operation id does restart
    const ctx2 = ctxFor(await f.session(), { operationId: "op_restart_2" });
    await op("gcp:cloud_run_service", "service.restart")(ctx2, node("service/web"), { externalId: svc.externalId });
    expect(patches(f)).toHaveLength(1);
  });

  it("finds the service by its labels when no externalId is given", async () => {
    const f = await serviceFake();
    f.get(svc.list!.path, { json: { services: [svc.decoy, svc.body] } });
    const ctx = ctxFor(await f.session(), { operationId: "op_restart_3" });
    const r = await op("gcp:cloud_run_service", "service.restart")(ctx, node("service/web"), {});
    expect(r.ok).toBe(true);
    expect(patches(f)).toHaveLength(1);
  });

  it.each([undefined, "", "has spaces", "x".repeat(200), "bad/slash"])("refuses operation id %j without touching the service", async (operationId) => {
    const f = await serviceFake();
    const ctx = ctxFor(await f.session(), { operationId });
    const r = await op("gcp:cloud_run_service", "service.restart")(ctx, node("service/web"), { externalId: svc.externalId });
    expect(r.ok).toBe(false);
    expect(f.requests.filter((q) => q.host === "run.googleapis.com")).toHaveLength(0);
  });

  it("refuses a service that does not carry this environment's labels", async () => {
    const f = await serviceFake({ body: { labels: { ...labelsFor("service/web"), zenith_environment: "env_other" } } });
    const ctx = ctxFor(await f.session(), { operationId: "op_x" });
    const r = await op("gcp:cloud_run_service", "service.restart")(ctx, node("service/web"), { externalId: svc.externalId });
    expect(r).toMatchObject({ ok: false });
    expect(r.summary).toContain("does not carry this environment's Zenith labels");
    expect(patches(f)).toHaveLength(0);
    // and one that belongs to another resource of the same environment
    const g = await serviceFake({ body: { labels: labelsFor("service/worker") } });
    const r2 = await op("gcp:cloud_run_service", "service.restart")(ctxFor(await g.session(), { operationId: "op_x" }), node("service/web"), { externalId: svc.externalId });
    expect(r2.ok).toBe(false);
    expect(patches(g)).toHaveLength(0);
  });

  it("refuses an externalId in another project", async () => {
    const f = await serviceFake();
    const r = await op("gcp:cloud_run_service", "service.restart")(ctxFor(await f.session(), { operationId: "op_x" }), node("service/web"), { externalId: svc.otherProjectId });
    expect(r.ok).toBe(false);
    expect(f.requests.filter((q) => q.host === "run.googleapis.com")).toHaveLength(0);
  });

  it("reports failures honestly: not found, denied, conflicting edit, failed rollout, still rolling out", async () => {
    const run = async (f: FakeGoogle, input: Json = { externalId: svc.externalId }) => op("gcp:cloud_run_service", "service.restart")(ctxFor(await f.session(), { operationId: "op_y" }), node("service/web"), input);

    const missing = await fake();
    missing.get(SVC_PATH, { status: 404, json: { error: { status: "NOT_FOUND" } } });
    expect(await run(missing)).toMatchObject({ ok: false });

    const denied = await fake();
    denied.get(SVC_PATH, { status: 403, json: { error: { status: "PERMISSION_DENIED" } } });
    expect((await run(denied)).summary).toContain("inaccessible");

    const conflict = await serviceFake({ patchStatus: 409 });
    const c = await run(conflict);
    expect(c.ok).toBe(false);
    expect(c.summary).toContain("concurrent modification");

    const failed = await serviceFake({ operation: { name: OP_NAME, done: true, error: { code: 9, message: "Revision failed: container exited" } } });
    const f = await run(failed);
    expect(f.ok).toBe(false);
    expect(f.summary).toContain("operation failed");

    const slow = await serviceFake({ operation: { name: OP_NAME, done: false } });
    const s = await run(slow, { externalId: svc.externalId, waitSeconds: 2 });
    expect(s).toMatchObject({ ok: true });
    expect(s.summary).toContain("still rolling out");

    const instant = await serviceFake({ patch: { name: OP_NAME, done: true } });
    expect(await run(instant)).toMatchObject({ ok: true });
    expect(instant.requestsTo("GET", OP_PATH)).toHaveLength(0);
  });

  it("stops when the signal has fired", async () => {
    const f = await serviceFake();
    const ac = new AbortController();
    const ctx = ctxFor(await f.session(), { operationId: "op_z", signal: ac.signal });
    ac.abort();
    await expect(op("gcp:cloud_run_service", "service.restart")(ctx, node("service/web"), { externalId: svc.externalId })).rejects.toBeDefined();
    expect(patches(f)).toHaveLength(0);
  });
});

describe("service.scale", () => {
  const scale = async (f: FakeGoogle, input: Json, operationId = "op_scale_1") =>
    op("gcp:cloud_run_service", "service.scale")(ctxFor(await f.session(), { operationId }), node("service/web"), { externalId: svc.externalId, ...input });

  it("changes min and keeps max; records the fence token", async () => {
    const f = await serviceFake();
    const ctx = ctxFor(await f.session(), { fence: { scope: "env:env_1", token: 7 } });
    const r = await op("gcp:cloud_run_service", "service.scale")(ctx, node("service/web"), { externalId: svc.externalId, minInstances: 5 });
    expect(r).toMatchObject({ ok: true });
    expect(r.summary).toContain("min 5 / max 10");
    const tpl = (patches(f)[0].body as { template: Json }).template;
    expect(tpl.scaling).toEqual({ minInstanceCount: 5, maxInstanceCount: 10 });
    expect((tpl.annotations as Json)["zenith.dev/fence-token"]).toBe("7");
  });

  it("can change both, and is a no-op when nothing would change", async () => {
    const f = await serviceFake();
    const r = await scale(f, { minInstances: 1, maxInstances: 20 });
    expect(r.ok).toBe(true);
    expect((patches(f)[0].body as { template: Json }).template.scaling).toEqual({ minInstanceCount: 1, maxInstanceCount: 20 });
    const g = await serviceFake();
    const same = await scale(g, { minInstances: 2, maxInstances: 10 });
    expect(same).toMatchObject({ ok: true });
    expect(same.summary).toContain("nothing to do");
    expect(patches(g)).toHaveLength(0);
  });

  it("refuses min above max, non-integers, negatives, out-of-range and empty requests", async () => {
    const f = await serviceFake();
    for (const input of [{ minInstances: 11 }, { minInstances: 5, maxInstances: 3 }, { minInstances: -1 }, { minInstances: 1.5 }, { maxInstances: 1001 }, { minInstances: "3" }, {}]) {
      const r = await scale(f, input);
      expect(r.ok, JSON.stringify(input)).toBe(false);
    }
    expect(patches(f)).toHaveLength(0);
  });

  it("refuses foreign services like restart does", async () => {
    const f = await serviceFake({ body: { labels: { zenith_environment: "env_other", zenith_resource: "service_web" } } });
    expect((await scale(f, { minInstances: 3 })).ok).toBe(false);
    expect(patches(f)).toHaveLength(0);
  });
});

describe("database.snapshot", () => {
  const sql = cases.cloud_sql_instance;
  const backupsPath = `sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/zn-env1-db-pg/backupRuns`;
  const snapshot = op("gcp:cloud_sql_instance", "database.snapshot");

  async function sqlFake(list: Json | { status: number } = { items: [] }) {
    const f = await fake();
    f.get(sql.get, { json: sql.body });
    f.get(backupsPath, "status" in list ? { status: list.status as number, json: { error: { status: "PERMISSION_DENIED" } } } : { json: list });
    f.on("POST", backupsPath, { json: { name: `projects/${PROJECT}/operations/op-1`, status: "PENDING" } });
    return f;
  }

  it("starts an on-demand backup tagged with the operation id", async () => {
    const f = await sqlFake();
    const r = await snapshot(ctxFor(await f.session(), { operationId: "op_snap_1" }), node("resource/db"), { externalId: sql.externalId });
    expect(r).toMatchObject({ ok: true, data: { instance: "zn-env1-db-pg", changed: true } });
    expect(f.requestsTo("POST", backupsPath)[0].body).toEqual({ description: "zenith:op_snap_1" });
  });

  it("is idempotent: an existing backup for the operation is reported, not duplicated", async () => {
    const f = await sqlFake({ items: [{ id: "99", status: "SUCCESSFUL", description: "zenith:op_snap_1" }] });
    const r = await snapshot(ctxFor(await f.session(), { operationId: "op_snap_1" }), node("resource/db"), { externalId: sql.externalId });
    expect(r).toMatchObject({ ok: true, data: { backupId: "99", changed: false } });
    expect(f.requestsTo("POST", backupsPath)).toHaveLength(0);
  });

  it("does not guess when it cannot check for an earlier backup, and refuses foreign instances and missing operation ids", async () => {
    const f = await sqlFake({ status: 403 });
    const denied = await snapshot(ctxFor(await f.session(), { operationId: "op_snap_2" }), node("resource/db"), { externalId: sql.externalId });
    expect(denied.ok).toBe(false);
    expect(f.requestsTo("POST", backupsPath)).toHaveLength(0);

    const g = await sqlFake();
    expect((await snapshot(ctxFor(await g.session(), { operationId: "" }), node("resource/db"), { externalId: sql.externalId })).ok).toBe(false);
    const h = await fake();
    h.get(sql.get, { json: { ...sql.body, settings: { userLabels: { zenith_environment: "env_other", zenith_resource: "resource_db" } } } });
    const foreign = await snapshot(ctxFor(await h.session(), { operationId: "op_snap_3" }), node("resource/db"), { externalId: sql.externalId });
    expect(foreign.ok).toBe(false);
    expect(h.requestsTo("POST", backupsPath)).toHaveLength(0);
  });
});

describe("syncSecretValue", () => {
  const sm = cases.secret_manager_secret;
  const base = `secretmanager.googleapis.com/v1/${sm.externalId}`;
  const VALUE = "s3cr3t-CANARY-value-that-must-never-leak";

  async function secretFake(body: Json = sm.body) {
    const f = await fake();
    f.get(base, { json: body });
    f.on("POST", `${base}:addVersion`, { json: { name: `${sm.externalId}/versions/4`, state: "ENABLED" } });
    f.on("PATCH", base, { json: body });
    return f;
  }
  const run = async (f: FakeGoogle, getValue: () => Promise<string | Uint8Array>, operationId: string | undefined = "op_sync_1") =>
    syncSecretValue(ctxFor(await f.session({ purpose: "deploy" }), { operationId }), node("secret/api-key"), { externalId: sm.externalId, getValue });

  it("adds a version with an integrity checksum and records the operation, returning only a reference", async () => {
    const f = await secretFake();
    const r = await run(f, async () => VALUE);
    expect(r).toMatchObject({ ok: true, changed: true, version: `${sm.externalId}/versions/4` });
    const add = f.requestsTo("POST", `${base}:addVersion`)[0];
    expect(add.body).toEqual({ payload: { data: Buffer.from(VALUE).toString("base64"), dataCrc32c: String(crc32c(Buffer.from(VALUE))) } });
    const mark = f.requestsTo("PATCH", base)[0];
    expect(mark.query.get("updateMask")).toBe("annotations");
    expect((mark.body as { annotations: Json }).annotations[SYNC_ANNOTATION]).toBe("op_sync_1");
    // the value appears nowhere except the addVersion payload
    expect(JSON.stringify(r)).not.toContain(VALUE);
    for (const q of f.requests.filter((x) => x.path !== `/v1/${sm.externalId}:addVersion`)) {
      expect(q.rawBody + q.path + q.query.toString()).not.toContain(VALUE);
      expect(q.rawBody).not.toContain(Buffer.from(VALUE).toString("base64"));
    }
    expect(f.requests.some((q) => q.path.endsWith(":access"))).toBe(false);
  });

  it("is idempotent per operation id and never resolves the value on a replay", async () => {
    const f = await secretFake({ ...sm.body, annotations: { [SYNC_ANNOTATION]: "op_sync_1" } });
    let resolved = false;
    const r = await run(f, async () => {
      resolved = true;
      return VALUE;
    });
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(resolved).toBe(false);
    expect(f.requestsTo("POST", `${base}:addVersion`)).toHaveLength(0);
  });

  it("does not propagate value text from a failing resolver or a failing API", async () => {
    const f = await secretFake();
    const a = await run(f, async () => Promise.reject(new Error(`vault error for ${VALUE}`)));
    expect(a.ok).toBe(false);
    expect(JSON.stringify(a)).not.toContain(VALUE);
    expect(f.requestsTo("POST", `${base}:addVersion`)).toHaveLength(0);

    const g = await fake();
    g.get(base, { json: sm.body });
    g.on("POST", `${base}:addVersion`, { status: 400, json: { error: { status: "INVALID_ARGUMENT", message: `payload ${VALUE} rejected` } } });
    const b = await run(g, async () => VALUE, "op_sync_2");
    expect(b.ok).toBe(false);
    expect(b.changed).toBe(false);
    // the API's own message is scrubbed of nothing it should not have, and the value is not echoed by us
    expect(b.summary).not.toContain("Bearer");
  });

  it("refuses empty and oversized values, zeroes the caller's buffer, and refuses foreign secrets and missing operation ids", async () => {
    const f = await secretFake();
    expect((await run(f, async () => "")).ok).toBe(false);
    expect((await run(f, async () => "x".repeat(65537))).ok).toBe(false);
    const buf = new Uint8Array(Buffer.from(VALUE));
    const ok = await run(f, async () => buf, "op_sync_3");
    expect(ok.ok).toBe(true);
    expect([...buf].every((b) => b === 0)).toBe(true);
    expect((await run(f, async () => VALUE, "")).ok).toBe(false);
    const g = await secretFake({ ...sm.body, labels: { ...labelsFor("secret/api-key"), zenith_environment: "env_other" } });
    const foreign = await run(g, async () => VALUE, "op_sync_4");
    expect(foreign.ok).toBe(false);
    expect(g.requestsTo("POST", `${base}:addVersion`)).toHaveLength(0);
  });

  it("reports a failed operation marker without pretending nothing happened", async () => {
    const f = await fake();
    f.get(base, { json: sm.body });
    f.on("POST", `${base}:addVersion`, { json: { name: `${sm.externalId}/versions/5` } });
    f.on("PATCH", base, { status: 500, json: {} });
    const r = await run(f, async () => VALUE, "op_sync_5");
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(r.summary).toContain("may add another identical version");
  });

  it("computes CRC32C per the Castagnoli test vector", () => {
    expect(crc32c(Buffer.from("123456789"))).toBe(0xe3069283);
    expect(crc32c(Buffer.alloc(0))).toBe(0);
  });
});

describe("build helpers (ADR-0016)", () => {
  const sa = `zn-env1-pipeline-bld@${PROJECT}.iam.gserviceaccount.com`;
  const image = `${REGION}-docker.pkg.dev/${PROJECT}/zn-env1-registry/web:build-1`;
  const input: StartBuildInput = { sourceBucket: "zn-env1-pipeline-src-eb1f16", sourceObject: "bundles/ws_1/env_1/abc123.tar.gz", imageRef: image, buildServiceAccount: sa };
  const buildsPath = `cloudbuild.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/builds`;
  const BUILD_ID = "3f2b8c1e-0000-4000-8000-000000000001";

  async function buildFake(list: Json | { status: number } = { builds: [] }) {
    const f = await fake();
    f.get(buildsPath, "status" in list ? { status: list.status as number, json: {} } : { json: list });
    f.on("POST", buildsPath, { json: { name: `projects/${PROJECT}/locations/${REGION}/operations/o1`, metadata: { build: { id: BUILD_ID, status: "QUEUED" } } } });
    return f;
  }
  const start = async (f: FakeGoogle, i: Partial<StartBuildInput> = {}, operationId: string | undefined = "op_build_1") => startBuild(ctxFor(await f.session({ purpose: "deploy" }), { operationId }), { ...input, ...i });

  it("starts a build from a storage source under the pipeline's service account, argv only", async () => {
    const f = await buildFake();
    const r = await start(f, { dockerfile: "docker/Dockerfile.prod" });
    expect(r).toMatchObject({ ok: true, buildId: BUILD_ID });
    const body = f.requestsTo("POST", buildsPath)[0].body as Json;
    expect(body.source).toEqual({ storageSource: { bucket: input.sourceBucket, object: input.sourceObject } });
    expect(body.steps).toEqual([{ name: "gcr.io/cloud-builders/docker", args: ["build", "--file=docker/Dockerfile.prod", `--tag=${image}`, "."] }]);
    expect(body.images).toEqual([image]);
    expect(body.serviceAccount).toBe(`projects/${PROJECT}/serviceAccounts/${sa}`);
    expect(body.options).toEqual({ logging: "CLOUD_LOGGING_ONLY" });
    expect((body.tags as string[])[0]).toBe("zenith");
    expect((body.tags as string[])[1]).toMatch(/^zenith-op-[0-9a-f]{12}$/);
    // the list lookup used the same tag
    const q = f.requestsTo("GET", buildsPath)[0].query.get("filter");
    expect(q).toBe(`tags="${(body.tags as string[])[1]}"`);
  });

  it("returns the existing build for a replayed operation", async () => {
    const f = await buildFake({ builds: [{ id: BUILD_ID, status: "WORKING" }] });
    const r = await start(f);
    expect(r).toMatchObject({ ok: true, reused: true, buildId: BUILD_ID });
    expect(f.requestsTo("POST", buildsPath)).toHaveLength(0);
  });

  it("does not start a build when it cannot check whether one already exists", async () => {
    const f = await buildFake({ status: 403 });
    expect((await start(f)).ok).toBe(false);
    expect(f.requestsTo("POST", buildsPath)).toHaveLength(0);
  });

  it("validates every input before any request", async () => {
    const f = await buildFake();
    const bad: Partial<StartBuildInput>[] = [
      { sourceBucket: "BAD BUCKET" },
      { sourceObject: "../../etc/passwd" },
      { sourceObject: "a/./b" },
      { sourceObject: "/absolute" },
      { sourceGeneration: "12x" },
      { imageRef: "evil.example.com/x/y:z" },
      { imageRef: `${REGION}-docker.pkg.dev/other-project-99999/r/i:t` },
      { imageRef: `${image} --privileged` },
      { buildServiceAccount: "attacker@evil.example.com" },
      { dockerfile: "../Dockerfile" },
      { dockerfile: "-f/etc/shadow" },
      { dockerfile: "/etc/passwd" },
      { dockerfile: "a b" },
      { timeoutSeconds: 5 },
      { timeoutSeconds: 99999 },
    ];
    for (const b of bad) expect((await start(f, b)).ok, JSON.stringify(b)).toBe(false);
    expect((await start(f, {}, "")).ok).toBe(false);
    expect(f.requests.filter((r) => r.host === "cloudbuild.googleapis.com")).toHaveLength(0);
    expect(validateBuildInput(PROJECT, input)).toBeUndefined();
  });

  it("getBuild reports status and only well-formed image digests", async () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const f = await fake();
    f.get(`${buildsPath}/${BUILD_ID}`, { json: { id: BUILD_ID, status: "SUCCESS", results: { images: [{ name: image, digest }, { name: image, digest: "sha256:short" }, { name: "", digest }] }, logUrl: "https://console.example/log" } });
    const s = await getBuild(ctxFor(await f.session()), BUILD_ID);
    expect(s).toMatchObject({ status: "SUCCESS", done: true, success: true, outcome: "ok", images: [{ name: image, digest }] });
    expect(JSON.stringify(s)).not.toContain("logUrl");

    const g = await fake();
    g.get(`${buildsPath}/${BUILD_ID}`, { json: { id: BUILD_ID, status: "WORKING" } });
    expect(await getBuild(ctxFor(await g.session()), BUILD_ID)).toMatchObject({ status: "WORKING", done: false, success: false, images: [] });
    const h = await fake();
    h.get(`${buildsPath}/${BUILD_ID}`, { json: { id: BUILD_ID, status: "FAILURE" } });
    expect(await getBuild(ctxFor(await h.session()), BUILD_ID)).toMatchObject({ status: "FAILURE", done: true, success: false });
    const i = await fake();
    i.get(`${buildsPath}/${BUILD_ID}`, { json: { status: "SOMETHING_NEW" } });
    expect((await getBuild(ctxFor(await i.session()), BUILD_ID)).status).toBe("STATUS_UNKNOWN");
    expect((await getBuild(ctxFor(await i.session()), "../../x")).outcome).toBe("error");
    const j = await fake();
    expect((await getBuild(ctxFor(await j.session()), BUILD_ID)).outcome).toBe("missing");
  });
});
