/**
 * executeCapability: a day-two capability run through the driver operation
 * registered under the capability's name.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import type { NativeOperation } from "@/lib/drivers/types";
import { LeaseLostError, StepFailedError } from "@/lib/execution/errors";
import { CANARY_SECRET, CANARY_SESSION_KEY, ENV, OP, WS } from "./fakes/fixtures";
import { createWorld, type World, type WorldOptions } from "./fakes/world";

const worlds: World[] = [];
const world = (opts: WorldOptions = {}): World => {
  const w = createWorld(opts);
  worlds.push(w);
  return w;
};
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});

interface Call {
  address: string;
  input: Record<string, unknown>;
  purpose?: string;
  fence?: { scope: string; token: number };
  tags: Record<string, string>;
}

/** A world whose operation is `capability` on `container_service/web`, with a recording ecs driver. */
async function dayTwo(capability: string, input: Record<string, unknown> = { desiredCount: 3 }, ops: Record<string, NativeOperation> | undefined = undefined, over: Partial<WorldOptions> = {}) {
  const calls: Call[] = [];
  const restart: NativeOperation = async (ctx, node, i) => {
    calls.push({ address: node.address, input: i, fence: ctx.fence, tags: ctx.tags });
    return { ok: true, summary: `restarted ${node.address}`, requestIds: ["req-1"], data: { forced: true }, simulated: false };
  };
  const w = world({ overrides: { "aws:ecs_service": { operations: ops ?? { "service.restart": restart, "service.scale": restart } } }, ...over });
  const def = { capability, scope: { workspaceId: WS, projectId: "proj-act-1", environmentId: ENV }, input, summary: capability, details: [], risk: "medium" as const };
  w.product.base.environment.deployedRevisionId = "rev-act-1"; // day two acts on what is deployed
  w.ops.seed({ capability, proposal: def });
  await w.activities.validateDesiredState({ operationId: OP });
  const target = w.resources.byAddress("container_service/web")!;
  w.ops.seed({ capability, proposal: def, status: "approved", resourceId: target.id });
  await w.activities.markOperation({ operationId: OP, status: "running" });
  const lease = await w.lease();
  return { w, lease, calls, target };
}

