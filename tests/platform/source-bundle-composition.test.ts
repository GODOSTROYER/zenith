/** Composition capture only; does not execute workflows or reach GitHub/clouds. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformDbHandle, type Driver } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import type { ExecutionDeps, SourceBundlePort } from "@/lib/execution";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { azureSourceWorld } from "./source-bundle-azure-fixtures";
import { binding, accountId } from "../providers/azure/source-storage-fixtures";
import { connection } from "../providers/azure/_helpers";
import { IMAGE, DIGEST } from "../providers/azure/release-fixtures";

const captured = vi.hoisted(() => ({ deps: undefined as ExecutionDeps | undefined }));
vi.mock("@/lib/execution", async (original) => {
  const execution = await original<typeof import("@/lib/execution")>();
  return { ...execution, createExecutionActivities: vi.fn((deps: ExecutionDeps) => { captured.deps = deps; return {}; }) };
});
const { composeExecutionActivities } = await import("@/lib/platform/execution");
beforeEach(() => { captured.deps = undefined; });
const db: Sql = { query: vi.fn(async () => []), tx: async (fn) => fn(db) };
const options = { db, secretKey: "1".repeat(64), workerIdentity: "source-contract", planDir: "unused" };

describe("source-bundle execution wiring", () => {
  it("provides a source port using the platform resource store by default", () => {
    composeExecutionActivities(options);
    expect(captured.deps?.sourceBundle?.prepare).toBeTypeOf("function"); expect(captured.deps?.resources.list).toBeTypeOf("function");
  });
  it("keeps an explicit sourceBundle override authoritative", () => {
    const sourceBundle: SourceBundlePort = { prepare: vi.fn() };
    composeExecutionActivities({ ...options, ports: { sourceBundle }, sourceBundles: { timeoutMs: 0 } });
    expect(captured.deps?.sourceBundle).toBe(sourceBundle);
  });
  it("forwards the download configuration and preserves resource overrides", () => {
    const resources = { list: vi.fn() } as unknown as ExecutionDeps["resources"];
    expect(() => composeExecutionActivities({ ...options, ports: { resources }, sourceBundles: { timeoutMs: 0 } })).toThrow("deadline");
    composeExecutionActivities({ ...options, ports: { resources }, sourceBundles: { timeoutMs: 100 } });
    expect(captured.deps?.resources).toBe(resources);
  });
  it("uses the injected resource store with the activity's workspace and environment", async () => {
    const list = vi.fn(async () => []); const resources = { list } as unknown as ExecutionDeps["resources"];
    composeExecutionActivities({ ...options, ports: { resources } });
    const ctx = { provider: "aws", region: "us-east-1", workspaceId: "ws-bound", environmentId: "env-bound", session: { provider: "aws", region: "us-east-1" }, signal: new AbortController().signal } as DriverContext;
    const service: ResourceNode = { provider: "aws", region: "us-east-1", ownership: "managed", address: "container_service/web", kind: "container_service", nativeType: "aws:ecs_service", origin: [], dependsOn: [], labels: {}, specDigest: "a".repeat(64), spec: { artifact: { type: "built", pipeline: "build_pipeline/web" } } };
    await expect(captured.deps!.sourceBundle!.prepare(ctx, { service, source: { repo: "acme/app", ref: "v1" } })).rejects.toThrow("stored desired resource");
    expect(list).toHaveBeenCalledWith("ws-bound", "env-bound");
  });
  it("composes Azure preparation, stored-source reading and the SQL launch journal by default", async () => {
    const w = azureSourceWorld();
    // Only the journal's SQL result is mocked; production selects that journal.
    const query = vi.fn<Sql["query"]>().mockResolvedValue([{ key: "synthetic-journal-claim" }]);
    const journalDb = { query, tx: db.tx } as unknown as Sql;
    vi.stubGlobal("fetch", w.uploadFetch);
    try {
      composeExecutionActivities({ ...options, db: journalDb, sourceBundles: { fetchImpl: w.fetchImpl, azureStorage: w.resolveStorage }, ports: { resources: w.resources as unknown as ExecutionDeps["resources"] } });
      const deps = captured.deps!;
      const prepared = await deps.sourceBundle!.prepare(w.ctx, { service: w.service, source: w.source });
      const handle = await deps.build!.startBuild(w.ctx, { pipeline: w.pipeline, service: w.service, registry: w.registry, source: prepared, idempotencyKey: "composed-azure-build" });
      expect(await deps.build!.waitForBuild(w.ctx, handle, { timeoutMs: 1000 })).toEqual({ status: "succeeded", digest: DIGEST, imageUri: IMAGE });
      expect(w.fetchImpl).toHaveBeenCalledTimes(1); expect(w.state.schedules).toBe(1);
      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[0][0]).toContain("platform.idempotency_keys");
      expect(w.ctx.log).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("uses the trusted connection binding without a source resolver override through ACR launch", async () => {
    const w = azureSourceWorld();
    const run = vi.fn<Driver["run"]>().mockImplementation(async (sql, params) => {
      if (sql.includes("select connection_id from platform.reconcile_state")) {
        expect(params).toEqual([w.ctx.workspaceId, w.ctx.environmentId, w.ctx.region]); return [{ connection_id: "trusted-source-connection" }];
      }
      if (sql.includes("from platform.provider_connections")) {
        expect(params).toEqual([w.ctx.workspaceId, "trusted-source-connection"]);
        return [{ id: "trusted-source-connection", workspace_id: w.ctx.workspaceId, config: { ...connection, subscriptionId: w.ctx.session.subscriptionId, region: w.ctx.region, sourceStorage: { [w.ctx.environmentId]: binding } }, status: "verified", created_by: "operator", created_at: w.ctx.now().toISOString() }];
      }
      if (sql.includes("from platform.resources")) {
        expect(params).toEqual([w.ctx.workspaceId, w.ctx.environmentId, binding.resourceAddress]);
        return [{ id: "trusted-source-resource", workspace_id: w.ctx.workspaceId, environment_id: w.ctx.environmentId, address: binding.resourceAddress, provider: "azure", kind: "object_store", region: w.ctx.region, ownership: "managed", external_id: accountId, status: "active" }];
      }
      if (sql.includes("platform.idempotency_keys")) return [{ key: "synthetic-journal-claim" }];
      return [];
    });
    // The production adapter owns Sql.query<T>; only physical database rows are mocked.
    const driver: Driver = { kind: "pglite", identity: "pglite://synthetic-source-contract", run, exec: async () => undefined, transaction: async (fn) => fn(driver), close: async () => undefined };
    const sourceDb = createPlatformDbHandle(driver);
    vi.stubGlobal("fetch", w.uploadFetch);
    try {
      composeExecutionActivities({ ...options, db: sourceDb, sourceBundles: { fetchImpl: w.fetchImpl }, ports: { resources: w.resources as unknown as ExecutionDeps["resources"] } });
      const prepared = await captured.deps!.sourceBundle!.prepare(w.ctx, { service: w.service, source: w.source });
      await captured.deps!.build!.startBuild(w.ctx, { pipeline: w.pipeline, service: w.service, registry: w.registry, source: prepared, idempotencyKey: "trusted-composed-build" });
      expect(w.resolveStorage).not.toHaveBeenCalled(); expect(w.state.schedules).toBe(1);
      expect(w.fetchImpl).toHaveBeenCalledOnce(); expect(w.ctx.log).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("refuses an Azure environment without a binding in the composed preparation port", async () => {
    const w = azureSourceWorld();
    composeExecutionActivities({ ...options, ports: { resources: w.resources as unknown as ExecutionDeps["resources"] } });
    await expect(captured.deps!.sourceBundle!.prepare(w.ctx, { service: w.service, source: w.source })).rejects.toThrow("storage account/container binding");
    expect(w.fetcher).not.toHaveBeenCalled(); expect(w.state.schedules).toBe(0);
  });
});
