/**
 * The shared, memoized, timeboxed view probes read the world through
 * (spec §21, ADR-0014).
 *
 * One `ProbeContext` exists per investigation. Every port call a probe makes
 * goes through it, which gives all probes the same guarantees:
 *
 *   - memoized   — two probes that need `observe(postgres/db)` cause ONE port
 *                  call; results are shared, so evidence from different hops
 *                  is derived from the same reading;
 *   - timeboxed  — each call is abandoned after `probeTimeoutMs` (the port
 *                  gets an aborted `signal`; a port that ignores it is simply
 *                  left behind, its late answer discarded);
 *   - total      — a call never throws to the probe: it yields `{ ok: false }`
 *                  with a short sanitized reason, and the probe turns that into
 *                  `unknown` evidence. Nothing is fabricated as a pass;
 *   - scoped     — answers about another address or environment are
 *                  rejected as errors: a mis-wired port cannot smuggle a
 *                  neighbour's state into this investigation.
 *
 * Text (logs and provider events) is fetched once per address and immediately
 * reduced by the signature table (`./signatures`); raw lines never leave this
 * file except as redacted, bounded excerpts inside a `SignatureHit`.
 */
import type { MetricSeries } from "@/lib/observability/types";
import type { DriftReport, Observation, ResourceGraph, ResourceNode, RuntimeState } from "@/lib/resources/types";
import type { ExpectedAttributes, InvestigationPorts, RecentChange } from "./ports";
import { MAX_EXCERPT_CHARS, sanitizeData, sanitizeFinding, sanitizeText } from "./sanitize";
import { scanText, type SignatureHit, type TextItem } from "./signatures";
import type { Evidence, Hop } from "./types";

export type Fetched<T> = { ok: true; value: T } | { ok: false; reason: "timeout" | "error"; message: string };

export interface InvestigationScope {
  workspaceId: string;
  projectId?: string;
  environmentId: string;
}

export interface ProbeConfig {
  logWindowMs: number;
  changeWindowMs: number;
  /** a deployment/apply within this long of now counts as "recent" for the bad-deploy rule */
  deploymentLookbackMs: number;
  /** cap on one probe task and on each port call inside it */
  probeTimeoutMs: number;
}

export const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  logWindowMs: 30 * 60_000,
  changeWindowMs: 6 * 60 * 60_000,
  deploymentLookbackMs: 90 * 60_000,
  probeTimeoutMs: 15_000,
};

export interface TextBundle {
  hits: SignatureHit[];
  scanned: number;
  truncated: boolean;
  /** did the log query answer (even with zero lines)? */
  logsRead: boolean;
  /** undefined when no event port exists, so nothing is claimed about events */
  eventsRead: boolean | undefined;
  /** sources that could not be queried, sanitized */
  unavailable: { source: string; reason: string }[];
  /** lines dropped because they belonged to another environment or address */
  foreign: number;
  simulated: boolean;
  sources: string[];
}

export interface ChangesBundle {
  changes: RecentChange[];
  dropped: number;
}

const errorMessage = (e: unknown): string => sanitizeText(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 160);

