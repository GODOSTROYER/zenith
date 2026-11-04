import { describe, expect, it, vi } from "vitest";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { ObservabilityInputError } from "@/lib/observability/query";
import type { LogQuery, MetricSeries, NormalizedEvent, NormalizedLog, ObservabilitySource, Severity, TraceSpanSummary } from "@/lib/observability/types";
import { CANARY, ENV, WS, fakeSource, result, scope } from "./_fixtures";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const now = () => new Date(NOW);
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const range = (minutes = 120) => ({ from: iso(minutes), to: iso(0) });
const logQuery = (over: Partial<LogQuery> = {}): LogQuery => ({ scope: scope(), range: range(), ...over });

function logAt(minAgo: number, message = "m", over: Partial<NormalizedLog> = {}): NormalizedLog {
  return { timestamp: iso(minAgo), provider: "fake", environmentId: ENV, severity: "info", message, attributes: {}, native: {}, ...over };
}

function eventAt(minAgo: number, message = "e", over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return { timestamp: iso(minAgo), provider: "fake", environmentId: ENV, severity: "info", type: "t", message, native: {}, ...over };
}

const logSource = (id: string, logs: NormalizedLog[], over: Partial<ObservabilitySource> = {}): ObservabilitySource =>
  fakeSource(id, { supports: ["log"], searchLogs: async () => result(logs, { sources: [id] }), ...over });

const fabricOf = (sources: ObservabilitySource[], timeoutMs = 10_000) => createObservabilityFabric(sources, { now, timeoutMs });

