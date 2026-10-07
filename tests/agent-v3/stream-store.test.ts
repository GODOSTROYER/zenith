/**
 * Resumable streams over the real platform schema (PGlite here; set
 * ZENITH_TEST_PLATFORM_PG_URL to run the same file on PostgreSQL). Nothing is
 * mocked: migration 36, the repository, the port, the SDK EventStore adapter
 * and the resume stream all run against the engine.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { RequestEventStore, cancelFlights, eventIdOf, parseEventId, principalKeyOf, registerFlight, resumeStream, sqlStreamPort, watchDurableCancel } from "@/lib/agent-access/v3/stream";
import type { AgentIdentity } from "@/lib/agent-access/v3/principal";

const PG_URL = process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim() || undefined;
const opened: PlatformDbHandle[] = [];
afterAll(async () => { for (const db of opened) await db.close(); });

async function setup() {
  const db = await (PG_URL ? openPlatformDb({ kind: "postgres", url: PG_URL, migrate: true, max: 3 }) : openPlatformDb({ kind: "pglite" }));
  opened.push(db);
  const suffix = randomUUID().slice(0, 8);
  const alice: AgentIdentity = { subject: "alice", integrationId: `cred-a-${suffix}`, workspaceId: `ws-${suffix}`, projectIds: ["p"], scopes: ["read"], expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const bob: AgentIdentity = { ...alice, subject: "bob", integrationId: `cred-b-${suffix}` };
  const foreignWorkspace: AgentIdentity = { ...alice, workspaceId: `ws-other-${suffix}` };
  return { db, port: sqlStreamPort(async () => db), alice, bob, foreignWorkspace };
}
const sdkStreamId = () => randomUUID();
const hex = (uuid: string) => uuid.replace(/-/g, "");
const progress = (n: number) => ({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t", progress: n } });
const result = (id: string | number, ok = true) => ({ jsonrpc: "2.0", id, result: { structuredContent: { ok } } });

describe("event ids", () => {
  it("round-trip and refuse anything else", () => {
    expect(parseEventId(eventIdOf("a".repeat(32), 12))).toEqual({ streamId: "a".repeat(32), seq: 12 });
    for (const bad of [null, "", "x", `${"a".repeat(32)}.0`, `${"A".repeat(32)}.1`, `${"a".repeat(31)}.1`, `${"a".repeat(32)}.1.2`, `${"a".repeat(32)}.1234567`, `../${"a".repeat(32)}.1`]) expect(parseEventId(bad)).toBeUndefined();
  });
});

describe("principal binding", () => {
  it("separates workspace, subject, credential and plugin grant", () => {
    const { alice, bob } = { alice: { subject: "a", integrationId: "c", workspaceId: "w" } as AgentIdentity, bob: { subject: "b", integrationId: "c", workspaceId: "w" } as AgentIdentity };
    const keys = new Set([principalKeyOf(alice), principalKeyOf(bob), principalKeyOf({ ...alice, workspaceId: "w2" }), principalKeyOf({ ...alice, integrationId: "c2" }),
      principalKeyOf({ ...alice, plugin: { registrationId: "r", grantId: "g", pluginId: "p", version: "1", manifestDigest: "d", tools: [] } })]);
    expect(keys.size).toBe(5);
    expect(principalKeyOf(alice)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("RequestEventStore over the platform schema", () => {
  it("stores priming, progress and the result in order and serves them back to the same principal only", async () => {
    const { port, alice, bob, foreignWorkspace } = await setup();
    let finished = 0;
    const store = new RequestEventStore(port, alice, "7", "2025-11-25", () => { finished += 1; });
    const sdk = sdkStreamId();
    const a = await store.storeEvent(sdk, {} as never);
    const b = await store.storeEvent(sdk, progress(1) as never);
    const c = await store.storeEvent(sdk, progress(2) as never);
    expect(finished).toBe(0);
    const d = await store.storeEvent(sdk, result(7) as never);
    expect([a, b, c, d]).toEqual([1, 2, 3, 4].map((n) => eventIdOf(hex(sdk), n)));
    expect(finished).toBe(1);
    expect(store.finalSeen).toBe(true);
    expect(await port.status(alice, hex(sdk))).toBe("completed");

    const rows = await port.read(alice, hex(sdk), 1);
    expect(rows?.map((r) => r.seq)).toEqual([2, 3, 4]);
    expect(await port.read(bob, hex(sdk), 0)).toBeNull();
    expect(await port.read(foreignWorkspace, hex(sdk), 0)).toBeNull();
    expect(await port.read(alice, "f".repeat(32), 0)).toBeNull();
    expect(await port.status(bob, hex(sdk))).toBeNull();
  });

  it("a final response for a DIFFERENT request id does not finish the stream", async () => {
    const { port, alice } = await setup();
    let finished = 0;
    const store = new RequestEventStore(port, alice, "7", "2025-11-25", () => { finished += 1; });
    const sdk = sdkStreamId();
    await store.storeEvent(sdk, {} as never);
    await store.storeEvent(sdk, result(8) as never);
    expect(finished).toBe(0);
    expect(await port.status(alice, hex(sdk))).toBe("open");
  });

  it("is bounded per stream", async () => {
    const { db, alice } = await setup();
    const key = principalKeyOf(alice);
    const id = hex(sdkStreamId());
    await repos.mcpStreams.openStream(db, { workspaceId: alice.workspaceId, streamId: id, principalKey: key, requestId: "1", protocolVersion: "2025-11-25" });
    for (let n = 0; n < repos.mcpStreams.MCP_STREAM_MAX_EVENTS; n += 1) await repos.mcpStreams.appendStreamEvent(db, { workspaceId: alice.workspaceId, streamId: id, principalKey: key, payload: { n } });
    await expect(repos.mcpStreams.appendStreamEvent(db, { workspaceId: alice.workspaceId, streamId: id, principalKey: key, payload: { n: -1 } })).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses to append to another principal's or workspace's stream", async () => {
    const { db, alice, bob, foreignWorkspace } = await setup();
    const id = hex(sdkStreamId());
    await repos.mcpStreams.openStream(db, { workspaceId: alice.workspaceId, streamId: id, principalKey: principalKeyOf(alice), requestId: "1", protocolVersion: "2025-11-25" });
    for (const who of [bob, foreignWorkspace]) {
      await expect(repos.mcpStreams.appendStreamEvent(db, { workspaceId: who.workspaceId, streamId: id, principalKey: principalKeyOf(who), payload: {} })).rejects.toMatchObject({ code: "conflict" });
    }
  });

  it("expired streams are not readable and are removed when the workspace opens the next one", async () => {
    const { db, port, alice } = await setup();
    const key = principalKeyOf(alice);
    const old = hex(sdkStreamId());
    await repos.mcpStreams.openStream(db, { workspaceId: alice.workspaceId, streamId: old, principalKey: key, requestId: "1", protocolVersion: "2025-11-25" });
    await db.query("update platform.mcp_streams set expires_at = clock_timestamp() - interval '1 second' where id=$1", [old]);
    expect(await port.read(alice, old, 0)).toBeNull();
    await repos.mcpStreams.openStream(db, { workspaceId: alice.workspaceId, streamId: hex(sdkStreamId()), principalKey: key, requestId: "2", protocolVersion: "2025-11-25" });
    expect(await db.query("select id from platform.mcp_streams where id=$1", [old])).toHaveLength(0);
  });
});

describe("resumeStream", () => {
  const text = async (response: Response) => await response.text();

  it("replays events after Last-Event-ID, in order, and ends after the result", async () => {
    const { port, alice } = await setup();
    const store = new RequestEventStore(port, alice, "7", "2025-11-25", () => undefined);
    const sdk = sdkStreamId();
    await store.storeEvent(sdk, {} as never);
    await store.storeEvent(sdk, progress(1) as never);
    await store.storeEvent(sdk, result(7) as never);
    const response = (await resumeStream(port, alice, eventIdOf(hex(sdk), 1), new AbortController().signal))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const body = await text(response);
    expect(body).toContain(`id: ${eventIdOf(hex(sdk), 2)}\n`);
    expect(body).toContain(`id: ${eventIdOf(hex(sdk), 3)}\n`);
    expect(body).not.toContain(`id: ${eventIdOf(hex(sdk), 1)}\n`);
    expect(body.indexOf("notifications/progress")).toBeLessThan(body.indexOf('"result"'));
  });

  it("resuming from the final event of a finished stream ends immediately with nothing", async () => {
    const { port, alice } = await setup();
    const store = new RequestEventStore(port, alice, "7", "2025-11-25", () => undefined);
    const sdk = sdkStreamId();
    await store.storeEvent(sdk, {} as never);
    await store.storeEvent(sdk, result(7) as never);
    const started = Date.now();
    const body = await text((await resumeStream(port, alice, eventIdOf(hex(sdk), 2), new AbortController().signal, { followMs: 10_000 }))!);
    expect(body).not.toContain("data:");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("follows a still-running request and delivers the result when it lands", async () => {
    const { port, alice } = await setup();
    const store = new RequestEventStore(port, alice, "7", "2025-11-25", () => undefined);
    const sdk = sdkStreamId();
    await store.storeEvent(sdk, {} as never);
    const pending = resumeStream(port, alice, eventIdOf(hex(sdk), 1), new AbortController().signal, { pollMs: 25, followMs: 10_000 }).then((r) => text(r!));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await store.storeEvent(sdk, progress(1) as never);
    await store.storeEvent(sdk, result(7) as never);
    const body = await pending;
    expect(body).toContain("notifications/progress");
    expect(body).toContain('"result"');
  });

  it("returns null (the caller answers 404) for unknown, foreign, malformed and cross-workspace ids", async () => {
    const { port, alice, bob, foreignWorkspace } = await setup();
    const store = new RequestEventStore(port, alice, "7", "2025-11-25", () => undefined);
    const sdk = sdkStreamId();
    await store.storeEvent(sdk, {} as never);
    const signal = new AbortController().signal;
    expect(await resumeStream(port, bob, eventIdOf(hex(sdk), 1), signal)).toBeNull();
    expect(await resumeStream(port, foreignWorkspace, eventIdOf(hex(sdk), 1), signal)).toBeNull();
    expect(await resumeStream(port, alice, eventIdOf("0".repeat(32), 1), signal)).toBeNull();
    expect(await resumeStream(port, alice, "garbage", signal)).toBeNull();
    expect(await resumeStream(port, alice, null, signal)).toBeNull();
  });
});

describe("durable and in-process cancellation", () => {
  it("a cancel recorded by another instance reaches the in-flight request through the database", async () => {
    const { db, port, alice, bob, foreignWorkspace } = await setup();
    const store = new RequestEventStore(port, alice, "9", "2025-11-25", () => undefined);
    const sdk = sdkStreamId();
    await store.storeEvent(sdk, {} as never);
    const controller = new AbortController();
    const stop = watchDurableCancel(port, alice, () => store.durableStreamId, controller, 20);
    expect(await port.requestCancel(bob, "9")).toBe(0); // another principal cannot cancel it
    expect(await port.requestCancel(alice, "10")).toBe(0); // another request id neither
    expect(await port.requestCancel(alice, "9")).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    stop();
    expect(controller.signal.aborted).toBe(true);
    expect(await port.cancelRequested(alice, hex(sdk))).toBe(true);
    expect(await port.requestCancel(alice, "9")).toBe(0); // idempotent
    // the flag is invisible from another workspace even with the exact stream id
    expect(await repos.mcpStreams.streamCancelRequested(db, { workspaceId: foreignWorkspace.workspaceId, streamId: hex(sdk) })).toBe(false);
    expect(await repos.mcpStreams.streamCancelRequested(db, { workspaceId: alice.workspaceId, streamId: hex(sdk) })).toBe(true);
  });

  it("in-process flights are keyed by principal and request id", () => {
    const alice = { subject: "a", integrationId: "c", workspaceId: "w" } as AgentIdentity;
    const mallory = { subject: "m", integrationId: "x", workspaceId: "w" } as AgentIdentity;
    const flight = registerFlight(alice, "5");
    expect(cancelFlights(mallory, "5", new Error("no"))).toBe(0);
    expect(flight.controller.signal.aborted).toBe(false);
    expect(cancelFlights(alice, "5", new Error("stop"))).toBe(1);
    expect(flight.controller.signal.aborted).toBe(true);
    flight.done();
    expect(cancelFlights(alice, "5", new Error("again"))).toBe(0);
  });
});
