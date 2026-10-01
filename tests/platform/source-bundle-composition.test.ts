/** Composition capture only; does not execute workflows or reach GitHub/clouds. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "@/lib/controlplane/types";
import type { ExecutionDeps, SourceBundlePort } from "@/lib/execution";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";

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
});