describe("fan-out and merge", () => {
  it("merges logs from several sources, newest first, and names every contributing source", async () => {
    const a = logSource("a", [logAt(10, "a10"), logAt(30, "a30")]);
    const b = logSource("b", [logAt(20, "b20"), logAt(5, "b5")]);
    const r = await fabricOf([a, b]).searchLogs(logQuery());
    expect(r.items.map((l) => l.message)).toEqual(["b5", "a10", "b20", "a30"]);
    expect(r.sources).toEqual(["a", "b"]);
    expect(r.unavailable).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.simulated).toBe(false);
  });

  it("is stable: equal timestamps keep source order, then within-source order", async () => {
    const a = logSource("a", [logAt(10, "a1"), logAt(10, "a2")]);
    const b = logSource("b", [logAt(10, "b1")]);
    const r = await fabricOf([a, b]).searchLogs(logQuery());
    expect(r.items.map((l) => l.message)).toEqual(["a1", "a2", "b1"]);
  });

  it("enforces the default limit of 200 and reports truncation", async () => {
    const many = Array.from({ length: 350 }, (_, i) => logAt(i / 4, `m${i}`));
    const r = await fabricOf([logSource("a", many)]).searchLogs(logQuery());
    expect(r.items).toHaveLength(200);
    expect(r.truncated).toBe(true);
    expect(r.items[0].message).toBe("m0");
  });

  it("caps a requested limit at 1000", async () => {
    const seen: number[] = [];
    const many = Array.from({ length: 1500 }, (_, i) => logAt(i / 20, `m${i}`));
    const src = fakeSource("a", {
      supports: ["log"],
      searchLogs: async (q) => {
        seen.push(q.limit ?? -1);
        return result(many, { sources: ["a"] });
      },
    });
    const r = await fabricOf([src]).searchLogs(logQuery({ limit: 50_000 }));
    expect(seen).toEqual([1000]);
    expect(r.items).toHaveLength(1000);
    expect(r.truncated).toBe(true);
  });

  it("honours a smaller limit and passes the validated query to sources", async () => {
    let received: LogQuery | undefined;
    const src = fakeSource("a", {
      supports: ["log"],
      searchLogs: async (q) => {
        received = q;
        return result([logAt(1), logAt(2), logAt(3)], { sources: ["a"] });
      },
    });
    const r = await fabricOf([src]).searchLogs(logQuery({ limit: 2, text: "boom", scope: scope({ addresses: ["service/web", "service/api"] }) }));
    expect(r.items).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(received?.limit).toBe(2);
    expect(received?.text).toBe("boom");
    expect(received?.range.to).toBeDefined();
    expect(received?.scope.addresses).toEqual(["service/api", "service/web"]);
  });

  it("propagates a source's own truncation flag", async () => {
    const r = await fabricOf([fakeSource("a", { supports: ["log"], searchLogs: async () => result([logAt(1)], { sources: ["a"], truncated: true }) })]).searchLogs(logQuery());
    expect(r.truncated).toBe(true);
  });

  it("only calls sources that support the signal and cover the scope", async () => {
    const calls: string[] = [];
    const mk = (id: string, over: Partial<ObservabilitySource>) =>
      fakeSource(id, {
        searchLogs: async () => {
          calls.push(id);
          return result([logAt(1, id)], { sources: [id] });
        },
        ...over,
      });
    const r = await fabricOf([
      mk("logs-ok", { supports: ["log"] }),
      mk("metrics-only", { supports: ["metric"] }),
      mk("wrong-scope", { supports: ["log"], covers: () => false }),
      mk("right-scope", { supports: ["log"], covers: (s) => s.environmentId === ENV }),
    ]).searchLogs(logQuery());
    expect(calls.sort()).toEqual(["logs-ok", "right-scope"]);
    expect(r.items.map((l) => l.message).sort()).toEqual(["logs-ok", "right-scope"]);
  });

  it("says so when no source can answer, instead of returning silence", async () => {
    const r = await fabricOf([]).searchLogs(logQuery());
    expect(r.items).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(r.unavailable).toEqual([{ source: "fabric", reason: expect.stringContaining("no observability source supports log") }]);
  });

  it("rejects duplicate source ids", () => {
    expect(() => createObservabilityFabric([fakeSource("x"), fakeSource("x")])).toThrow(/Duplicate/);
  });

  it("a source that claims to support a signal but lacks the method is unavailable, not a crash", async () => {
    const r = await fabricOf([fakeSource("half", { supports: ["log"] }), logSource("ok", [logAt(1)])]).searchLogs(logQuery());
    expect(r.items).toHaveLength(1);
    expect(r.unavailable[0]).toEqual({ source: "half", reason: expect.stringContaining("does not implement") });
  });

  it("merges unavailable entries and notes reported by sources", async () => {
    const a = fakeSource("a", {
      supports: ["log"],
      searchLogs: async () => result([logAt(1)], { sources: ["a"], unavailable: [{ source: "a", reason: "group X denied" }], notes: ["searched back to T"] }),
    });
    const r = await fabricOf([a]).searchLogs(logQuery());
    expect(r.unavailable).toEqual([{ source: "a", reason: "group X denied" }]);
    expect(r.notes).toEqual(["searched back to T"]);
  });
});

