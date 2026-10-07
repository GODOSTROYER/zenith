/** Real in-memory PGlite SQL evidence, not a production Postgres/cloud run. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPlatformDb, repos } from "@/lib/controlplane/db";
import { digest } from "@/lib/controlplane/digest";
import { createAzureReleaseLaunchJournal } from "@/lib/platform/release-azure";
import { createReleasePorts } from "@/lib/platform/release";
import type { LaunchScope } from "@/lib/providers/azure/release/support";
import { ROOT, world, service, pipeline, registry, bundle, IMAGE, DIGEST, registryId } from "./release-fixtures";

let db: Awaited<ReturnType<typeof openPlatformDb>>;
beforeAll(async () => { db = await openPlatformDb({ kind: "pglite" }); });
afterAll(async () => { await db?.close(); });
const scope = (name: string): LaunchScope => ({ workspaceId: "ws-1", environmentId: "env-1", key: digest(name) });
const expectedBuild = {
  status: "succeeded", imageUri: IMAGE, digest: DIGEST,
  attestation: {
    builderId: registryId,
    invocationId: "run1",
    isolation: {
      profileId: "azure.acr-tasks.v1",
      identity: { principal: "acr-tasks-run", dedicated: true, deployCredentials: "absent" },
      metadata: { exposes: "build_identity_only", mechanism: "the run exposes no user-assigned identity; the task agent has no access to deploy credentials" },
      network: { egress: "unrestricted", mechanism: "ACR Tasks shared agents have public egress; configure spec.isolation.workerPool" },
      dependencies: { downloads: "direct" },
      filesystem: { sourceMount: "read_only" },
      resources: { timeoutSec: 1800, computeClass: "cpu-2" },
    },
  },
};

const reference = `${ROOT}/Microsoft.App/jobs/zn-migrate-abc/executions/zn-execution-1`;

/** Shared release composition records build effects against a real operation. */
async function buildWorld() {
  const w = world();
  const { operation } = await repos.operations.create(db, {
    workspaceId: w.ctx.workspaceId,
    principal: { kind: "user", id: "journal-test" },
    proposal: {
      capability: "service.release",
      scope: { workspaceId: w.ctx.workspaceId, environmentId: w.ctx.environmentId },
      input: { service: service.address }, summary: "Build the journal fixture", details: [], risk: "medium",
    },
  });
  w.ctx.operationId = operation.id;
  return w;
}

