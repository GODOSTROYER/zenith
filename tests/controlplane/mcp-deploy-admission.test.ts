/** Owning PostgreSQL broker/intents and persisted projections; product REST/readiness are explicit protocol models. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db/types";
import type { Deployment } from "@/lib/domain/types";
import { Manifest } from "@/lib/domain/types";
import { requestSnapshot } from "@/lib/db/request-snapshot";
import { digest } from "@/lib/controlplane/digest";
import { json, openPlatformDb, assertPlatformSchemaCurrent, type PlatformDbHandle } from "@/lib/controlplane/db";
import { platformBroker, registerPlatformBrokerPorts, registerPlatformBrokerStore, resetPlatformBrokerForTests } from "@/lib/capabilities/platform";
import type { Principal, Sql } from "@/lib/controlplane/types";
import type { DeployAdmissionRequest } from "@/lib/agent-access/v3/ports";
import { deployAdmissionPort } from "@/lib/agent-access/v3/deploy-admission";
import { createIsolatedStartIntentStoreForTests, get as getIntent, type StartRequest } from "@/lib/controlplane/db/repos/workflow-start-intents";
import { closeSharedPgliteAfterAll, makeHarness, PG_URL, scriptedEngine, allowDecision, type Harness } from "../capabilities/support";
import * as nativeConnections from "@/lib/controlplane/db/repos/connections";

interface Snapshot { data: Database; versions: Map<string, number>; original: Map<string, string>; dirty: boolean }
const model = vi.hoisted(() => ({ load: vi.fn(), prime: vi.fn(), client: vi.fn(), flush: vi.fn(), route: vi.fn() }));
vi.mock("@/lib/db/store", async () => {
  const { requestSnapshot } = await import("@/lib/db/request-snapshot");
  const current = () => requestSnapshot() as Snapshot;
  return { isPostgres: () => true, db: () => current().data, save: () => { current().dirty = true; }, flushPendingAsync: model.flush,
    q: { project: (id: string) => current().data.projects.find(row => row.id === id),
      environment: (id: string) => current().data.environments.find(row => row.id === id),
      revision: (id: string) => current().data.revisions.find(row => row.id === id),
      deployment: (id: string) => current().data.deployments.find(row => row.id === id),
      connection: (id: string) => current().data.connections.find(row => row.id === id) }, revisionManifestAsync: async () => undefined };
});
vi.mock("@/lib/db/postgres-store", () => ({ loadSnapshot: model.load, primeProcessSnapshot: model.prime, pgClient: model.client }));
vi.mock("@/lib/bridge/deploy", () => ({ executionRoute: model.route }));

if (process.env.ZENITH_TEST_MCP_DEPLOY_ADMISSION_REQUIRED === "1" && !PG_URL) throw new Error("MCP deployment admission requires an explicitly owned PostgreSQL database.");
closeSharedPgliteAfterAll();
type Fixture = { h: Harness; observer: PlatformDbHandle; schema: string; request: DeployAdmissionRequest;
  readGraph(): Promise<Database>; writeGraph(graph: Database): Promise<void>; projections(): Promise<Deployment[]>;
  commitLoss: "none" | "before" | "after"; manifestReply: "owning" | "foreign" | "missing" | "malformed"; port: ReturnType<typeof deployAdmissionPort> };
let active: Fixture | undefined;
const table = (f: Fixture, name: string) => `"${f.schema}"."${name}"`;
function current(): Fixture { if (!active) throw new Error("The modeled product protocol has no owning fixture."); return active; }
function snapshot(): Snapshot { const value = requestSnapshot(); if (!value) throw new Error("No modeled product snapshot."); return value as Snapshot; }
// The REST protocol remains modeled. Final admission uses the exact committed
// public collection table definitions and native rows, never a shadow selector.
async function nativeProductSchema(db: PlatformDbHandle): Promise<void> {
  const migration = readFileSync(new URL("../../supabase/migrations/0001_system_of_record.sql", import.meta.url), "utf8");
  for (const name of ["members", "connections", "projects", "environments", "revisions", "revision_manifests", "deployments"]) {
    const ddl = new RegExp(`create table if not exists public\\.${name} \\([\\s\\S]*?\\n\\);`).exec(migration)?.[0];
    if (!ddl) throw new Error("Native product table contract is missing.");
    await db.exec(ddl);
  }
}
async function nativeGraph(db: PlatformDbHandle, graph: Database, workspaceId: string): Promise<void> {
  for (const row of graph.members.filter(member => member.workspaceId === workspaceId)) await db.query(`insert into public.members(id,workspace_id,email,role,data) values($1,$2,$3,$4,$5::text::jsonb)
    on conflict(workspace_id,id) do update set email=excluded.email,role=excluded.role,data=excluded.data,version=public.members.version+1`, [row.id, workspaceId, row.email, row.role, json(serializedData(row, ["id", "workspaceId", "email", "role"]))]);
  for (const row of graph.projects) await db.query(`insert into public.projects(id,workspace_id,slug,name,data) values($1,$2,$3,$4,$5::text::jsonb)
    on conflict(id) do update set data=excluded.data,version=public.projects.version+1 where public.projects.workspace_id=excluded.workspace_id`, [row.id, workspaceId, row.slug, row.name, json(serializedData(row, ["id", "workspaceId", "slug", "name", "createdAt"]))]);
  for (const row of graph.connections) await db.query(`insert into public.connections(id,workspace_id,provider,status,data) values($1,$2,$3,$4,$5::text::jsonb)
    on conflict(id) do update set provider=excluded.provider,status=excluded.status,data=excluded.data,version=public.connections.version+1 where public.connections.workspace_id=excluded.workspace_id`, [row.id, workspaceId, row.provider, row.status, json(serializedData(row, ["id", "workspaceId", "provider", "status", "createdAt"]))]);
  for (const row of graph.environments) await db.query(`insert into public.environments(id,workspace_id,project_id,class,connection_id,data) values($1,$2,$3,$4,$5,$6::text::jsonb)
    on conflict(id) do update set project_id=excluded.project_id,class=excluded.class,connection_id=excluded.connection_id,data=excluded.data,version=public.environments.version+1 where public.environments.workspace_id=excluded.workspace_id`, [row.id, workspaceId, row.projectId, row.class, row.connectionId, json(serializedData(row, ["id", "projectId", "class", "connectionId", "deployedRevisionId", "activeDeploymentId", "createdAt"]))]);
  for (const row of graph.revisions) await db.query(`insert into public.revisions(id,workspace_id,project_id,number,data) values($1,$2,$3,$4,$5::text::jsonb)
    on conflict(id) do update set project_id=excluded.project_id,number=excluded.number,data=excluded.data,version=public.revisions.version+1 where public.revisions.workspace_id=excluded.workspace_id`, [row.id, workspaceId, row.projectId, row.number, json(serializedData(row, ["id", "projectId", "number", "createdAt", "manifest"]))]);
}
function serializedData(row: object, promoted: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !promoted.includes(key)));
}
async function nativeProjection(db: Sql, row: Deployment, workspaceId: string): Promise<void> {
  await db.query(`insert into public.deployments(id,workspace_id,project_id,environment_id,revision_id,status,data) values($1,$2,$3,$4,$5,$6,$7::text::jsonb)
    on conflict(id) do update set data=excluded.data,status=excluded.status,version=public.deployments.version+1 where public.deployments.workspace_id=excluded.workspace_id`, [row.id, workspaceId, row.projectId, row.environmentId, row.revisionId, row.status, json(serializedData(row, ["id", "projectId", "environmentId", "revisionId", "status", "createdAt", "endedAt"]))]);
}
beforeEach(() => {
  vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY", ""); resetPlatformBrokerForTests(); vi.clearAllMocks();
  model.load.mockImplementation(async () => {
    const f = current(), data = await f.readGraph();
    const rows = await f.h.db!.query<{ id: string; document: Deployment; version: number }>(`select id,document,version from ${table(f, "deployments")} where workspace_id=$1`, [f.h.ids.wsA]);
    data.deployments = rows.map(row => row.document);
    return { data, versions: new Map(rows.map(row => [row.id, row.version])), original: new Map(rows.map(row => [row.id, digest(row.document)])), dirty: false } satisfies Snapshot;
  });
  // The real workerStoreScope primes and binds its own unfiltered snapshot.
  // This modeled REST boundary uses the same owning persisted graph/projection
  // loader as requests; it never replaces the worker scope or approval checks.
  model.prime.mockImplementation(async (user: null) => {
    expect(user).toBeNull();
    return model.load();
  });
  model.route.mockImplementation(async (environment: Database["environments"][number]) => {
    const connection = snapshot().data.connections.find(row => row.id === environment.connectionId);
    return connection?.workspaceId === current().h.ids.wsA && connection.platformConnectionId
      ? { kind: "workflow", provider: "aws", connection, readiness: { provider: "aws", ready: true, checks: [], checkedAt: new Date().toISOString() } }
      : { kind: "unlinked" };
  });
  model.client.mockImplementation(() => ({ from: (name: string) => {
    expect(name).toBe("revision_manifests");
    const filters = new Map<string, string>(); let signal: AbortSignal | undefined;
    const query = { select: (columns: string) => { expect(columns).toBe("revision_id,workspace_id,manifest"); return query; },
      eq: (field: string, value: string) => { filters.set(field, value); return query; },
      abortSignal: (value: AbortSignal) => { signal = value; return query; }, maybeSingle: async () => {
        const f = current(); expect(signal).toBeInstanceOf(AbortSignal);
        expect(filters.get("workspace_id")).toBe(f.request.target.workspaceId);
        const rows = await f.h.db!.query<{ revision_id: string; workspace_id: string; manifest: unknown }>(
          `select revision_id,workspace_id,manifest from ${table(f, "manifests")} where revision_id=$1 and workspace_id=$2`, [filters.get("revision_id")!, filters.get("workspace_id")!]);
        if (f.manifestReply === "missing") return { data: null, error: null };
        const row = rows[0]; return { data: row ? { ...row, ...(f.manifestReply === "foreign" ? { workspace_id: f.h.ids.wsB } : {}),
          ...(f.manifestReply === "malformed" ? { manifest: { version: 99 } } : {}) } : null, error: null };
      } }; return query;
  } }));
  model.flush.mockImplementation(async () => {
    const f = current(), view = snapshot();
    if (!view.dirty) return false;
    await f.h.db!.tx(async tx => {
      for (const row of view.data.deployments) {
        if (view.original.get(row.id) === digest(row)) continue;
        const version = view.versions.get(row.id);
        if (version === undefined) await tx.query(`insert into ${table(f, "deployments")} (id,workspace_id,document,version) values ($1,$2,$3::text::jsonb,1)`, [row.id, f.h.ids.wsA, json(row)]);
        else {
          const changed = await tx.query(`update ${table(f, "deployments")} set document=$3::text::jsonb,version=version+1 where id=$1 and workspace_id=$2 and version=$4 returning id`, [row.id, f.h.ids.wsA, json(row), version]);
          if (changed.length !== 1) throw new Error("Modeled product optimistic conflict");
        }
        await nativeProjection(tx, row, f.h.ids.wsA);
      }
      if (f.commitLoss === "before") { f.commitLoss = "none"; throw new Error("Modeled precommit interruption"); }
    });
    if (f.commitLoss === "after") { f.commitLoss = "none"; throw new Error("Modeled postcommit ACK loss"); }
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetPlatformBrokerForTests();
  const f = active; active = undefined;
  if (!f) return;
  await f.h.db!.exec(`drop schema "${f.schema}" cascade`); await f.observer.close();
  // Platform rows use a unique harness tenant and retained tombstones are kept
  // for the root-owned database lifetime; this fixture creates no provider work.
});

async function fixture(): Promise<Fixture> {
  const h = await makeHarness({ kind: "postgres", engine: scriptedEngine("mcp-admission-model-policy", () => allowDecision()) });
  await assertPlatformSchemaCurrent(h.db!);
  await nativeProductSchema(h.db!);
  const observer = await openPlatformDb({ kind: "postgres", url: PG_URL!, max: 1, migrate: false });
  const schema = `mcp_admission_${randomUUID().replaceAll("-", "")}`;
  await h.db!.exec(`create schema "${schema}"; create table "${schema}".graph (workspace_id text primary key, document jsonb not null);
    create table "${schema}".deployments (id text primary key, workspace_id text not null, document jsonb not null, version integer not null);
    create table "${schema}".manifests (revision_id text primary key, workspace_id text not null, manifest jsonb not null);`);
  const at = new Date().toISOString(), revisionId = `revision_${randomUUID()}`, connectionId = `connection_${randomUUID()}`, platformConnectionId = `conn_${randomUUID()}`;
  await nativeConnections.create(h.db!, { id: platformConnectionId, workspaceId: h.ids.wsA, createdBy: "bob",
    config: { provider: "aws", mode: "aws_assume_role", accountId: "123456789012", region: "us-east-1", externalId: "modeled-native-admission",
      observeRoleArn: "arn:aws:iam::123456789012:role/zenith_observe_fixture", deployRoleArn: "arn:aws:iam::123456789012:role/zenith_deploy_fixture" } });
  await nativeConnections.recordVerification(h.db!, { workspaceId: h.ids.wsA, id: platformConnectionId, ok: true });
  const manifest = Manifest.parse({ version: 1, services: [{ id: "web", name: "web", kind: "web", source: { type: "image", image: "example/web:v1" }, port: 3000 }], resources: [], routes: [], bindings: [] });
  const graph: Database = { workspaces: [{ id: h.ids.wsA, name: "Owning", slug: "owning", createdAt: at }],
    members: [{ id: "bob", workspaceId: h.ids.wsA, role: "editor", name: "Bob", email: "bob@example.test" }],
    projects: [{ id: h.ids.projA, workspaceId: h.ids.wsA, name: "Owning", slug: "owning", createdAt: at, origin: { type: "blank" }, workingManifest: manifest }],
    environments: [{ id: h.ids.envAProd, projectId: h.ids.projA, name: "production", class: "production", connectionId,
      region: "us-east-1", baseDomain: "owning.example.test", policies: { approvalRequired: false, allowStatefulDeletion: false }, createdAt: at }],
    connections: [{ id: connectionId, workspaceId: h.ids.wsA, provider: "aws", label: "AWS", region: "us-east-1", status: "healthy",
      grantedPermissions: [], platformConnectionId, createdAt: at }],
    revisions: [{ id: revisionId, projectId: h.ids.projA, number: 1, message: "saved", author: { type: "user", id: "bob", name: "Bob" }, manifest, createdAt: at }],
    deployments: [], findings: [], navigatorRuns: [], alertRules: [], alertEvents: [], alertOutbox: [], settings: {} };
  const f: Fixture = { h, observer, schema, commitLoss: "none", manifestReply: "owning", port: deployAdmissionPort(),
    request: { identity: { subject: "bob", integrationId: h.ids.intRW, workspaceId: h.ids.wsA, projectIds: [h.ids.projA], environmentIds: [h.ids.envAProd],
      scopes: ["read", "write"], expiresAt: new Date(Date.now() + 60_000).toISOString() }, target: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd },
      revisionId, idempotencyKey: "mcp-native-intent-key-01" },
    async readGraph() { return (await h.db!.query<{ document: Database }>(`select document from "${schema}".graph where workspace_id=$1`, [h.ids.wsA]))[0].document; },
    async writeGraph(data) { await h.db!.query(`update "${schema}".graph set document=$2::text::jsonb where workspace_id=$1`, [h.ids.wsA, json(data)]); await nativeGraph(h.db!, data, h.ids.wsA); },
    async projections() { return (await observer.query<{ document: Deployment }>(`select document from "${schema}".deployments where workspace_id=$1`, [h.ids.wsA])).map(row => row.document); } };
  active = f;
  await h.db!.query(`insert into "${schema}".graph values($1,$2::text::jsonb)`, [h.ids.wsA, json(graph)]);
  await nativeGraph(h.db!, graph, h.ids.wsA);
  await h.db!.query(`insert into "${schema}".manifests values($1,$2,$3::text::jsonb)`, [revisionId, h.ids.wsA, json(manifest)]);
  await h.db!.query("insert into public.revision_manifests(revision_id,workspace_id,manifest) values($1,$2,$3::text::jsonb)", [revisionId, h.ids.wsA, json(manifest)]);
  registerPlatformBrokerStore(h.store); registerPlatformBrokerPorts({ scopes: h.deps.scopes, roles: h.deps.roles, signer: h.deps.signer });
  expect((await platformBroker()).deps.store).toBe(h.store);
  return f;
}
const principal = (f: Fixture): Principal => ({ kind: "integration", id: f.request.identity.integrationId, name: "Modeled authenticated integration",
  integrationId: f.request.identity.integrationId, onBehalfOf: f.request.identity.subject });
async function prepared() {
  const f = await fixture(), reservation = await f.port.prepare(f.request);
  const result = await f.h.broker.propose({ capability: "deployment.deploy", scope: f.request.target, input: reservation.input,
    idempotencyKey: f.request.idempotencyKey }, principal(f), { via: "mcp" });
  await f.port.bind(f.request, result.operation);
  return { ...f, reservation, operation: result.operation };
}
async function claimed() {
  const f = await prepared();
  const args = await f.port.validate(f.request.identity, f.operation);
  await f.h.broker.beginExecution({ workspaceId: f.h.ids.wsA, operationId: f.operation.id, holder: `workflow:${f.operation.id}`, audience: "worker", leaseMs: 5 * 60_000 });
  const request: StartRequest = { kind: "deploy", arguments: { ...args }, namespace: "default", endpointDigest: digest("modeled owned frontend"), taskQueue: "mcp-native-admission" };
  return { ...f, args, startRequest: request, intents: createIsolatedStartIntentStoreForTests(f.h.broker) };
}

describe.skipIf(!PG_URL)("MCP durable deployment admission [postgres; modeled product protocol]", () => {
  it("commits the owning product projection before proposal and binds that same persisted row before execution", async () => {
    const f = await fixture(), reservation = await f.port.prepare(f.request);
    expect(await f.projections()).toHaveLength(1);
    expect((await f.projections())[0]).toMatchObject({ id: reservation.deploymentId, executor: "workflow", revisionId: f.request.revisionId });
    expect((await f.projections())[0].operationId).toBeUndefined();
    expect(await f.h.db!.query("select id from platform.operations where workspace_id=$1", [f.h.ids.wsA])).toEqual([]);
    const result = await f.h.broker.propose({ capability: "deployment.deploy", scope: f.request.target, input: reservation.input, idempotencyKey: f.request.idempotencyKey }, principal(f));
    await f.port.bind(f.request, result.operation);
    expect((await f.projections())[0].operationId).toBe(result.operation.id);
    expect(await f.port.validate(f.request.identity, result.operation)).toMatchObject({ deploymentId: reservation.deploymentId, operationId: result.operation.id });
  });
  it("same immutable request recovers one reservation and one broker operation across an independent pool", async () => {
    const f = await prepared(), again = await f.port.prepare(f.request);
    const replay = await f.h.broker.propose({ capability: "deployment.deploy", scope: f.request.target, input: again.input, idempotencyKey: f.request.idempotencyKey }, principal(f));
    await f.port.bind(f.request, replay.operation);
    expect(replay.replayed).toBe(true); expect(replay.operation.id).toBe(f.operation.id); expect(again.deploymentId).toBe(f.reservation.deploymentId);
    expect(await f.projections()).toHaveLength(1);
  });
  it("same key with changed saved semantics refuses without replacing the retained operation association", async () => {
    const f = await prepared();
    await expect(f.port.prepare({ ...f.request, message: "different immutable request" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await f.projections())[0].operationId).toBe(f.operation.id);
  });
  it("same human and key from another integration reserves a distinct deployment identity", async () => {
    const f = await prepared();
    f.h.world.integrations.set(`${f.h.ids.wsA}|other-integration`, { subject: "bob", scopes: ["read", "write"], projectIds: [f.h.ids.projA] });
    const second = await f.port.prepare({ ...f.request, identity: { ...f.request.identity, integrationId: "other-integration" } });
    expect(second.deploymentId).not.toBe(f.reservation.deploymentId); expect(await f.projections()).toHaveLength(2);
    expect((await f.projections()).find(row => row.id === f.reservation.deploymentId)?.operationId).toBe(f.operation.id);
  });
  it("precommit projection interruption leaves no approved semantics or deployment row", async () => {
    const f = await fixture(); f.commitLoss = "before";
    await expect(f.port.prepare(f.request)).rejects.toThrow("precommit");
    expect(await f.projections()).toEqual([]); expect(await f.h.db!.query("select id from platform.operations where workspace_id=$1", [f.h.ids.wsA])).toEqual([]);
  });
  it("lost projection commit acknowledgement recovers the committed reservation without minting a new identity", async () => {
    const f = await fixture(); f.commitLoss = "after";
    await expect(f.port.prepare(f.request)).rejects.toThrow("ACK loss");
    const original = (await f.projections())[0], recovered = await f.port.prepare(f.request);
    expect(recovered.deploymentId).toBe(original.id); expect(await f.projections()).toHaveLength(1);
  });
  it("lost native proposal acknowledgement recovers the same operation then commits its owning association", async () => {
    const f = await fixture(), reservation = await f.port.prepare(f.request);
    const request = { capability: "deployment.deploy", scope: f.request.target, input: reservation.input, idempotencyKey: f.request.idempotencyKey };
    const accepted = await f.h.broker.propose(request, principal(f));
    await expect(Promise.resolve(accepted).then(() => { throw new Error("Modeled lost native proposal ACK"); })).rejects.toThrow("ACK");
    const replay = await f.h.broker.propose(request, principal(f)); await f.port.bind(f.request, replay.operation);
    expect(replay.operation.id).toBe(accepted.operation.id); expect(replay.replayed).toBe(true);
    expect((await f.projections())[0].operationId).toBe(accepted.operation.id);
  });
  it("lost association commit acknowledgement can recover the same association but cannot force a replacement", async () => {
    const f = await fixture(), reservation = await f.port.prepare(f.request);
    const request = { capability: "deployment.deploy", scope: f.request.target, input: reservation.input, idempotencyKey: f.request.idempotencyKey };
    const accepted = await f.h.broker.propose(request, principal(f)); f.commitLoss = "after";
    await expect(f.port.bind(f.request, accepted.operation)).rejects.toThrow("ACK loss");
    await f.port.bind(f.request, accepted.operation);
    const other = await f.h.broker.propose({ ...request, idempotencyKey: "other-native-intent-key" }, principal(f));
    await expect(f.port.bind(f.request, other.operation)).rejects.toMatchObject({ code: "deployment_admission_conflict" });
    expect((await f.projections())[0].operationId).toBe(accepted.operation.id);
  });
  it("a competing association version change refuses rather than overwriting the committed operation link", async () => {
    const f = await fixture(), reservation = await f.port.prepare(f.request);
    const accepted = await f.h.broker.propose({ capability: "deployment.deploy", scope: f.request.target,
      input: reservation.input, idempotencyKey: f.request.idempotencyKey }, principal(f));
    const original = model.flush.getMockImplementation()!;
    model.flush.mockImplementation(async () => {
      await f.observer.query(`update ${table(f, "deployments")} set document=jsonb_set(document,'{operationId}','"competing-operation"'::jsonb),version=version+1 where id=$1`, [reservation.deploymentId]);
      return original();
    });
    await expect(f.port.bind(f.request, accepted.operation)).rejects.toThrow("optimistic conflict");
    expect((await f.projections())[0].operationId).toBe("competing-operation");
    expect(await f.h.db!.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2", [f.h.ids.wsA, accepted.operation.id])).toEqual([]);
  });
  it("foreign and missing product scope cannot create a deployment or native proposal", async () => {
    const f = await fixture();
    await expect(f.port.prepare({ ...f.request, target: { ...f.request.target, workspaceId: f.h.ids.wsB } })).rejects.toBeDefined();
    await expect(f.port.prepare({ ...f.request, revisionId: "missing-revision" })).rejects.toBeDefined();
    expect(await f.projections()).toEqual([]);
  });
  it("foreign returned manifest workspace and missing or malformed native manifest refuse product mutation", async () => {
    const f = await fixture();
    for (const reply of ["foreign", "missing", "malformed"] as const) { f.manifestReply = reply; await expect(f.port.prepare(f.request)).rejects.toBeDefined(); }
    expect(await f.projections()).toEqual([]);
  });
  it("a missing or foreign deployment association refuses before native execution claim", async () => {
    const f = await prepared();
    await f.h.db!.query(`update ${table(f, "deployments")} set document=jsonb_set(document,'{operationId}','"foreign-operation"'::jsonb),version=version+1 where id=$1`, [f.reservation.deploymentId]);
    await expect(f.port.validate(f.request.identity, f.operation)).rejects.toMatchObject({ code: "deployment_admission_conflict" });
    await f.h.db!.query(`delete from ${table(f, "deployments")} where id=$1`, [f.reservation.deploymentId]);
    await expect(f.port.validate(f.request.identity, f.operation)).rejects.toMatchObject({ code: "deployment_admission_conflict" });
    expect((await f.h.store.getOperation(f.h.ids.wsA, f.operation.id))?.status).toBe("approved");
  });
  it("uncached current full manifest recipe mutation refuses despite the stale enclosing tool snapshot", async () => {
    const f = await prepared();
    await f.h.db!.query(`update ${table(f, "manifests")} set manifest=manifest||'{"laterRecipe":{"pipeline":"changed"}}'::jsonb where revision_id=$1`, [f.request.revisionId]);
    await expect(f.port.validate(f.request.identity, f.operation)).rejects.toMatchObject({ code: "deployment_source_changed" });
    expect((await f.h.store.getOperation(f.h.ids.wsA, f.operation.id))?.status).toBe("approved");
  });
  it("current environment or owning connection change refuses the saved deployment source semantics", async () => {
    const f = await prepared(), graph = await f.readGraph();
    graph.environments[0].region = "us-west-2"; await f.writeGraph(graph);
    await expect(f.port.validate(f.request.identity, f.operation)).rejects.toMatchObject({ code: "deployment_source_changed" });
    graph.connections[0].workspaceId = f.h.ids.wsB; await f.writeGraph(graph);
    await expect(f.port.validate(f.request.identity, f.operation)).rejects.toBeDefined();
  });
  it("expired or revoked current requester cannot reserve a projection or claim its approved native operation", async () => {
    const f = await prepared();
    await expect(f.port.prepare({ ...f.request, identity: { ...f.request.identity, expiresAt: new Date(0).toISOString() } })).rejects.toBeDefined();
    f.h.world.integrations.delete(`${f.h.ids.wsA}|${f.request.identity.integrationId}`);
    await expect(f.h.broker.beginExecution({ workspaceId: f.h.ids.wsA, operationId: f.operation.id, holder: `workflow:${f.operation.id}`, audience: "worker" })).rejects.toBeDefined();
    expect(await f.h.db!.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2", [f.h.ids.wsA, f.operation.id])).toEqual([]);
  });
  it("the exact persisted deployment input yields one permanent native start attempt across independent pools", async () => {
    const f = await claimed(), loads = model.load.mock.calls.length, flushes = model.flush.mock.calls.length;
    await f.intents.prepare(f.h.db!, f.startRequest);
    expect(model.prime).toHaveBeenCalledTimes(1); expect(model.prime).toHaveBeenNthCalledWith(1, null);
    expect(model.load).toHaveBeenCalledTimes(loads + 1); expect(model.flush).toHaveBeenCalledTimes(flushes + 1);
    expect(await model.prime.mock.results[0].value).toMatchObject({ dirty: false, data: { deployments: [
      expect.objectContaining({ id: f.reservation.deploymentId, operationId: f.operation.id, executor: "workflow" }),
    ] } });
    const claims = await Promise.all([f.intents.claim(f.h.db!, f.startRequest), f.intents.claim(f.observer, f.startRequest)]);
    expect(claims.filter(claim => claim.dispatch)).toHaveLength(1); expect(new Set(claims.map(claim => claim.intent.attempt_id)).size).toBe(1);
    // The winner reevaluates in a fresh scope; the retained attempt permits no second evaluation/send.
    expect(model.prime).toHaveBeenCalledTimes(2); expect(model.prime).toHaveBeenNthCalledWith(2, null);
    expect(model.load).toHaveBeenCalledTimes(loads + 2); expect(model.flush).toHaveBeenCalledTimes(flushes + 2);
    const retained = await getIntent(f.observer, f.h.ids.wsA, f.operation.id);
    expect(retained?.binding.arguments).toMatchObject({ deploymentId: f.reservation.deploymentId, revisionId: f.request.revisionId, operationId: f.operation.id });
    expect(retained?.phase).toBe("attempted");
  });
  it("malformed or foreign native deployment arguments cannot reserve a start intent for the owning operation", async () => {
    const f = await claimed();
    for (const arguments_ of [{ ...f.args, deploymentId: "foreign-deployment" }, { ...f.args, workspaceId: f.h.ids.wsB }, { ...f.args, revisionId: "missing-revision" }]) {
      await expect(f.intents.prepare(f.h.db!, { ...f.startRequest, arguments: arguments_ })).rejects.toBeDefined();
    }
    expect(await getIntent(f.observer, f.h.ids.wsA, f.operation.id)).toBeNull();
  });
  it("an uncertain attempted native start remains nonreplayable and an unrecorded claim supplies no recovery proof", async () => {
    const f = await claimed(), loads = model.load.mock.calls.length, flushes = model.flush.mock.calls.length;
    expect(await getIntent(f.observer, f.h.ids.wsA, f.operation.id)).toBeNull();
    await f.intents.prepare(f.h.db!, f.startRequest); const sent = await f.intents.claim(f.h.db!, f.startRequest);
    expect(model.prime).toHaveBeenCalledTimes(2);
    expect(model.prime).toHaveBeenNthCalledWith(1, null); expect(model.prime).toHaveBeenNthCalledWith(2, null);
    expect(model.load).toHaveBeenCalledTimes(loads + 2); expect(model.flush).toHaveBeenCalledTimes(flushes + 2);
    await f.h.broker.markUncertain({ workspaceId: f.h.ids.wsA, operationId: f.operation.id, reason: "Modeled accepted start without confirmed readback" });
    const retry = await f.intents.claim(f.observer, f.startRequest);
    expect(retry.dispatch).toBe(false); expect(retry.intent.attempt_id).toBe(sent.intent.attempt_id);
    expect(retry.intent.phase).toBe("attempted");
    expect(model.prime).toHaveBeenCalledTimes(2); expect(model.load).toHaveBeenCalledTimes(loads + 2);
    expect(model.flush).toHaveBeenCalledTimes(flushes + 2);
  });
});