describe("partial answers", () => {
  it("a slow source becomes an unavailable entry and the others are still returned", async () => {
    const hung = fakeSource("hung", { supports: ["log"], searchLogs: () => new Promise(() => undefined) });
    const fast = logSource("fast", [logAt(1, "fast")]);
    const t0 = Date.now();
    const r = await fabricOf([hung, fast], 60).searchLogs(logQuery());
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.items.map((l) => l.message)).toEqual(["fast"]);
    expect(r.sources).toEqual(["fast"]);
    expect(r.unavailable).toEqual([{ source: "hung", reason: "timed out after 60 ms" }]);
  });

  it("aborts the signal handed to a source that times out", async () => {
    let seen: AbortSignal | undefined;
    const slow = fakeSource("slow", {
      supports: ["log"],
      searchLogs: (_q, signal) => {
        seen = signal;
        return new Promise(() => undefined);
      },
    });
    await fabricOf([slow], 40).searchLogs(logQuery());
    expect(seen?.aborted).toBe(true);
  });

  it("a source that throws or rejects is unavailable with a redacted, bounded reason", async () => {
    const boom = fakeSource("boom", {
      supports: ["log"],
      searchLogs: async () => {
        throw new Error(`AccessDenied: ${CANARY.awsKeyId} password=${CANARY.password} ${"x".repeat(3000)}`);
      },
    });
    const sync = fakeSource("sync", {
      supports: ["log"],
      searchLogs: () => {
        throw new TypeError("sync failure");
      },
    });
    const r = await fabricOf([boom, sync, logSource("ok", [logAt(1)])]).searchLogs(logQuery());
    expect(r.items).toHaveLength(1);
    expect(r.unavailable.map((u) => u.source).sort()).toEqual(["boom", "sync"]);
    const text = JSON.stringify(r.unavailable);
    expect(text).not.toContain(CANARY.awsKeyId);
    expect(text).not.toContain(CANARY.password);
    expect(text).toContain("TypeError: sync failure");
    for (const u of r.unavailable) expect(Buffer.byteLength(u.reason, "utf8")).toBeLessThanOrEqual(512);
  });

  it("a throwing covers() is reported, not fatal", async () => {
    const bad = fakeSource("bad", {
      supports: ["log"],
      covers: () => {
        throw new Error("no graph");
      },
    });
    const r = await fabricOf([bad, logSource("ok", [logAt(1)])]).searchLogs(logQuery());
    expect(r.items).toHaveLength(1);
    expect(r.unavailable[0].source).toBe("bad");
  });

  it("all sources failing still resolves (never throws) with everything unavailable", async () => {
    const fail = (id: string) =>
      fakeSource(id, {
        supports: ["log"],
        searchLogs: async () => {
          throw new Error("down");
        },
      });
    const r = await fabricOf([fail("a"), fail("b")]).searchLogs(logQuery());
    expect(r.items).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(r.unavailable).toHaveLength(2);
  });

  it("does not list a source that answered nothing but reported failures", async () => {
    const src = fakeSource("cw", {
      supports: ["log"],
      searchLogs: async () => result([], { unavailable: [{ source: "cw", reason: "log group missing" }] }),
    });
    const r = await fabricOf([src]).searchLogs(logQuery());
    expect(r.sources).toEqual([]);
  });

  it("lists a source that names nothing and reported no failure as itself", async () => {
    const src = fakeSource("quiet", { supports: ["log"], searchLogs: async () => result([logAt(1)]) });
    expect((await fabricOf([src]).searchLogs(logQuery())).sources).toEqual(["quiet"]);
  });
});

describe("simulated propagation", () => {
  it("is true when any contributing source is simulated, false otherwise", async () => {
    const real = logSource("real", [logAt(1)]);
    const sim = fakeSource("sim", { supports: ["log"], searchLogs: async () => result([logAt(2)], { sources: ["sim"], simulated: true }) });
    expect((await fabricOf([real]).searchLogs(logQuery())).simulated).toBe(false);
    expect((await fabricOf([real, sim]).searchLogs(logQuery())).simulated).toBe(true);
    expect((await fabricOf([sim]).searchLogs(logQuery())).simulated).toBe(true);
  });

  it("a simulated source that failed does not label the answer simulated", async () => {
    const sim = fakeSource("sim", {
      supports: ["log"],
      searchLogs: async () => {
        throw new Error("down");
      },
    });
    const r = await fabricOf([logSource("real", [logAt(1)]), sim]).searchLogs(logQuery());
    expect(r.simulated).toBe(false);
  });
});