describe("Azure durable launch journal", () => {
  it("composes the real SQL journal by default and recovers a migration on a replacement worker", async () => {
    const w = world(); const command = ["node", "migrate.js"]; const opts = { idempotencyKey: "default-journal:migrate", timeoutMs: 1000 };
    expect(await createReleasePorts({ db }).migrations.runOneOffTask(w.ctx, service, command, opts)).toEqual({ exitCode: 0 });
    expect(await createReleasePorts({ db }).migrations.runOneOffTask(w.ctx, service, command, opts)).toEqual({ exitCode: 0 });
    expect(w.state.starts).toBe(1); expect(w.receipts.claims.size).toBe(0);
  });
  it("persists an ACR build receipt through the production journal and recovers it", async () => {
    const w = await buildWorld(); const options = { db, azure: { readSource: w.readSource, uploadFetch: w.uploadFetch } };
    const input = { service, pipeline, registry, source: bundle, idempotencyKey: "default-journal:build" };
    const handle = await createReleasePorts(options).build.startBuild(w.ctx, input);
    expect(await createReleasePorts(options).build.startBuild(w.ctx, input)).toEqual(handle);
    expect(await createReleasePorts({ db }).build.waitForBuild(w.ctx, handle, { timeoutMs: 1000 })).toEqual(expectedBuild);
    expect(w.state.schedules).toBe(1);
  });
  it("atomically gives one of 12 concurrent workers the permanent launch claim", async () => {
    const result = await Promise.all(Array.from({ length: 12 }, () => createAzureReleaseLaunchJournal(db).claim(scope("race"))));
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(await createAzureReleaseLaunchJournal(db).claim(scope("race"))).toBe(false);
  });
  it("keeps a claim consumed with no receipt after a crash", async () => {
    const s = scope("crash"); expect(await createAzureReleaseLaunchJournal(db).claim(s)).toBe(true);
    expect(await createAzureReleaseLaunchJournal(db).read(s)).toBeUndefined();
    expect(await createAzureReleaseLaunchJournal(db).claim(s)).toBe(false);
  });
  it("scopes the same key independently to workspace and environment", async () => {
    const s = scope("tenant"); const foreign = { ...s, workspaceId: "ws-2" }; const environment = { ...s, environmentId: "env-2" };
    const j = createAzureReleaseLaunchJournal(db);
    expect(await j.claim(s)).toBe(true); await j.record(s, reference);
    expect(await j.read(foreign)).toBeUndefined(); expect(await j.read(environment)).toBeUndefined();
    expect(await j.claim(foreign)).toBe(true); expect(await j.claim(environment)).toBe(true);
    expect(await j.read(s)).toBe(reference);
  });
  it("permits receipt replay but prevents overwriting with a different execution", async () => {
    const s = scope("receipt"); const j = createAzureReleaseLaunchJournal(db); await j.claim(s);
    await j.record(s, reference); await createAzureReleaseLaunchJournal(db).record(s, reference);
    await expect(j.record(s, reference.replace("zn-execution-1", "zn-execution-2"))).rejects.toThrow("consistently");
    expect(await j.read(s)).toBe(reference);
  });
  it("never expires through the existing API idempotency pruning path", async () => {
    const s = scope("permanent"); const j = createAzureReleaseLaunchJournal(db); await j.claim(s);
    expect(await repos.idempotency.prune(db)).toBe(0);
    const rows = await db.query<{ permanent: boolean }>("select expires_at = 'infinity'::timestamptz as permanent from platform.idempotency_keys where workspace_id = $1", [s.workspaceId]);
    expect(rows.every((r) => r.permanent)).toBe(true); expect(await j.claim(s)).toBe(false);
  });
  it("rejects SAS/credentials and unexpected build receipt fields without persisting them", async () => {
    const s = scope("secret"); const j = createAzureReleaseLaunchJournal(db); await j.claim(s);
    for (const bad of ["https://blob.example/source?sig=opaque-secret", `${reference}?token=opaque-secret`, JSON.stringify({ session: "opaque-secret" }), JSON.stringify({ version: 1, scope: digest("secret"), registryId: "opaque-secret" })]) await expect(j.record(s, bad)).rejects.toThrow("reference");
    expect(await j.read(s)).toBeUndefined();
  });
  it("persists documented UUID ACR run receipts and rejects non-object receipt JSON", async () => {
    const w = await buildWorld(); const handle = await createReleasePorts({ db, azure: w.options }).build.startBuild(w.ctx, { service, pipeline, registry, source: bundle, idempotencyKey: "uuid-receipt" });
    const receipt = JSON.stringify({ ...JSON.parse(handle.buildId), runId: "0accec26-d6de-4757-8e74-d080f38eaaab" });
    const s = scope("uuid-receipt"); const j = createAzureReleaseLaunchJournal(db); await j.claim(s);
    await j.record(s, receipt); expect(await j.read(s)).toBe(receipt);
    for (const invalid of ["null", "[]", "42"]) await expect(j.record(s, invalid)).rejects.toThrow("reference");
    expect(await j.read(s)).toBe(receipt);
  });
  it("refuses unclaimed receipts and invalid tenant/key scope", async () => {
    const j = createAzureReleaseLaunchJournal(db);
    await expect(j.record(scope("unclaimed"), reference)).rejects.toThrow("persisted");
    await expect(j.claim({ ...scope("bad"), key: "raw-key" })).rejects.toThrow("scope");
    await expect(j.read({ ...scope("bad"), workspaceId: "../ws" })).rejects.toThrow("scope");
  });
});
