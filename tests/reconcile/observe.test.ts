/** Scripted driver/session contracts; no provider calls or credentials. */
import { describe, expect, it, vi } from "vitest";
import type { DriverContext, ResourceDriver } from "@/lib/drivers/types";
import { CredentialDeniedError } from "@/lib/credentials/types";
import { observeNodes, type ObservableNode } from "@/lib/reconcile/observe";
import { resolveOptions } from "@/lib/reconcile/core";
import type { ObserveSessionRequest } from "@/lib/reconcile/types";
import { ENV, graph, harness } from "./_support";

describe("canonical observation trusted AWS context", () => {
  it("resolves inside the authorized session and shares one safe snapshot across expected values, observation and runtime", async () => {
    const h = harness();
    const node = graph().nodes.find((entry) => entry.kind === "log_group")!;
    const source = { accountId: "123456789012", partition: "aws" as const, bootstrapNameSuffix: "-team-a" };
    let authorized = false;
    const seen: NonNullable<DriverContext["awsBootstrap"]>[] = [];
    const record = (context: Pick<DriverContext, "awsBootstrap">) => {
      expect(authorized).toBe(true);
      expect(context.awsBootstrap).toEqual(source);
      expect(Object.isFrozen(context.awsBootstrap)).toBe(true);
      seen.push(context.awsBootstrap!);
    };
    const driver: ResourceDriver = {
      ...h.world.driver,
      expectedAttributes: (_node, context) => {
        if (!context) throw new Error("trusted context missing");
        record(context);
        return { retentionDays: 7 };
      },
      observe: async (context, selected) => { record(context); return h.world.driver.observe!(context, selected); },
      runtime: async (context, selected) => { record(context); return h.world.driver.runtime!(context, selected); },
    };
    const session = { marker: "private-session-metadata" };
    const resolver = vi.fn(async (request: ObserveSessionRequest, opened: unknown) => {
      expect(authorized).toBe(true);
      expect(opened).toBe(session);
      expect(request).toMatchObject({ workspaceId: ENV.workspaceId, projectId: ENV.projectId, environmentId: ENV.environmentId, connectionId: ENV.connection?.id, provider: "aws", region: ENV.region });
      return source;
    });
    const ports = { now: h.clock.now, resolveAwsBootstrap: resolver, withObserveSession: async <T>(_request: unknown, callback: (opened: unknown) => Promise<T>) => {
      authorized = true;
      try { return await callback(session); } finally { authorized = false; }
    } };
    const item: ObservableNode = { node, resource: { id: "resource-1", address: node.address, ownership: "managed", status: "active" }, driver };
    const observed = await observeNodes({ environment: ENV, items: [item], ports, options: resolveOptions({}), correlationId: "context-pass", deadlineAt: Date.now() + 20_000 });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
    expect(seen[0]).not.toBe(source);
    expect(observed[0].expectedAttributes).toEqual({ retentionDays: 7 });
    expect(observed[0].observation.presence).toBe("present");
    expect(JSON.stringify(observed)).not.toContain(session.marker);
    expect(JSON.stringify(observed)).not.toContain("bootstrapNameSuffix");
  });

  it("refuses all driver reads and expected values when the trusted resolver refuses", async () => {
    const h = harness();
    const node = graph().nodes.find((entry) => entry.kind === "log_group")!;
    const observe = vi.fn(h.world.driver.observe!);
    const runtime = vi.fn(h.world.driver.runtime!);
    const expectedAttributes = vi.fn(() => ({ retentionDays: 7 }));
    const driver = { ...h.world.driver, observe, runtime, expectedAttributes };
    const observed = await observeNodes({ environment: ENV, items: [{ node, resource: { id: "resource-1", address: node.address, ownership: "managed", status: "active" }, driver }], ports: { ...h.ports, resolveAwsBootstrap: async () => { throw new CredentialDeniedError("Saved connection refused."); } }, options: resolveOptions({}), correlationId: "refused-context", deadlineAt: Date.now() + 20_000 });
    expect(observed[0].observation.presence).toBe("inaccessible");
    expect(observed[0].expectedAttributes).toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
    expect(runtime).not.toHaveBeenCalled();
    expect(expectedAttributes).not.toHaveBeenCalled();
  });
});