describe("defensive post-processing", () => {
  it("redacts and bounds items even when a source forgot to", async () => {
    const leaky = logAt(1, `db password=${CANARY.password} key ${CANARY.awsKeyId} ${"z".repeat(9000)}`, { native: { header: `Bearer ${CANARY.bearer}` } });
    const r = await fabricOf([logSource("leaky", [leaky])]).searchLogs(logQuery());
    const json = JSON.stringify(r);
    expect(json).not.toContain(CANARY.password);
    expect(json).not.toContain(CANARY.awsKeyId);
    expect(json).not.toContain(CANARY.bearer);
    expect(r.items[0].attributes.redacted).toBe(true);
    expect(Buffer.byteLength(r.items[0].message, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("drops items from another environment", async () => {
    const r = await fabricOf([logSource("a", [logAt(1, "mine"), logAt(2, "theirs", { environmentId: "env-other" })])]).searchLogs(logQuery());
    expect(r.items.map((l) => l.message)).toEqual(["mine"]);
  });

  it("when the scope names addresses, drops items from other addresses but keeps unaddressed ones", async () => {
    const src = logSource("a", [logAt(1, "web", { address: "service/web" }), logAt(2, "db", { address: "resource/db" }), logAt(3, "none")]);
    const r = await fabricOf([src]).searchLogs(logQuery({ scope: scope({ addresses: ["service/web"] }) }));
    expect(r.items.map((l) => l.message)).toEqual(["web", "none"]);
  });

  it("drops items outside the requested range", async () => {
    const src = logSource("a", [logAt(10, "in"), logAt(500, "too-old"), logAt(-30, "future")]);
    const r = await fabricOf([src]).searchLogs(logQuery());
    expect(r.items.map((l) => l.message)).toEqual(["in"]);
  });

  it("applies minSeverity centrally and says unknown-severity lines are excluded", async () => {
    const sev = (s: Severity, m: string) => logAt(1, m, { severity: s });
    const src = logSource("a", [sev("info", "i"), sev("warn", "w"), sev("error", "e"), sev("unknown", "u")]);
    const r = await fabricOf([src]).searchLogs(logQuery({ minSeverity: "warn" }));
    expect(r.items.map((l) => l.message).sort()).toEqual(["e", "w"]);
    expect(r.notes?.join(" ")).toMatch(/severity could not be determined/);
    expect((await fabricOf([src]).searchLogs(logQuery())).notes).toBeUndefined();
  });

  it("sorts events newest first and applies the same bounds", async () => {
    const src = fakeSource("ev", {
      supports: ["event"],
      searchEvents: async () => result([eventAt(30, "old"), eventAt(5, "new"), eventAt(1, "gone", { environmentId: "env-x" }), eventAt(10, `pw password=${CANARY.password}`)], { sources: ["ev"] }),
    });
    const r = await fabricOf([src]).searchEvents({ scope: scope(), range: range() });
    expect(r.items.map((e) => e.message.slice(0, 3))).toEqual(["new", "pw ", "old"]);
    expect(JSON.stringify(r)).not.toContain(CANARY.password);
  });

  it("sorts traces newest first and sanitizes them", async () => {
    const trace = (minAgo: number, name: string): TraceSpanSummary => ({ traceId: `t${minAgo}`, rootName: name, durationMs: 5, status: "ok", startedAt: iso(minAgo), native: { k: CANARY.awsKeyId } });
    const src = fakeSource("tr", { supports: ["trace"], searchTraces: async () => result([trace(10, "old"), trace(1, `GET password=${CANARY.password}`)], { sources: ["tr"] }) });
    const r = await fabricOf([src]).searchTraces({ scope: scope(), range: range() });
    expect(r.items.map((t) => t.traceId)).toEqual(["t1", "t10"]);
    expect(JSON.stringify(r)).not.toContain(CANARY.password);
    expect(JSON.stringify(r)).not.toContain(CANARY.awsKeyId);
  });
});

describe("metrics", () => {
  const series = (metric: string, n = 3): MetricSeries => ({
    metric,
    unit: "Count",
    provider: "fake",
    native: { k: "v" },
    points: Array.from({ length: n }, (_, i) => ({ timestamp: iso(n - i), value: i })),
  });

  it("passes the requested metric names and a bounded step to sources", async () => {
    let seen: { metrics: string[]; stepSec?: number } | undefined;
    const src = fakeSource("m", {
      supports: ["metric"],
      queryMetrics: async (q) => {
        seen = { metrics: q.metrics, stepSec: q.stepSec };
        return result([series("cpu.utilization")], { sources: ["m"] });
      },
    });
    const r = await fabricOf([src]).queryMetrics({ scope: scope(), range: range(60), metrics: ["cpu.utilization", "cpu.utilization", "db.cpu"] });
    expect(seen).toEqual({ metrics: ["cpu.utilization", "db.cpu"], stepSec: 60 });
    expect(r.items).toHaveLength(1);
  });

  it("caps series at 50 and flags truncation", async () => {
    const many = Array.from({ length: 80 }, (_, i) => series(`m${i}`));
    const r = await fabricOf([fakeSource("m", { supports: ["metric"], queryMetrics: async () => result(many, { sources: ["m"] }) })]).queryMetrics({
      scope: scope(),
      range: range(60),
      metrics: ["cpu.utilization"],
    });
    expect(r.items).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it("drops non-finite points and caps points per series", async () => {
    const s = series("cpu.utilization", 2000);
    s.points[0] = { timestamp: iso(1), value: Number.NaN };
    const r = await fabricOf([fakeSource("m", { supports: ["metric"], queryMetrics: async () => result([s], { sources: ["m"] }) })]).queryMetrics({
      scope: scope(),
      range: range(60),
      metrics: ["cpu.utilization"],
    });
    expect(r.items[0].points.length).toBeLessThanOrEqual(1440);
    expect(r.items[0].points.every((p) => Number.isFinite(p.value))).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.notes?.join()).toMatch(/1440/);
  });
});

describe("validation", () => {
  it("throws ObservabilityInputError for a malformed query, before touching any source", async () => {
    const spy = vi.fn(async () => result([]));
    const fabric = fabricOf([fakeSource("a", { supports: ["log"], searchLogs: spy })]);
    await expect(fabric.searchLogs({ scope: scope(), range: { from: iso(0), to: iso(60) } })).rejects.toBeInstanceOf(ObservabilityInputError);
    await expect(fabric.searchLogs({ scope: scope(), range: { from: iso(60 * 24 * 8), to: iso(0) } })).rejects.toThrow(/7 days/);
    await expect(fabric.searchLogs({ scope: scope(), range: { from: new Date(NOW + 3_600_000).toISOString() } })).rejects.toThrow(/future/);
    await expect(fabric.searchLogs({ scope: { workspaceId: WS } as never, range: range() })).rejects.toBeInstanceOf(ObservabilityInputError);
    await expect(fabric.queryMetrics({ scope: scope(), range: range(), metrics: [] })).rejects.toBeInstanceOf(ObservabilityInputError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("cancellation", () => {
  it("a caller abort rejects with the abort reason and cancels every in-flight source", async () => {
    const signals: AbortSignal[] = [];
    const hang = (id: string) =>
      fakeSource(id, {
        supports: ["log"],
        searchLogs: (_q, signal) => {
          signals.push(signal);
          return new Promise(() => undefined);
        },
      });
    const ctl = new AbortController();
    const pending = fabricOf([hang("a"), hang("b")]).searchLogs(logQuery(), ctl.signal);
    setTimeout(() => ctl.abort(new DOMException("stop", "AbortError")), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("an already-aborted signal rejects without calling any source", async () => {
    const spy = vi.fn(async () => result([]));
    const ctl = new AbortController();
    ctl.abort();
    await expect(fabricOf([fakeSource("a", { supports: ["log"], searchLogs: spy })]).searchLogs(logQuery(), ctl.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("cancellation is not reported as a source failure even when the source rejects on abort", async () => {
    const src = fakeSource("a", {
      supports: ["log"],
      searchLogs: (_q, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("source saw abort")));
        }),
    });
    const ctl = new AbortController();
    const pending = fabricOf([src, logSource("ok", [logAt(1)])]).searchLogs(logQuery(), ctl.signal);
    setTimeout(() => ctl.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
