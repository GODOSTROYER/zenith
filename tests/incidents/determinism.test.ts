/**
 * Determinism and orchestration: the same inputs give the same Investigation,
 * whatever order the ports answer in; concurrency is bounded; every port is
 * called at most once per subject.
 */
import { describe, expect, it } from "vitest";
import { investigate } from "@/lib/incidents";
import type { NormalizedLog } from "@/lib/observability/types";
import { ADDR, ENV, NOW, PROJECT, WORKSPACE, buildGraph, change, driftFinding, driftReport, healthyWorld, log, makePorts, newCalls, removeDbIngress, withCache, type World } from "./fixtures";

const env = { workspaceId: WORKSPACE, projectId: PROJECT, environmentId: ENV };
const go = (world: World, opts: { concurrency?: number; calls?: ReturnType<typeof newCalls>; newId?: () => string } = {}) =>
  investigate({ graph: withCache(buildGraph()), environment: env, symptom: "503s" }, makePorts(world, opts.calls, { newId: opts.newId }), opts.concurrency ? { concurrency: opts.concurrency } : {});

function busyWorld(): World {
  const w = removeDbIngress(healthyWorld());
  w.changes = [change("deployment", 40, "release 1.4.9", "op_a"), change("config", 20, "flag flip", "op_b")];
  w.logs[ADDR.web] = [
    ...(w.logs[ADDR.web] as NormalizedLog[]),
    log(ADDR.web, "KeyError: 'FLAG_X'", 9),
    log(ADDR.web, "java.lang.OutOfMemoryError: Java heap space", 8),
  ];
  w.drift = driftReport([driftFinding(ADDR.fwWebDb, "missing"), driftFinding(ADDR.fwLbWeb, "changed")]);
  return w;
}

describe("determinism", () => {
  it("the same inputs give the same Investigation, field for field", async () => {
    const a = await go(busyWorld());
    const b = await go(busyWorld());
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("port latency and arrival order do not change the result", async () => {
    const baseline = await go(busyWorld());
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 4; i++) {
      const w = busyWorld();
      w.latency = () => Math.floor(rand() * 12);
      expect(await go(w)).toEqual(baseline);
    }
  });

  it("the order a backend returns logs, changes and metrics in does not change the result", async () => {
    const baseline = await go(busyWorld());
    const w = busyWorld();
    w.logs[ADDR.web] = [...(w.logs[ADDR.web] as never[])].reverse();
    w.changes = [...(w.changes as never[])].reverse();
    w.drift = driftReport([...(w.drift as never as { findings: never[] }).findings].reverse());
    expect(await go(w)).toEqual(baseline);
  });

  it("concurrency changes nothing but speed", async () => {
    const baseline = await go(busyWorld());
    for (const concurrency of [1, 2, 8]) expect(await go(busyWorld(), { concurrency })).toEqual(baseline);
  });

  it("only the id and the timestamps come from the injected id generator and clock", async () => {
    const a = await go(busyWorld(), { newId: () => "inv_aaa" });
    const b = await go(busyWorld(), { newId: () => "inv_bbb" });
    expect(a.id).toBe("inv_aaa");
    expect(b.id).toBe("inv_bbb");
    // the id is also quoted in each proposal's reason, and nowhere else
    const strip = (s: string) => s.replaceAll("inv_aaa", "ID").replaceAll("inv_bbb", "ID");
    expect(JSON.parse(strip(JSON.stringify(a)))).toEqual(JSON.parse(strip(JSON.stringify(b))));
    expect(a.startedAt).toBe(NOW.toISOString());
    expect(a.finishedAt).toBe(NOW.toISOString());
  });

  it("without an injected generator the id is a digest of the environment, the start time and the entry", async () => {
    const ports = makePorts(healthyWorld());
    delete (ports as { newId?: unknown }).newId;
    const a = await investigate({ graph: buildGraph(), environment: env }, ports);
    const b = await investigate({ graph: buildGraph(), environment: env }, ports);
    const other = await investigate({ graph: buildGraph(), environment: env, entry: ADDR.web }, ports);
    expect(a.id).toMatch(/^inv_[0-9a-f]{20}$/);
    expect(b.id).toBe(a.id);
    expect(other.id).not.toBe(a.id);
  });

  it("is plain JSON: a round trip changes nothing", async () => {
    const inv = await go(busyWorld());
    expect(JSON.parse(JSON.stringify(inv))).toEqual(inv);
  });
});

describe("orchestration", () => {
  it("never has more than 4 port calls in flight by default, and honours a lower bound", async () => {
    const slow = () => {
      const w = busyWorld();
      w.latency = () => 8;
      return w;
    };
    const calls = newCalls();
    await go(slow(), { calls });
    expect(calls.maxInFlight).toBeGreaterThan(1);
    expect(calls.maxInFlight).toBeLessThanOrEqual(4);

    const serial = newCalls();
    await go(slow(), { calls: serial, concurrency: 1 });
    expect(serial.maxInFlight).toBe(1);

    const wide = newCalls();
    await go(slow(), { calls: wide, concurrency: 1000 });
    expect(wide.maxInFlight).toBeLessThanOrEqual(8); // capped at 8 whatever is asked
  });

  it("asks each port once per subject: observations, runtimes and log searches are shared between probes", async () => {
    const calls = newCalls();
    await go(busyWorld(), { calls });
    expect(new Set(calls.observe).size).toBe(calls.observe.length);
    expect(new Set(calls.runtime).size).toBe(calls.runtime.length);
    const logAddresses = calls.searchLogs.map((q) => q.scope.addresses?.[0]);
    expect(new Set(logAddresses).size).toBe(logAddresses.length);
    expect(logAddresses).toEqual([ADDR.web]);
    expect(calls.queryMetrics.map((q) => q.scope.addresses?.[0]).sort()).toEqual([ADDR.lb, ADDR.web].sort());
  });

  it("evidence follows the path order: an earlier hop's evidence never comes after a later hop's", async () => {
    const inv = await go(busyWorld());
    const pathKeys = inv.path.filter((p) => p.address).map((p) => `${p.hop}:${p.address}`);
    const position = (e: { hop: string; address?: string }) => pathKeys.indexOf(`${e.hop}:${e.address}`);
    const located = inv.evidence.filter((e) => position(e) >= 0).map(position);
    expect(located).toEqual([...located].sort((a, b) => a - b));
  });

  it("evidence ids are unique and derived from the check and the address", async () => {
    const inv = await go(busyWorld());
    const ids = inv.evidence.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of inv.evidence) expect(e.id.startsWith(`ev:${e.check}:`)).toBe(true);
  });

  it("every evidence id cited by a hypothesis, and every path status, refers to real data", async () => {
    const inv = await go(busyWorld());
    const ids = new Set(inv.evidence.map((e) => e.id));
    for (const h of inv.hypotheses) for (const id of [...h.supportingEvidence, ...h.contradictingEvidence, ...(h.basis ?? []).flatMap((b) => b.evidence)]) expect(ids.has(id), id).toBe(true);
    expect(inv.path.length).toBeGreaterThan(10);
    for (const p of inv.path) expect(["healthy", "failing", "unknown"]).toContain(p.status);
  });

  it("every evidence record is bounded: short finding, few keys, short strings", async () => {
    const inv = await go(busyWorld());
    for (const e of inv.evidence) {
      expect(e.finding.length).toBeLessThanOrEqual(400);
      expect(Object.keys(e.data).length).toBeLessThanOrEqual(24);
      expect(JSON.stringify(e.data).length).toBeLessThan(6000);
      expect(Number.isNaN(Date.parse(e.observedAt))).toBe(false);
    }
  });
});
