/**
 * Agent delivery lifecycle (PROD-MACH-04): the validated heartbeat report, the
 * derived online / recovering / offline / revoked states, and what the admin
 * API shows. Idempotent acceptance of replayed results is covered where it is
 * implemented: late-effect-receipts.test.ts ("accepts an identical signed retry
 * without replacing the first evidence") and results.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as heartbeatRunner } from "@/app/api/platform/v1/runners/[id]/heartbeat/route";
import { POST as heartbeatMachine } from "@/app/api/platform/v1/machines/[id]/heartbeat/route";
import { POST as pollRunner } from "@/app/api/platform/v1/runners/[id]/poll/route";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import { POST as registerMachine } from "@/app/api/platform/v1/machines/register/route";
import { agentView } from "@/lib/runners/admin";
import { connectionView, parseLifecycleReport } from "@/lib/runners/lifecycle";
import { registryOf, type AgentLifecycle } from "@/lib/runners/ports";
import { revokeAgent } from "@/lib/runners/service";
import { createPlane, registerFakeAgent, teardownPlane, type FakeAgent, type Plane } from "./_support";

let plane: Plane;
let runner: FakeAgent;
beforeEach(async () => {
  plane = await createPlane("fake");
  runner = await registerFakeAgent(plane, registerRunner);
});
afterEach(teardownPlane);

/** The JSON the Go agent sends in `lifecycle` (field names are the wire contract). */
const goReport = (over: Record<string, unknown> = {}) => ({
  connection: { state: "online", consecutiveFailures: 0, lastRecoveredAt: "2026-09-30T11:58:00Z", lastOfflineSec: 120 },
  spool: { depth: 2, bytes: 900, oldestAt: "2026-09-30T11:50:00Z", replayed: 3 },
  update: { state: "rolled_back", channel: "stable", running: "1.0.0", lastSeq: 7, rolledBackFrom: "1.1.0", rollbackReason: "health check did not pass within 5m0s" },
  ...over,
});

const stored = async (a: FakeAgent): Promise<AgentLifecycle | undefined> => (await registryOf(plane.store, a.kind).get(a.workspaceId, a.id))?.lifecycle;