describe("executeCapability", () => {
  it("finds the driver operation by capability name and runs it under a deploy session with the grant, the fence and the target node", async () => {
    const { w, lease, calls } = await dayTwo("service.restart", { force: true });
    const result = await w.activities.executeCapability({ operationId: OP, lease });

    expect(result).toEqual({ ok: true, summary: "restarted container_service/web" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ address: "container_service/web", input: { force: true }, fence: { scope: `env:${ENV}`, token: lease.fenceToken } });
    expect(calls[0].tags).toMatchObject({ "zenith:managed": "true", "zenith:environment": ENV, "zenith:resource": "container_service/web" });
    // service.restart mutates → deploy role, under the operation's own capability and the lease fence
    expect(w.credentials.sessions.at(-1)).toMatchObject({ purpose: "deploy", capability: "service.restart", fence: lease.fenceToken, revoked: true });
  });

  it("runs the right operation when a driver offers several", async () => {
    const seen: string[] = [];
    const { w, lease } = await dayTwo("service.scale", { desiredCount: 5 }, {
      "service.restart": async () => {
        seen.push("restart");
        return { ok: true, summary: "r", simulated: false };
      },
      "service.scale": async (_c, _n, i) => {
        seen.push(`scale:${String(i.desiredCount)}`);
        return { ok: true, summary: "scaled", simulated: false };
      },
    });
    await w.activities.executeCapability({ operationId: OP, lease });
    expect(seen).toEqual(["scale:5"]);
  });

  it("records evidence of what the driver reported (bounded, with request ids) and announces a successful mutation", async () => {
    const { w, lease } = await dayTwo("service.restart");
    await w.activities.executeCapability({ operationId: OP, lease });
    const [row] = w.evidence.ofKind("observation");
    expect(row.summary).toMatchObject({ kind: "capability", capability: "service.restart", address: "container_service/web", ok: true, requestIds: ["req-1"], data: { forced: true } });
    expect(row.simulated).toBe(false);
    expect(w.events.ofType("resource.applying")).toHaveLength(1); // the marker that a mutating call began
    expect(w.events.ofType("resource.applied")).toHaveLength(1);
  });

  it("returns ok:false instead of throwing when the driver reports a clean failure, and still records it", async () => {
    const { w, lease } = await dayTwo("service.restart", {}, { "service.restart": async () => ({ ok: false, summary: "service is draining", simulated: true }) });
    expect(await w.activities.executeCapability({ operationId: OP, lease })).toEqual({ ok: false, summary: "service is draining" });
    expect(w.evidence.ofKind("observation")[0].simulated).toBe(true);
    expect(w.events.ofType("resource.applied")).toHaveLength(0);
  });

  it("leaves an exception from the driver PLAIN once the call began (it may have acted), with nothing leaked", async () => {
    const { w, lease } = await dayTwo("service.restart", {}, {
      "service.restart": async () => {
        throw new Error(`ECS call failed secret=${CANARY_SECRET} ${CANARY_SESSION_KEY}`);
      },
    });
    const err = await w.activities.executeCapability({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ApplicationFailure);
    expect(w.evidence.ofKind("observation")).toHaveLength(0);
  });

  it("bounds a large driver payload instead of storing it", async () => {
    const { w, lease } = await dayTwo("service.restart", {}, { "service.restart": async () => ({ ok: true, summary: "x".repeat(5000), data: { blob: "y".repeat(10_000) }, simulated: false }) });
    const out = await w.activities.executeCapability({ operationId: OP, lease });
    expect(out.summary.length).toBeLessThanOrEqual(300);
    const summary = w.evidence.ofKind("observation")[0].summary;
    expect(summary.dataTruncated).toBe(true);
    expect(summary.data).toBeUndefined();
  });

  it("refuses BEFORE acting when there is no such driver operation, and says what is missing", async () => {
    const { w, lease } = await dayTwo("service.scale", {}, { "service.restart": async () => ({ ok: true, summary: "r", simulated: false }) });
    const err = await w.activities.executeCapability({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/No driver operation "service.scale"/);
    expect(w.credentials.sessions).toHaveLength(0);
    expect(w.events.ofType("resource.applying")).toHaveLength(0);
  });

  it("refuses a mutation aimed at a resource Zenith does not manage", async () => {
    const { w, lease, target } = await dayTwo("service.restart");
    target.ownership = "referenced";
    const err = await w.activities.executeCapability({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/is referenced: Zenith reads it and never changes it/);
    expect(w.credentials.sessions).toHaveLength(0);
  });

  it("refuses a target in another environment or workspace, no target at all, and an unknown capability", async () => {
    const { w, lease, target } = await dayTwo("service.restart");
    target.environmentId = "env-elsewhere";
    await expect(w.activities.executeCapability({ operationId: OP, lease })).rejects.toThrow(/not found in this environment/);
    target.environmentId = ENV;

    w.ops.seed({ resourceId: undefined });
    await expect(w.activities.executeCapability({ operationId: OP, lease })).rejects.toThrow(/names no target resource/);

    w.ops.seed({ resourceId: target.id, capability: "made.up" });
    await expect(w.activities.executeCapability({ operationId: OP, lease })).rejects.toBeInstanceOf(StepFailedError);
    expect(w.credentials.sessions).toHaveLength(0);
  });

  it("uses the observe role for a read-only capability and does not announce a mutation", async () => {
    const { w, lease } = await dayTwo("service.status", {}, { "service.status": async () => ({ ok: true, summary: "running 3/3", simulated: false }) });
    await w.activities.executeCapability({ operationId: OP, lease });
    expect(w.credentials.sessions.at(-1)).toMatchObject({ purpose: "observe", capability: "service.status" });
    expect(w.events.ofType("resource.applying")).toHaveLength(0);
  });

  it("stops with LeaseLost when the fence is dead, before touching the driver", async () => {
    const { w, lease, calls } = await dayTwo("service.restart");
    w.leases.steal(lease.scope);
    await expect(w.activities.executeCapability({ operationId: OP, lease })).rejects.toBeInstanceOf(LeaseLostError);
    expect(calls).toHaveLength(0);
  });

  it("raises LeaseLost when the lease goes while the operation runs, even if the driver returns", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { w, lease } = await dayTwo("service.restart", {}, {
      "service.restart": async () => {
        await gate;
        return { ok: true, summary: "done", simulated: false };
      },
    });
    const running = w.activities.executeCapability({ operationId: OP, lease }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    w.leases.steal(lease.scope);
    await new Promise((r) => setTimeout(r, 30));
    release();
    expect(await running).toBeInstanceOf(LeaseLostError);
  });
});
