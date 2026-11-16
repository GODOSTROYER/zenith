/** Polling is bounded per page and stops at terminal state or interruption. */
import { afterEach, describe, expect, it } from "vitest";
import { fixture, invoke, operation, reply } from "./support";

const servers: Awaited<ReturnType<typeof fixture>>[] = [];
async function start(...args: Parameters<typeof fixture>) { const server = await fixture(...args); servers.push(server); return server; }
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
const event = (seq: number) => ({ seq, id: `event-${seq}`, type: "operation.status", ts: "2026-10-01T00:00:00Z", data: { message: `fixture-${seq}` } });

describe("events --follow", () => {
  it("pages full batches, advances afterSeq, drains terminal events and emits JSON Lines", async () => {
    let reads = 0;
    const server = await start((req, res) => {
      if (req.url.includes("/events")) {
        reads++;
        reply(res, { events: reads === 1 ? [event(1), event(2)] : reads === 2 ? [event(3)] : reads === 3 ? [event(4)] : [] });
      } else reply(res, { operation: { ...operation, status: "succeeded" }, approvals: [] });
    });
    const result = await invoke(server.url, ["ops", "events", "op-cli", "--follow", "--limit", "2", "--json"]);
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.flatMap((line) => line.events.map((entry: { seq: number }) => entry.seq))).toEqual([1, 2, 3, 4]);
    expect(server.requests.filter((req) => req.url.includes("/events")).map((req) => new URL(req.url, server.url).searchParams.get("afterSeq"))).toEqual(["0", "2", "3"]);
  });

  it("aborts a poll delay promptly with exit 130", async () => {
    const controller = new AbortController();
    const server = await start((req, res) => {
      if (req.url.includes("/events")) reply(res, { events: [] });
      else { reply(res, { operation: { ...operation, status: "running" }, approvals: [] }); setTimeout(() => controller.abort(), 30); }
    });
    const started = Date.now();
    const result = await invoke(server.url, ["ops", "events", "op-cli", "--follow", "--poll-interval", "60000", "--json"], "", { signal: controller.signal });
    expect(result.code).toBe(130); expect(Date.now() - started).toBeLessThan(2000); expect(JSON.parse(result.stderr).error.code).toBe("interrupted");
  });

  it("aborts a stalled HTTP body and stops all requests", async () => {
    const controller = new AbortController();
    const server = await start((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"events":['); setTimeout(() => controller.abort(), 30); });
    const result = await invoke(server.url, ["ops", "events", "op-cli", "--follow", "--json"], "", { signal: controller.signal });
    expect(result.code).toBe(130); expect(server.requests).toHaveLength(1);
  });

  it.each(["uncertain", "failed", "cancelled", "denied", "expired", "rejected"])("stops after %s without claiming success", async (status) => {
    const server = await start((req, res) => req.url.includes("/events") ? reply(res, { events: [] }) : reply(res, { operation: { ...operation, status }, approvals: [] }));
    const result = await invoke(server.url, ["ops", "events", "op-cli", "--follow", "--json"]);
    expect(result.code).toBe(0); expect(server.requests).toHaveLength(3); expect(result.stdout).toBe("");
  });

  it("refuses stale or duplicate sequence numbers instead of looping forever", async () => {
    const server = await start((req, res) => req.url.includes("/events") ? reply(res, { events: [event(1), event(1)] }) : reply(res, { operation, approvals: [] }));
    const result = await invoke(server.url, ["ops", "events", "op-cli", "--follow", "--json"]);
    expect(result.code).toBe(6); expect(JSON.parse(result.stderr).error.code).toBe("invalid_response"); expect(server.requests).toHaveLength(1);
  });
});
