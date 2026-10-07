/**
 * PROD-OPS-01: the exported Prometheus rules stay in step with the definition file and the metric catalog, the
 * runbook headings the alerts link to exist, and the two scripts do their own arithmetic correctly.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { METRIC_CATALOG } from "@/lib/ops/telemetry/catalog";
import { sloDefinitions, type RatioLike } from "@/lib/slo/definitions";
import { computeRecovery } from "@/lib/slo/recovery";
import { loadObjective, meetsObjective, parseArgs, summarize } from "../../scripts/slo/capacity-test.mjs";
import { derive } from "../../scripts/slo/report-recovery.mjs";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

interface Rule { alert?: string; record?: string; expr: string; for?: string; labels: Record<string, string>; annotations?: Record<string, string> }
const rules = JSON.parse(read("deploy/observability/alerts/zenith-slo.rules.json")) as { groups: { name: string; rules: Rule[] }[] };
const all = rules.groups.flatMap((g) => g.rules);
const alerts = all.filter((r) => r.alert);
const records = all.filter((r) => r.record);
const defs = sloDefinitions();
const runbook = read("docs/platform/operations/SLO.md");

const SLI_RULE_PREFIX: Record<string, { objective: string; label: string }> = {
  availability: { objective: "control_plane_availability", label: "Availability" },
  latency: { objective: "api_latency", label: "Latency" },
};

describe("zenith-slo.rules.json", () => {
  it("references only metrics that exist in the OPS-02 catalog", () => {
    const known = new Map(METRIC_CATALOG.map((m) => [m.name, m]));
    for (const r of all) {
      for (const name of r.expr.match(/zenith_[a-z_]+/g) ?? []) {
        const base = name.replace(/_(bucket|sum|count)$/, "");
        const entry = known.get(name) ?? (known.get(base)?.type === "histogram" ? known.get(base) : undefined);
        expect(entry, `${r.alert ?? r.record} uses unknown metric ${name}`).toBeDefined();
      }
    }
  });

  it("uses only labels the catalog declares", () => {
    const requests = METRIC_CATALOG.find((m) => m.name === "zenith_api_requests_total")!;
    expect(requests.labels).toContain("status_class");
    const duration = METRIC_CATALOG.find((m) => m.name === "zenith_api_request_duration_seconds")!;
    expect(duration.type).toBe("histogram");
    for (const r of all) for (const m of r.expr.matchAll(/\{([^}]*)\}/g)) for (const part of m[1].split(",")) {
      const label = /^\s*([a-z_]+)\s*=/.exec(part)?.[1];
      if (label && label !== "le") expect(requests.labels, `${r.alert ?? r.record}: ${label}`).toContain(label);
    }
  });

  it("the latency rule counts requests at the definition's threshold bucket", () => {
    const o = defs.objectives.find((x) => x.id === "api_latency");
    expect(o?.kind === "latency_ratio" && o.thresholdSeconds).toBe(0.5);
    expect(records.find((r) => r.record?.includes("slo_api_latency"))?.expr).toContain('le="0.5"');
  });

  it("has one alert per burn definition per SLI, and every alert says provisional", () => {
    expect(alerts.length).toBe(defs.burnAlerts.length * Object.keys(SLI_RULE_PREFIX).length);
    for (const a of alerts) {
      expect(a.labels.provisional, a.alert).toBe("true");
      expect(a.annotations?.summary, a.alert).toContain("provisional SLO, not approved");
      expect(a.annotations?.description, a.alert).toContain("DEC-BUSINESS");
      expect(["critical", "warning", "info"]).toContain(a.labels.severity);
    }
  });

  it("thresholds are exactly burn factor times the error budget of the definition's target", () => {
    for (const [slug, { objective, label }] of Object.entries(SLI_RULE_PREFIX)) {
      const o = defs.objectives.find((x) => x.id === objective) as RatioLike;
      const budget = 1 - o.target;
      for (const burn of defs.burnAlerts) {
        const name = `ZenithSlo${label}Burn${burn.name[0].toUpperCase()}${burn.name.slice(1)}`;
        const alert = alerts.find((a) => a.alert === name);
        expect(alert, `${slug} ${burn.name}`).toBeDefined();
        const expected = Math.round(burn.factor * budget * 1e6) / 1e6;
        const thresholds = [...alert!.expr.matchAll(/> ([0-9.]+)/g)].map((m) => Number(m[1]));
        expect(thresholds.slice(0, 2), name).toEqual([expected, expected]);
        expect(alert!.expr, name).toContain(`error_ratio_rate${burn.longWindow}`);
        expect(alert!.expr, name).toContain(`error_ratio_rate${burn.shortWindow}`);
        expect(alert!.labels.severity).toBe(burn.severity);
        expect(alert!.expr, name).toContain(">= 20");
      }
    }
  });

  it("every alert links to a runbook heading that exists", () => {
    for (const a of alerts) {
      const anchor = a.annotations!.runbook_url.split("#")[1];
      expect(a.annotations!.runbook_url).toContain("docs/platform/operations/SLO.md#");
      const headings = [...runbook.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9]+/g, ""));
      expect(headings, a.alert).toContain(anchor);
    }
  });

  it("every recording rule used by an alert is defined", () => {
    const defined = new Set(records.map((r) => r.record));
    for (const a of alerts) for (const used of a.expr.match(/zenith:[a-z_]+:error_ratio_rate[0-9a-z]+/g) ?? []) expect(defined.has(used), `${a.alert} -> ${used}`).toBe(true);
  });
});

describe("the guide", () => {
  it("states the provisional status and the pending decision", () => {
    expect(runbook).toContain("provisional and unapproved");
    expect(runbook).toContain("DEC-BUSINESS");
    for (const target of ["99.5%", "500 ms", "15 minutes", "4 hours"]) expect(runbook).toContain(target);
  });
});

describe("scripts/slo", () => {
  it("capacity-test.mjs summarises samples and never lets an empty run pass", () => {
    const s = summarize([{ ms: 10, ok: true }, { ms: 20, ok: true }, { ms: 30, ok: true }, { ms: 400, ok: false }], 2);
    expect(s).toMatchObject({ requests: 4, errorRate: 0.25, sustainedRps: 2, p50Ms: 20, p95Ms: 400 });
    const { objective } = loadObjective();
    expect(objective).toMatchObject({ minRequestsPerSecond: 25, maxP95Ms: 500, maxErrorRate: 0.005 });
    expect(meetsObjective(s, objective)).toBe(false);
    expect(meetsObjective({ requests: 0, sustainedRps: 0, p95Ms: null, errorRate: 1 }, objective)).toBe(false);
    expect(meetsObjective({ requests: 5000, sustainedRps: 100, p95Ms: 120, errorRate: 0 }, objective)).toBe(true);
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--concurrency", "0"])).toThrow(/between/);
    expect(parseArgs(["--concurrency", "4"]).concurrency).toBe(4);
  });

  it("capacity-test.mjs --self-test runs the generator against a local server", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/slo/capacity-test.mjs"), "--self-test"], { encoding: "utf8", timeout: 60_000 });
    expect(JSON.parse(out)).toMatchObject({ selfTest: "passed", failures: [] });
  }, 90_000);

  it("report-recovery.mjs derives RPO and RTO exactly as the server does", () => {
    const f = "2026-10-07T10:00:00Z";
    const d = "2026-10-07T09:56:30Z";
    const r = "2026-10-07T10:42:10Z";
    expect(derive(f, d, r)).toEqual({ rpoSeconds: 210, rtoSeconds: 2530 });
    expect(computeRecovery({ failureAt: new Date(f), dataRecoveredThrough: new Date(d), serviceRestoredAt: new Date(r) })).toEqual({ rpoSeconds: 210, rtoSeconds: 2530 });
    expect(() => derive(f, "2026-10-07T10:01:00Z", r)).toThrow(/cannot be after/);
    expect(() => derive(f, d, "2026-10-07T09:59:00Z")).toThrow(/cannot be before/);
  });
});