/** Race `work` against a timer; aborts `controller` on timeout. The timer is always cleared. */
async function timeboxed<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<Fetched<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Fetched<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: "timeout", message: `${label} did not answer within ${ms} ms` });
    }, ms);
  });
  const call = (async (): Promise<Fetched<T>> => {
    try {
      return { ok: true, value: await work(controller.signal) };
    } catch (e) {
      return { ok: false, reason: "error", message: `${label} failed: ${errorMessage(e)}` };
    }
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ProbeContext {
  readonly nowMs: number;
  readonly nowIso: string;
  private readonly nodes: Map<string, ResourceNode>;
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(
    readonly graph: ResourceGraph,
    readonly scope: InvestigationScope,
    readonly ports: InvestigationPorts,
    readonly config: ProbeConfig,
    now: Date
  ) {
    this.nowMs = now.getTime();
    this.nowIso = now.toISOString();
    this.nodes = new Map(graph.nodes.map((n) => [n.address, n]));
  }

  node(address: string): ResourceNode | undefined {
    return this.nodes.get(address);
  }

  /** Memoize by key. A `make` that throws (a port returned something malformed) becomes `{ ok: false }`, never a rejection. */
  private memo<T>(key: string, make: () => Promise<Fetched<T>>): Promise<Fetched<T>> {
    let p = this.cache.get(key) as Promise<Fetched<T>> | undefined;
    if (!p) {
      p = (async (): Promise<Fetched<T>> => {
        try {
          return await make();
        } catch (e) {
          return { ok: false, reason: "error", message: `${key.split(":")[0]} answered with something malformed: ${errorMessage(e)}` };
        }
      })();
      this.cache.set(key, p);
    }
    return p;
  }

  private logScope(address: string) {
    return { workspaceId: this.scope.workspaceId, ...(this.scope.projectId ? { projectId: this.scope.projectId } : {}), environmentId: this.scope.environmentId, addresses: [address] };
  }

  observe(address: string): Promise<Fetched<Observation>> {
    return this.memo(`observe:${address}`, async () => {
      const r = await timeboxed((signal) => this.ports.observe(address, { signal }), this.config.probeTimeoutMs, `observe(${address})`);
      if (r.ok && (r.value?.address !== address || typeof r.value.presence !== "string"))
        return { ok: false, reason: "error", message: `observe(${address}) answered for a different address or with a malformed result` };
      return r;
    });
  }

  runtime(address: string): Promise<Fetched<RuntimeState>> {
    return this.memo(`runtime:${address}`, async () => {
      const r = await timeboxed((signal) => this.ports.runtime(address, { signal }), this.config.probeTimeoutMs, `runtime(${address})`);
      if (r.ok && (r.value?.address !== address || typeof r.value.health !== "string"))
        return { ok: false, reason: "error", message: `runtime(${address}) answered for a different address or with a malformed result` };
      return r;
    });
  }

  expected(address: string): Promise<Fetched<ExpectedAttributes>> {
    return this.memo(`expected:${address}`, () => timeboxed(async () => await this.ports.expected(address), this.config.probeTimeoutMs, `expected(${address})`));
  }

  /** Logs (and events, when the port exists) for one address, reduced to signature hits. */
  text(address: string): Promise<Fetched<TextBundle>> {
    return this.memo(`text:${address}`, async () => {
      const range = { from: new Date(this.nowMs - this.config.logWindowMs).toISOString(), to: this.nowIso };
      const scope = this.logScope(address);
      const items: TextItem[] = [];
      const unavailable: { source: string; reason: string }[] = [];
      const sources = new Set<string>();
      let simulated = false;
      let foreign = 0;

      const logs = await timeboxed((signal) => this.ports.searchLogs({ scope, range, limit: 500 }, { signal }), this.config.probeTimeoutMs, `searchLogs(${address})`);
      if (!logs.ok) return logs;
      simulated ||= logs.value.simulated === true;
      for (const s of logs.value.sources ?? []) sources.add(sanitizeText(s, 80));
      for (const u of logs.value.unavailable ?? []) unavailable.push({ source: sanitizeText(u.source, 80), reason: sanitizeText(u.reason, 160) });
      for (const l of logs.value.items ?? []) {
        if (l.environmentId !== this.scope.environmentId || (l.address !== undefined && l.address !== address)) {
          foreign += 1;
          continue;
        }
        items.push({ timestamp: l.timestamp, message: String(l.message ?? ""), source: "logs" });
      }

      let eventsRead: boolean | undefined;
      if (this.ports.searchEvents) {
        const search = this.ports.searchEvents.bind(this.ports);
        const ev = await timeboxed((signal) => search({ scope, range, limit: 200 }, { signal }), this.config.probeTimeoutMs, `searchEvents(${address})`);
        if (!ev.ok) {
          eventsRead = false;
          unavailable.push({ source: "events", reason: ev.message });
        } else {
          eventsRead = true;
          simulated ||= ev.value.simulated === true;
          for (const s of ev.value.sources ?? []) sources.add(sanitizeText(s, 80));
          for (const u of ev.value.unavailable ?? []) unavailable.push({ source: sanitizeText(u.source, 80), reason: sanitizeText(u.reason, 160) });
          for (const e of ev.value.items ?? []) {
            if (e.environmentId !== this.scope.environmentId || (e.address !== undefined && e.address !== address)) {
              foreign += 1;
              continue;
            }
            items.push({ timestamp: e.timestamp, message: `${e.type ?? ""} ${e.message ?? ""}`, source: "events" });
          }
        }
      }

      const scanned = scanText(items);
      return {
        ok: true,
        value: {
          hits: scanned.hits,
          scanned: scanned.scanned,
          truncated: scanned.truncated || logs.value.truncated === true,
          logsRead: true,
          eventsRead,
          unavailable,
          foreign,
          simulated,
          sources: [...sources].sort(),
        },
      };
    });
  }

  metrics(address: string, names: string[]): Promise<Fetched<{ series: MetricSeries[]; simulated: boolean; unavailable: { source: string; reason: string }[] }>> {
    const key = `metrics:${address}:${names.join(",")}`;
    return this.memo(key, async () => {
      const range = { from: new Date(this.nowMs - this.config.logWindowMs).toISOString(), to: this.nowIso };
      const r = await timeboxed(
        (signal) => this.ports.queryMetrics({ scope: this.logScope(address), range, metrics: names, stepSec: 60 }, { signal }),
        this.config.probeTimeoutMs,
        `queryMetrics(${address})`
      );
      if (!r.ok) return r;
      const series = (r.value.items ?? []).filter((s) => s.address === undefined || s.address === address);
      return {
        ok: true,
        value: {
          series,
          simulated: r.value.simulated === true,
          unavailable: (r.value.unavailable ?? []).map((u) => ({ source: sanitizeText(u.source, 80), reason: sanitizeText(u.reason, 160) })),
        },
      };
    });
  }

  changes(): Promise<Fetched<ChangesBundle>> {
    return this.memo("changes", async () => {
      const since = new Date(this.nowMs - this.config.changeWindowMs).toISOString();
      const r = await timeboxed((signal) => this.ports.recentChanges(this.scope.environmentId, since, { signal }), this.config.probeTimeoutMs, "recentChanges");
      if (!r.ok) return r;
      const changes: RecentChange[] = [];
      let dropped = 0;
      for (const c of Array.isArray(r.value) ? r.value : []) {
        const at = Date.parse(c?.at);
        if (Number.isNaN(at) || at > this.nowMs + 60_000) {
          dropped += 1;
          continue;
        }
        const kind = typeof c.kind === "string" && /^[a-z][a-z0-9_.:-]{0,39}$/i.test(c.kind) ? c.kind.toLowerCase() : "other";
        changes.push({
          at: new Date(at).toISOString(),
          kind,
          summary: sanitizeText(c.summary, 200),
          ...(typeof c.operationId === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(c.operationId) ? { operationId: c.operationId } : {}),
        });
      }
      changes.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.summary < b.summary ? -1 : a.summary > b.summary ? 1 : 0));
      return { ok: true, value: { changes: changes.slice(-50), dropped } };
    });
  }

  drift(): Promise<Fetched<DriftReport | null>> {
    return this.memo("drift", async () => {
      const r = await timeboxed((signal) => this.ports.drift(this.scope.environmentId, { signal }), this.config.probeTimeoutMs, "drift");
      if (r.ok && r.value !== null && r.value.environmentId !== this.scope.environmentId)
        return { ok: false, reason: "error", message: "drift report belongs to a different environment" };
      return r;
    });
  }

  /** Build one evidence record. Text is sanitized and data bounded here, so no probe can forget to. */
  evidence(e: {
    hop: Hop;
    address?: string;
    check: string;
    outcome: Evidence["outcome"];
    finding: string;
    data?: Record<string, unknown>;
    simulated?: boolean;
    source?: string;
    observedAt?: string;
    key?: string;
  }): Evidence {
    const observed = e.observedAt !== undefined && !Number.isNaN(Date.parse(e.observedAt)) ? new Date(Date.parse(e.observedAt)).toISOString() : this.nowIso;
    return {
      id: `ev:${e.check}:${e.address ?? "env"}${e.key ? `:${e.key}` : ""}`,
      hop: e.hop,
      ...(e.address !== undefined ? { address: e.address } : {}),
      check: e.check,
      outcome: e.outcome,
      finding: sanitizeFinding(e.finding),
      observedAt: observed,
      data: (sanitizeData(e.data ?? {}, MAX_EXCERPT_CHARS) as Record<string, unknown>) ?? {},
      simulated: e.simulated === true,
      ...(e.source !== undefined ? { source: sanitizeText(e.source, 80) } : {}),
    };
  }

  /** `unknown` evidence for a check that could not be completed, with a sanitized reason. */
  unknown(hop: Hop, address: string | undefined, check: string, why: string, data?: Record<string, unknown>, key?: string): Evidence {
    return this.evidence({
      hop,
      address,
      key,
      check,
      outcome: "unknown",
      finding: `${check} could not be completed${address ? ` for ${address}` : ""}: ${why}`,
      data,
    });
  }
}