describe("parseLifecycleReport", () => {
  it("accepts the agent's report and normalises timestamps", () => {
    const r = parseLifecycleReport(goReport());
    expect(r?.spool).toEqual({ depth: 2, bytes: 900, oldestAt: "2026-09-30T11:50:00.000Z", replayed: 3 });
    expect(r?.update).toMatchObject({ state: "rolled_back", running: "1.0.0", rolledBackFrom: "1.1.0" });
    expect(r?.connection?.lastRecoveredAt).toBe("2026-09-30T11:58:00.000Z");
  });

  it("drops a malformed report instead of failing", () => {
    expect(parseLifecycleReport({ connection: { state: "sideways", consecutiveFailures: 0 } })).toBeUndefined();
    expect(parseLifecycleReport({ spool: { depth: -1, bytes: 0 } })).toBeUndefined();
    expect(parseLifecycleReport("not an object")).toBeUndefined();
    expect(parseLifecycleReport(null)).toBeUndefined();
    expect(parseLifecycleReport({})).toBeUndefined();
    expect(parseLifecycleReport({ update: { state: "current", running: "x".repeat(65) } })).toBeUndefined();
  });

  it("redacts credential-shaped text in agent-supplied free text", () => {
    const secret = "sk_" + "live_abcdefghijklmnop12345678";
    const r = parseLifecycleReport({ update: { state: "check_failed", running: "1.0.0", lastSeq: 1, lastError: `fetch failed for ${secret}`, rollbackReason: `bad ${secret}` } });
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});

describe("heartbeat stores the lifecycle report", () => {
  it("records it for a runner and for a machine, with the store's report time", async () => {
    expect(await stored(runner)).toBeUndefined();
    expect((await runner.post(heartbeatRunner, "/heartbeat", { running: 0, lifecycle: goReport() })).status).toBe(200);
    expect(await stored(runner)).toMatchObject({ spool: { depth: 2 }, update: { state: "rolled_back" }, reportedAt: new Date(plane.clock.t).toISOString() });

    const machine = await registerFakeAgent(plane, registerMachine, { kind: "machine" });
    expect((await machine.post(heartbeatMachine, "/heartbeat", { lifecycle: goReport({ spool: { depth: 0, bytes: 0, replayed: 0 } }) })).status).toBe(200);
    expect((await stored(machine))?.spool?.depth).toBe(0);
  });

  it("never fails a heartbeat because the report is malformed, and keeps the earlier report", async () => {
    await runner.post(heartbeatRunner, "/heartbeat", { lifecycle: goReport() });
    const res = await runner.post(heartbeatRunner, "/heartbeat", { lifecycle: { connection: { state: "bogus" } } });
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(false);
    expect((await stored(runner))?.spool?.depth).toBe(2);
  });
});

describe("connection state", () => {
  const nowMs = () => plane.clock.t;
  const get = async () => (await registryOf(plane.store, "runner").get(runner.workspaceId, runner.id))!;

  it("is online after a plain heartbeat", async () => {
    await runner.post(heartbeatRunner, "/heartbeat", {});
    expect(connectionView(await get(), nowMs())).toMatchObject({ state: "online", takesWork: true, spooledResults: 0 });
  });

  it("is recovering while the agent still holds spooled results, and takes work", async () => {
    await runner.post(heartbeatRunner, "/heartbeat", { lifecycle: goReport({ update: undefined }) });
    const v = connectionView(await get(), nowMs());
    expect(v).toMatchObject({ state: "recovering", takesWork: true, spooledResults: 2 });
    expect(v.summary).toContain("2 saved results");
  });

  it("returns to online once the spool is empty and the recovery is not recent", async () => {
    await runner.post(heartbeatRunner, "/heartbeat", { lifecycle: goReport({ spool: { depth: 0, bytes: 0, replayed: 5 }, update: undefined }) });
    expect(connectionView(await get(), nowMs()).state).toBe("recovering"); // recovered two minutes ago
    plane.clock.t += 10 * 60_000;
    await runner.post(heartbeatRunner, "/heartbeat", { lifecycle: goReport({ spool: { depth: 0, bytes: 0, replayed: 5 }, update: undefined }) });
    expect(connectionView(await get(), nowMs()).state).toBe("online");
  });

  it("is offline once heartbeats stop, takes no work, and says how many results wait on the host", async () => {
    await runner.post(heartbeatRunner, "/heartbeat", { lifecycle: goReport() });
    plane.clock.t += 91_000;
    const v = connectionView(await get(), nowMs());
    expect(v).toMatchObject({ state: "offline", takesWork: false, spooledResults: 2 });
    expect(v.summary).toContain("2 finished results wait on the host");
  });

  it("is revoked after revocation: no work, and the agent is told to stop", async () => {
    await revokeAgent(plane.rt, "runner", runner.workspaceId, runner.id, "user-admin");
    const v = connectionView(await get(), nowMs());
    expect(v).toMatchObject({ state: "revoked", takesWork: false });
    const poll = await runner.post(pollRunner, "/poll", { max: 1, waitSec: 0 });
    expect(poll.status).toBe(401);
    expect(poll.body.error?.code).toBe("agent_revoked");
    expect((await runner.post(heartbeatRunner, "/heartbeat", { lifecycle: goReport() })).body.error?.code).toBe("agent_revoked");
  });

  it("surfaces a rolled-back or health-checking release", async () => {
    await runner.post(heartbeatRunner, "/heartbeat", { lifecycle: goReport() });
    expect(connectionView(await get(), nowMs()).releaseAttention).toContain("1.1.0 failed its health check");
    await runner.post(heartbeatRunner, "/heartbeat", { lifecycle: { update: { state: "pending_health", running: "1.2.0", lastSeq: 8, deadline: "2026-09-30T12:05:00Z" } } });
    expect(connectionView(await get(), nowMs()).releaseAttention).toContain("1.2.0 is running its health check");
  });
});

describe("admin view", () => {
  it("shows connection and delivery without any key material", async () => {
    await runner.post(heartbeatRunner, "/heartbeat", { lifecycle: goReport() });
    const agent = (await registryOf(plane.store, "runner").get(runner.workspaceId, runner.id))!;
    const view = agentView(agent, plane.clock.t);
    expect(view.connection.state).toBe("recovering");
    expect(view.delivery).toMatchObject({ spool: { depth: 2 }, release: { state: "rolled_back" }, agentConnection: { state: "online" } });
    expect(JSON.stringify(view)).not.toContain(runner.key.publicKey);
  });
});
