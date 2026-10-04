/** Owning composition and real local modules; HTTP/driver models are not live GitHub/PostgreSQL proof. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import type { ExecutionDeps, SourceBundlePort } from "@/lib/execution/ports";
import type { ApprovedSourceSnapshot, SourceCaptureInput } from "@/lib/execution/source-snapshot";
import type { Driver, PlatformDbHandle } from "@/lib/controlplane/db";
import type { SourceBundleDeps } from "@/lib/platform/source-bundle";
import { tempDataDir } from "../_support/data-dir";
import { writeTar } from "../_support/tar";

tempDataDir("zenith-approved-source-runtime-", { fast: true });
const recorded = vi.hoisted(() => ({ deps: undefined as ExecutionDeps | undefined, globalDb: vi.fn() }));
vi.mock("@/lib/controlplane/db/open", async original => ({
  ...await original<typeof import("@/lib/controlplane/db/open")>(),
  platformDb: () => { recorded.globalDb(); throw new Error("A global source database is forbidden in this fixture."); },
}));
vi.mock("@/lib/execution", async original => ({
  ...await original<typeof import("@/lib/execution")>(),
  createExecutionActivities: (deps: ExecutionDeps) => { recorded.deps = deps; return {}; },
}));
const { createApprovedSourceRuntime } = await import("@/lib/platform/approved-source-runtime");
const { composeExecutionActivities } = await import("@/lib/platform/execution");
const { createOwningSourceBundles } = await import("@/lib/platform/source-bundle");
const { createPlatformDbHandle, openPlatformDb, repos, PLATFORM_SCHEMA_VERSION } = await import("@/lib/controlplane/db");
const { isApprovedSourceSnapshotStore, createIsolatedApprovedSourceStoreForTests } = await import("@/lib/controlplane/db/repos/approved-source-snapshots");
const { sourceRecipe, sourceSnapshotDigest, approvedSources } = await import("@/lib/execution/source-snapshot");
const { createPlatformPorts } = await import("@/lib/execution/platform");
const { createRuntime } = await import("@/lib/execution/runtime");
const { loadExecContext } = await import("@/lib/execution/context");
const { createWorld } = await import("../execution/fakes/world");
const { OP } = await import("../execution/fakes/fixtures");
const { mkNode } = await import("../providers/aws/drivers/compute/fixtures");
const { PG_URL, newWorkspace, seedApprovedOperation } = await import("../controlplane/_support/harness");

if (process.env.ZENITH_TEST_APPROVED_SOURCE_RUNTIME_REQUIRED === "1") {
  if (!PG_URL) throw new Error("Approved source runtime acceptance requires owned PostgreSQL.");
  if (PLATFORM_SCHEMA_VERSION < 13) throw new Error("Approved source runtime requires the canonical registered schema13.");
}

let local: PlatformDbHandle;
beforeAll(async () => { local = await openPlatformDb({ kind: "pglite" }); });
afterAll(async () => { await local?.close(); });
afterEach(() => { recorded.deps = undefined; recorded.globalDb.mockClear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const source: SourceCaptureInput = { workspaceId: "ws-runtime", operationId: "op-runtime", projectId: "proj-runtime", environmentId: "env-runtime",
  serviceAddress: "container_service/web", serviceSpecDigest: "a".repeat(64), pipelineAddress: "build_pipeline/web", pipelineSpecDigest: "b".repeat(64),
  provider: "aws", region: "eu-west-1", repository: "acme/app", requestedRef: "main", dockerfile: "Dockerfile", recipeDigest: "c".repeat(64), archiveFormat: "zip" };
function http() {
  return vi.fn<typeof fetch>(async raw => {
    const url = String(raw);
    if (url === "https://api.github.com/repos/acme/app") return Response.json({ id: 99, name: "app", owner: { login: "acme" }, private: false });
    if (url.startsWith("https://api.github.com/repos/acme/app/commits/")) return new Response("d".repeat(40));
    if (url === `https://codeload.github.com/acme/app/tar.gz/${"d".repeat(40)}` || url === "https://codeload.github.com/acme/app/tar.gz/main") {
      return new Response(new Uint8Array(gzipSync(writeTar([{ path: "root/Dockerfile", bytes: Buffer.from("FROM scratch\n") }]))));
    }
    throw new Error("Unexpected modeled source request.");
  });
}
function structuralPostgres() {
  // Real SQL adapter over a scripted physical driver. This is explicitly not a PG acceptance handle.
  const run = vi.fn<Driver["run"]>(async () => []);
  const driver: Driver = { kind: "postgres", identity: "postgres://fixture.invalid/model", run, exec: async () => undefined,
    transaction: async fn => fn(driver), close: async () => undefined };
  return { db: createPlatformDbHandle(driver), run };
}
function fixtureStore() {
  const list = vi.fn(async () => []), retain = vi.fn(async (value: ApprovedSourceSnapshot) => value), assertCurrent = vi.fn(async () => undefined), assertReviewed = vi.fn(async () => undefined);
  const model = { list, retain, assertCurrent, assertReviewed };
  return { store: createIsolatedApprovedSourceStoreForTests(model), model };
}
function compose(db: PlatformDbHandle, ports?: Partial<ExecutionDeps>) {
  return composeExecutionActivities({ db, secretKey: "1".repeat(64), workerIdentity: "source-runtime-fixture", planDir: "unused", ports });
}

describe("default approved source runtime composition", () => {
  it("constructs one recognized store without SQL, HTTP or global opening and routes both authorities to the captured handle", async () => {
    const owning = structuralPostgres(), fetchImpl = http(); vi.stubGlobal("fetch", fetchImpl);
    const runtime = createApprovedSourceRuntime(owning.db);
    expect(isApprovedSourceSnapshotStore(runtime.sourceSnapshots)).toBe(true); expect(Object.isFrozen(runtime)).toBe(true);
    expect(owning.run).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled(); expect(recorded.globalDb).not.toHaveBeenCalled();
    await runtime.sourceSnapshots!.list({ workspaceId: source.workspaceId, operationId: source.operationId, projectId: source.projectId, environmentId: source.environmentId });
    const captured = await runtime.sourceBundle.capture!(source); await runtime.sourceBundle.verify!(captured);
    expect(owning.run.mock.calls.some(([sql, params]) => sql.includes("platform.approved_source_snapshots") && JSON.stringify(params) === JSON.stringify([source.workspaceId, source.operationId, source.projectId, source.environmentId]))).toBe(true);
    const github = owning.run.mock.calls.filter(([sql]) => sql.includes("platform.github_source_bindings"));
    expect(github.length > 0).toBe(true); expect(github.every(([, params]) => JSON.stringify(params) === JSON.stringify([source.workspaceId]))).toBe(true);
    expect(captured.commitSha).toBe("d".repeat(40)); expect(recorded.globalDb).not.toHaveBeenCalled();
  });
  it("the default activity wiring passes the canonical store and fixed source port without opening global state", () => {
    const owning = structuralPostgres(); compose(owning.db);
    expect(isApprovedSourceSnapshotStore(recorded.deps?.sourceSnapshots)).toBe(true);
    expect(recorded.deps?.sourceBundle?.capture).toBeTypeOf("function"); expect(recorded.deps?.sourceBundle?.verify).toBeTypeOf("function");
    expect(owning.run).not.toHaveBeenCalled(); expect(recorded.globalDb).not.toHaveBeenCalled();
  });
  it("later composition-option replacement cannot select another source database", async () => {
    const owning = structuralPostgres(), foreign = structuralPostgres(), fetchImpl = http(); vi.stubGlobal("fetch", fetchImpl);
    const options = { db: owning.db, secretKey: "1".repeat(64), workerIdentity: "captured-source-fixture", planDir: "unused" };
    composeExecutionActivities(options); const deps = recorded.deps!; options.db = foreign.db;
    await deps.sourceSnapshots!.list({ workspaceId: source.workspaceId, operationId: source.operationId, projectId: source.projectId, environmentId: source.environmentId });
    await deps.sourceBundle!.capture!(source);
    expect(owning.run.mock.calls.some(([sql]) => sql.includes("platform.approved_source_snapshots"))).toBe(true);
    expect(owning.run.mock.calls.some(([sql]) => sql.includes("platform.github_source_bindings"))).toBe(true);
    expect(foreign.run).not.toHaveBeenCalled(); expect(recorded.globalDb).not.toHaveBeenCalled();
  });
  it("losing the captured PostgreSQL prerequisite refuses before source I/O on every invocation", async () => {
    const owning = structuralPostgres(), fetchImpl = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetchImpl);
    const runtime = createApprovedSourceRuntime(owning.db); Object.assign(owning.db, { kind: "pglite" });
    await expect(runtime.sourceBundle.capture!(source)).rejects.toThrow("PostgreSQL");
    await expect(runtime.sourceBundle.verify!({} as never)).rejects.toThrow("PostgreSQL");
    await expect(runtime.sourceBundle.prepare({} as never, {} as never)).rejects.toThrow("PostgreSQL");
    await expect(runtime.sourceSnapshots!.list({ workspaceId: source.workspaceId, operationId: source.operationId, projectId: source.projectId, environmentId: source.environmentId })).rejects.toThrow();
    expect(owning.run).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled(); expect(recorded.globalDb).not.toHaveBeenCalled();
  });
  it("the minimal owning constructor keeps standalone reads anonymous and immutable reads on the owning handle", async () => {
    const owning = structuralPostgres(), fetchImpl = http(); vi.stubGlobal("fetch", fetchImpl);
    // read() has no workspace by design. A separately scoped connector is not
    // exposed as a caller hook; immutable capture supplies the owning workspace.
    const bundles = createOwningSourceBundles(owning.db);
    const result = await bundles.read({ repo: "acme/app", ref: "main" });
    expect(result.bytes > 0).toBe(true); expect(recorded.globalDb).not.toHaveBeenCalled();
    await bundles.port.capture!(source);
    expect(owning.run.mock.calls.some(([sql]) => sql.includes("platform.github_source_bindings"))).toBe(true);
  });
  it("local source-free composition remains usable while every built-source port refuses before HTTP, SQL or credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetchImpl);
    const calls = vi.spyOn(local, "query"), runtime = createApprovedSourceRuntime(local);
    try {
      compose(local); expect(recorded.deps?.sourceSnapshots).toBeUndefined();
      const credentialCalls = vi.spyOn(recorded.deps!.credentials, "withSession");
      try {
        const before = calls.mock.calls.length;
        await expect(runtime.sourceBundle.capture!(source)).rejects.toThrow("PostgreSQL");
        await expect(runtime.sourceBundle.verify!({} as never)).rejects.toThrow("PostgreSQL");
        await expect(runtime.sourceBundle.prepare({} as never, {} as never)).rejects.toThrow("PostgreSQL");
        await expect(runtime.readAzureSource({} as never, {} as never)).rejects.toThrow("PostgreSQL");
        expect(calls).toHaveBeenCalledTimes(before); expect(credentialCalls).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled(); expect(recorded.globalDb).not.toHaveBeenCalled();
      } finally { credentialCalls.mockRestore(); }
    } finally { calls.mockRestore(); }
  });
  it("canonical nonbuild source selection returns empty without requiring source custody or adding a source digest", async () => {
    const world = createWorld();
    try {
      const runtime = createRuntime({ ...world.deps, sourceBundle: createApprovedSourceRuntime(local).sourceBundle, sourceSnapshots: undefined });
      const context = await loadExecContext(runtime, OP), lease = await world.lease();
      expect(await approvedSources(runtime, context, { version: 1, environmentId: context.environmentId, manifestDigest: "a".repeat(64), graphDigest: "b".repeat(64), nodes: [], edges: [], notes: [] }, lease, true)).toEqual([]);
      expect(context.executableSourceDigest).toBeUndefined(); expect(world.sourceBundle.captures).toHaveLength(0);
    } finally { world.dispose(); }
  });
  it.each(["development", "production"])("refuses source authority/transport overrides in %s before activity construction or use", mode => {
    const isolated = fixtureStore(), owning = structuralPostgres(), bundle: SourceBundlePort = { prepare: vi.fn() };
    vi.stubEnv("NODE_ENV", mode);
    for (const options of [{ sourceSnapshots: isolated.store }, { sourceBundles: { sourceSnapshots: isolated.store } }, { sourceSnapshots: isolated.store, sourceBundle: bundle }, { sourceBundles: { fetchImpl: http() } }]) {
      expect(() => createApprovedSourceRuntime(owning.db, options)).toThrow("isolated test");
    }
    expect(() => compose(owning.db, { sourceSnapshots: isolated.store })).toThrow("isolated test");
    expect(recorded.deps).toBeUndefined(); expect(owning.run).not.toHaveBeenCalled(); expect(isolated.model.list).not.toHaveBeenCalled();
  });
  it("never admits a forged store, even in test mode, and refuses conflicting recognized stores", () => {
    const a = fixtureStore(), b = fixtureStore();
    expect(() => createApprovedSourceRuntime(local, { sourceSnapshots: { ...a.store } })).toThrow("recognized");
    expect(() => createApprovedSourceRuntime(local, { sourceSnapshots: a.store, sourceBundles: { sourceSnapshots: b.store } })).toThrow("do not match");
    expect(a.model.list).not.toHaveBeenCalled(); expect(b.model.list).not.toHaveBeenCalled();
  });
  it("does not admit connector proof callbacks in any mode", () => {
    const callback = vi.fn(), owning = structuralPostgres();
    expect(() => createApprovedSourceRuntime(owning.db, { sourceBundles: { withGithubAccess: callback } })).toThrow("cannot be overridden");
    expect(callback).not.toHaveBeenCalled(); expect(owning.run).not.toHaveBeenCalled();
  });
  it("captures recognized test methods once and checks test admission on every store/source invocation", async () => {
    const isolated = fixtureStore(), original = vi.fn(async () => ({ s3Key: "fixture", digest: "a".repeat(64) })), late = vi.fn();
    const capture = vi.fn<NonNullable<SourceBundlePort["capture"]>>(), verify = vi.fn<NonNullable<SourceBundlePort["verify"]>>(), bundle: SourceBundlePort = { prepare: original, capture, verify };
    compose(local, { sourceSnapshots: isolated.store, sourceBundle: bundle });
    const deps = recorded.deps!; expect(deps.sourceBundle).not.toBe(bundle); expect(isApprovedSourceSnapshotStore(deps.sourceSnapshots)).toBe(true);
    bundle.prepare = late; await deps.sourceBundle!.prepare({} as never, {} as never);
    expect(original).toHaveBeenCalledOnce(); expect(late).not.toHaveBeenCalled();
    for (const mode of ["development", "production"]) {
      vi.stubEnv("NODE_ENV", mode);
      await expect(deps.sourceBundle!.prepare({} as never, {} as never)).rejects.toThrow("isolated test");
      await expect(deps.sourceBundle!.capture!(source)).rejects.toThrow("isolated test");
      await expect(deps.sourceBundle!.verify!({} as never)).rejects.toThrow("isolated test");
      expect(() => deps.sourceSnapshots!.list({} as never)).toThrow();
      expect(() => deps.sourceSnapshots!.retain({} as never, {} as never)).toThrow();
      expect(() => deps.sourceSnapshots!.assertCurrent({} as never)).toThrow();
      expect(() => deps.sourceSnapshots!.assertReviewed({} as never)).toThrow();
    }
    expect(original).toHaveBeenCalledOnce(); expect(capture).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled(); expect(isolated.model.list).not.toHaveBeenCalled();
  });
});

describe("direct owning source constructor admission", () => {
  it("returns its internally constructed owning store together with the guarded source port", async () => {
    const owning = structuralPostgres(), foreign = structuralPostgres(), fetchImpl = http(); vi.stubGlobal("fetch", fetchImpl);
    const bundles = createOwningSourceBundles(owning.db);
    expect(isApprovedSourceSnapshotStore(bundles.sourceSnapshots)).toBe(true);
    expect(Object.isFrozen(bundles)).toBe(true); expect(Object.isFrozen(bundles.port)).toBe(true);
    expect(owning.run).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
    await bundles.sourceSnapshots!.list({ workspaceId: source.workspaceId, operationId: source.operationId, projectId: source.projectId, environmentId: source.environmentId });
    const captured = await bundles.port.capture!(source); await bundles.port.verify!(captured);
    expect(owning.run.mock.calls.some(([sql, params]) => sql.includes("platform.approved_source_snapshots") && JSON.stringify(params) === JSON.stringify([source.workspaceId, source.operationId, source.projectId, source.environmentId]))).toBe(true);
    const github = owning.run.mock.calls.filter(([sql]) => sql.includes("platform.github_source_bindings"));
    expect(github.length > 0).toBe(true); expect(github.every(([, params]) => JSON.stringify(params) === JSON.stringify([source.workspaceId]))).toBe(true);
    expect(foreign.run).not.toHaveBeenCalled(); expect(recorded.globalDb).not.toHaveBeenCalled();
  });
  it.each(["development", "production"])("direct construction refuses every explicit store/transport override in %s before source I/O", mode => {
    const owning = structuralPostgres(), isolated = fixtureStore(), fetchImpl = http();
    const canonical = createOwningSourceBundles(owning.db).sourceSnapshots!;
    vi.stubEnv("NODE_ENV", mode);
    for (const deps of [{ fetchImpl }, { sourceSnapshots: isolated.store }, { sourceSnapshots: isolated.store, fetchImpl }, { sourceSnapshots: canonical }]) {
      expect(() => createOwningSourceBundles(owning.db, deps)).toThrow("isolated test");
    }
    expect(fetchImpl).not.toHaveBeenCalled(); expect(owning.run).not.toHaveBeenCalled(); expect(recorded.globalDb).not.toHaveBeenCalled();
    expect(isolated.model.list).not.toHaveBeenCalled(); expect(isolated.model.retain).not.toHaveBeenCalled();
  });
  it("test construction refuses unrecognized copied stores and transport without a recognized store", () => {
    const owning = structuralPostgres(), isolated = fixtureStore(), fetchImpl = http();
    for (const deps of [{ fetchImpl }, { sourceSnapshots: { ...isolated.store } }, { sourceSnapshots: { ...isolated.store }, fetchImpl }]) {
      expect(() => createOwningSourceBundles(owning.db, deps)).toThrow("recognized");
    }
    expect(fetchImpl).not.toHaveBeenCalled(); expect(owning.run).not.toHaveBeenCalled(); expect(isolated.model.list).not.toHaveBeenCalled();
  });
  it("a direct non-PostgreSQL constructor preserves anonymous reading but refuses all built-source operations before SQL or HTTP", async () => {
    const fetchImpl = http(); vi.stubGlobal("fetch", fetchImpl);
    const calls = vi.spyOn(local, "query"), bundles = createOwningSourceBundles(local);
    try {
      expect(bundles.sourceSnapshots).toBeUndefined();
      const archive = await bundles.read({ repo: "acme/app", ref: "main" }); expect(archive.bytes > 0).toBe(true);
      const requests = fetchImpl.mock.calls.length, queries = calls.mock.calls.length;
      await expect(bundles.port.capture!(source)).rejects.toThrow("PostgreSQL");
      await expect(bundles.port.verify!({} as never)).rejects.toThrow("PostgreSQL");
      await expect(bundles.port.prepare({} as never, {} as never)).rejects.toThrow("PostgreSQL");
      await expect(bundles.readAzureSource({} as never, {} as never)).rejects.toThrow("PostgreSQL");
      expect(fetchImpl).toHaveBeenCalledTimes(requests); expect(calls).toHaveBeenCalledTimes(queries); expect(recorded.globalDb).not.toHaveBeenCalled();
    } finally { calls.mockRestore(); }
  });
  it.each(["identity", "exec", "close"])("a PostgreSQL kind without its %s structural prerequisite refuses before source I/O", async field => {
    const owning = structuralPostgres(), fetchImpl = http(); vi.stubGlobal("fetch", fetchImpl);
    Object.assign(owning.db, { [field]: undefined });
    const bundles = createOwningSourceBundles(owning.db);
    expect(bundles.sourceSnapshots).toBeUndefined();
    await expect(bundles.port.capture!(source)).rejects.toThrow("PostgreSQL");
    await expect(bundles.port.verify!({} as never)).rejects.toThrow("PostgreSQL");
    await expect(bundles.port.prepare({} as never, {} as never)).rejects.toThrow("PostgreSQL");
    expect(fetchImpl).not.toHaveBeenCalled(); expect(owning.run).not.toHaveBeenCalled(); expect(recorded.globalDb).not.toHaveBeenCalled();
  });
  it("recognized test store/transport admission cannot enable real source ports on a non-PostgreSQL handle", async () => {
    const isolated = fixtureStore(), fetchImpl = http(), calls = vi.spyOn(local, "query");
    try {
      const bundles = createOwningSourceBundles(local, { sourceSnapshots: isolated.store, fetchImpl });
      await expect(bundles.port.capture!(source)).rejects.toThrow("PostgreSQL");
      await expect(bundles.port.verify!({} as never)).rejects.toThrow("PostgreSQL");
      await expect(bundles.port.prepare({} as never, {} as never)).rejects.toThrow("PostgreSQL");
      await expect(bundles.readAzureSource({} as never, {} as never)).rejects.toThrow("PostgreSQL");
      expect(fetchImpl).not.toHaveBeenCalled(); expect(calls).not.toHaveBeenCalled();
      expect(isolated.model.list).not.toHaveBeenCalled(); expect(recorded.globalDb).not.toHaveBeenCalled();
    } finally { calls.mockRestore(); }
  });
  it("direct isolated construction captures dependencies once and rechecks environment admission on every public invocation", async () => {
    const owning = structuralPostgres(), isolated = fixtureStore(), fetchImpl = http(), late = http(), replacement = fixtureStore();
    const deps = { sourceSnapshots: isolated.store, fetchImpl }, bundles = createOwningSourceBundles(owning.db, deps);
    deps.fetchImpl = late; deps.sourceSnapshots = replacement.store;
    await bundles.sourceSnapshots!.list({ workspaceId: source.workspaceId, operationId: source.operationId, projectId: source.projectId, environmentId: source.environmentId });
    const captured = await bundles.port.capture!(source); await bundles.port.verify!(captured);
    expect(isolated.model.list).toHaveBeenCalledOnce(); expect(replacement.model.list).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.length > 0).toBe(true); expect(late).not.toHaveBeenCalled();
    const requests = fetchImpl.mock.calls.length, queries = owning.run.mock.calls.length;
    for (const mode of ["development", "production"]) {
      vi.stubEnv("NODE_ENV", mode);
      await expect(bundles.read({ repo: "acme/app", ref: "main" })).rejects.toThrow("isolated test");
      await expect(bundles.port.capture!(source)).rejects.toThrow("isolated test");
      await expect(bundles.port.verify!(captured)).rejects.toThrow("isolated test");
      await expect(bundles.port.prepare({} as never, {} as never)).rejects.toThrow("isolated test");
      await expect(bundles.readAzureSource({} as never, {} as never)).rejects.toThrow("isolated test");
      expect(() => bundles.sourceSnapshots!.list({} as never)).toThrow();
      expect(() => bundles.sourceSnapshots!.retain({} as never, {} as never)).toThrow();
      expect(() => bundles.sourceSnapshots!.assertCurrent({} as never)).toThrow();
      expect(() => bundles.sourceSnapshots!.assertReviewed({} as never)).toThrow();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(requests); expect(owning.run).toHaveBeenCalledTimes(queries);
    expect(isolated.model.list).toHaveBeenCalledOnce(); expect(late).not.toHaveBeenCalled(); expect(recorded.globalDb).not.toHaveBeenCalled();
  });
  it("direct default source ports recheck the captured PostgreSQL prerequisite at invocation", async () => {
    const owning = structuralPostgres(), fetchImpl = http(); vi.stubGlobal("fetch", fetchImpl);
    const bundles = createOwningSourceBundles(owning.db); Object.assign(owning.db, { kind: "pglite" });
    await expect(bundles.port.capture!(source)).rejects.toThrow("PostgreSQL");
    await expect(bundles.port.verify!({} as never)).rejects.toThrow("PostgreSQL");
    await expect(bundles.port.prepare({} as never, {} as never)).rejects.toThrow("PostgreSQL");
    await expect(bundles.readAzureSource({} as never, {} as never)).rejects.toThrow("PostgreSQL");
    expect(fetchImpl).not.toHaveBeenCalled(); expect(owning.run).not.toHaveBeenCalled(); expect(recorded.globalDb).not.toHaveBeenCalled();
  });
  it.each(["test", "development", "production"])("direct construction refuses runtime connector callbacks in %s", mode => {
    const owning = structuralPostgres(), callback = vi.fn(), deps: SourceBundleDeps = { withGithubAccess: callback };
    vi.stubEnv("NODE_ENV", mode);
    expect(() => createOwningSourceBundles(owning.db, deps)).toThrow("cannot be overridden");
    expect(callback).not.toHaveBeenCalled(); expect(owning.run).not.toHaveBeenCalled(); expect(recorded.globalDb).not.toHaveBeenCalled();
  });
});

describe.skipIf(!PG_URL)("default approved source runtime owning persistence [postgres]", () => {
  let db: PlatformDbHandle, peer: PlatformDbHandle;
  beforeAll(async () => {
    // Root registers migration13 before this lane. No unregistered/raw DDL.
    if (PLATFORM_SCHEMA_VERSION < 13) throw new Error("Approved source runtime requires the canonical registered schema13.");
    db = await openPlatformDb({ kind: "postgres", url: PG_URL!, migrate: true, max: 1 });
    peer = await openPlatformDb({ kind: "postgres", url: PG_URL!, max: 1 });
  }, 60_000);
  afterAll(async () => { await peer?.close(); await db?.close(); });
  it("default single-pool owning runtime captures, retains and verifies the same immutable row across an independent pool", async () => {
    const workspaceId = newWorkspace(), projectId = `proj_${workspaceId}`, environmentId = `env_${workspaceId}`;
    const { operation } = await seedApprovedOperation(db, workspaceId, { ttlMs: 120_000, proposal: { capability: "deployment.deploy", scope: { workspaceId, projectId, environmentId } } });
    const lease = await repos.leases.acquire(db, { workspaceId, scope: `env:${environmentId}`, holder: `worker:${operation.id}`, ttlMs: 120_000 });
    if (!lease) throw new Error("The source runtime fixture lease is unavailable.");
    await repos.operations.claimForExecution(db, { workspaceId, id: operation.id, expectedDigest: operation.proposalDigest, holder: `workflow:${operation.id}`, leaseMs: 120_000, lease });
    const pipeline = mkNode("build_pipeline/web", "build_pipeline", "aws:codebuild_project", { location: "customer_account", source: { repo: "acme/app", ref: "main", dockerfile: "Dockerfile" } }, { region: "eu-west-1", specDigest: "b".repeat(64) });
    const service = mkNode("container_service/web", "container_service", "aws:ecs_service", { artifact: { type: "built", pipeline: pipeline.address } }, { region: "eu-west-1", specDigest: "a".repeat(64) });
    for (const node of [pipeline, service]) await repos.resources.upsertDesired(db, { workspaceId, projectId, environmentId, node, status: "planned" });
    const owning = createApprovedSourceRuntime(db, { resources: createPlatformPorts(db).resources }), independent = createApprovedSourceRuntime(peer);
    const fetchImpl = http(); vi.stubGlobal("fetch", fetchImpl);
    const input = { ...source, workspaceId, projectId, environmentId, operationId: operation.id, recipeDigest: sourceRecipe(service, pipeline) };
    const captured = await owning.sourceBundle.capture!(input);
    const retained = await owning.sourceSnapshots!.retain(captured, lease);
    const scope = { workspaceId, projectId, environmentId, operationId: operation.id };
    expect(db).not.toBe(peer); expect(sourceSnapshotDigest(retained)).toBe(sourceSnapshotDigest(captured));
    expect((await independent.sourceSnapshots!.list(scope)).map(sourceSnapshotDigest)).toEqual([sourceSnapshotDigest(captured)]);
    await independent.sourceBundle.verify!(retained); await independent.sourceSnapshots!.assertCurrent(retained);
    expect(recorded.globalDb).not.toHaveBeenCalled();
    // Scoped SQL demotion is a negative fixture, not browser/admin acceptance.
    await peer.query("insert into platform.github_source_bindings (workspace_id,app_id,installation_id,repository_id,owner,repo,version,bound_by,revoked_at) values ($1,'42',7,99,'acme','app',1,'fixture',clock_timestamp())", [workspaceId]);
    const requests = fetchImpl.mock.calls.length;
    await expect(owning.sourceBundle.verify!(retained)).rejects.toThrow();
    await expect(owning.sourceSnapshots!.assertCurrent(retained)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(requests);
    expect((await independent.sourceSnapshots!.list(scope)).map(sourceSnapshotDigest)).toEqual([sourceSnapshotDigest(captured)]);
  }, 30_000);
});
