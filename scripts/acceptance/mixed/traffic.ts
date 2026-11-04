/**
 * Traffic generator for the reference mixed app (PROD-MIX-06).
 *
 * Deterministic from `(runId, seed)`: the same inputs produce the same orders, so a run can be reasoned about and
 * replayed. Every order has a unique client key `<runId>-<n>`, which is the idempotency key and the tag the
 * independent readback uses to find this run's rows. The generator only RECORDS what the app said; it never decides
 * what was stored. That is the readback checker's job, through a different channel.
 *
 * Outcome classes (generic, they assume nothing about the app's internals):
 *   acknowledged   HTTP 200 or 201 naming the same client key: the app says the row is in the database
 *   rejected       HTTP 400 or 422: a definitive "not accepted"
 *   uncertain      anything else (5xx, timeout, reset, unreadable): the write may or may not have happened
 *
 * Contract level: this file calls only the URL it is given. It holds no credentials and sends none.
 */
import http from "node:http";
import https from "node:https";
import { digest } from "@/lib/controlplane/digest";
import spec from "../../../fixtures/mixed-app/spec.json";

export interface PlannedOrder { clientKey: string; sku: string; qty: number }
export type WriteOutcome = "acknowledged" | "rejected" | "uncertain";

export interface AckRow { clientKey: string; sku: string; qty: number; priceCents: number; checksum: string; webProvider: string; enricherProvider: string }

export interface WriteRecord extends PlannedOrder {
  outcome: WriteOutcome;
  status?: number;
  replay?: boolean;
  ack?: AckRow;
  error?: string;
  durationMs: number;
}

export interface TrafficLedger {
  runId: string;
  seed: number;
  records: WriteRecord[];
  counts: Record<WriteOutcome, number>;
  /** digest over the timing-free facts, so two runs of the same plan against the same app compare equal */
  digest: string;
}

export interface TrafficPlan {
  runId: string;
  seed: number;
  count: number;
  concurrency?: number;
  timeoutMs?: number;
  /** after the first pass, resend this many acknowledged writes unchanged to prove idempotency */
  replay?: number;
}

export interface HttpRequest { method: "GET" | "POST"; url: URL; body?: string; timeoutMs: number }
export interface HttpResponse { status: number; body: string }
/** The one network seam. Throwing means "no response" (timeout, reset, refused). */
export type Requester = (request: HttpRequest) => Promise<HttpResponse>;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUN_ID = /^[A-Za-z0-9_-]{4,60}$/;

export function planOrders(runId: string, seed: number, count: number): PlannedOrder[] {
  if (!RUN_ID.test(runId)) throw new Error("runId must be 4 to 60 letters, digits, dashes or underscores.");
  if (!Number.isInteger(count) || count < 1 || count > 100_000) throw new Error("count must be a whole number from 1 to 100000.");
  const skus = Object.keys(spec.catalogCents).sort();
  const next = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => ({
    clientKey: `${runId}-${i + 1}`,
    sku: skus[Math.floor(next() * skus.length)]!,
    qty: 1 + Math.floor(next() * spec.maxQty),
  }));
}

/** Default requester over node:http(s). `via` sends the connection elsewhere (a fault proxy) while keeping Host and TLS server name. */
export function nodeRequester(via?: { host: string; port: number }): Requester {
  return (request) => new Promise<HttpResponse>((resolve, reject) => {
    const secure = request.url.protocol === "https:";
    const lib = secure ? https : http;
    const req = lib.request({
      method: request.method, hostname: via?.host ?? request.url.hostname, port: via?.port ?? (request.url.port || (secure ? 443 : 80)), path: `${request.url.pathname}${request.url.search}`,
      headers: { host: request.url.host, ...(request.body ? { "content-type": "application/json", "content-length": Buffer.byteLength(request.body) } : {}) },
      timeout: request.timeoutMs, agent: false, ...(secure ? { servername: request.url.hostname } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(request.body);
  });
}

function parseAck(body: string, clientKey: string): AckRow | undefined {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (r.clientKey !== clientKey || typeof r.sku !== "string" || typeof r.qty !== "number" || typeof r.priceCents !== "number" || typeof r.checksum !== "string") return undefined;
  return { clientKey, sku: r.sku, qty: r.qty, priceCents: r.priceCents, checksum: r.checksum, webProvider: String(r.webProvider ?? ""), enricherProvider: String(r.enricherProvider ?? "") };
}

async function send(entry: URL, order: PlannedOrder, requester: Requester, timeoutMs: number, now: () => number, replay = false): Promise<WriteRecord> {
  const started = now();
  const base: WriteRecord = { ...order, outcome: "uncertain", durationMs: 0, ...(replay ? { replay: true } : {}) };
  try {
    const res = await requester({ method: "POST", url: new URL("/orders", entry), body: JSON.stringify(order), timeoutMs });
    const durationMs = now() - started;
    if (res.status === 200 || res.status === 201) {
      const ack = parseAck(res.body, order.clientKey);
      return ack ? { ...base, outcome: "acknowledged", status: res.status, ack, durationMs } : { ...base, status: res.status, error: "unreadable_acknowledgement", durationMs };
    }
    if (res.status === 400 || res.status === 422) return { ...base, outcome: "rejected", status: res.status, durationMs };
    return { ...base, status: res.status, error: `http_${res.status}`, durationMs };
  } catch (e) {
    return { ...base, error: e instanceof Error && e.message === "timeout" ? "timeout" : "no_response", durationMs: now() - started };
  }
}

export function summarize(runId: string, seed: number, records: WriteRecord[]): TrafficLedger {
  const counts: Record<WriteOutcome, number> = { acknowledged: 0, rejected: 0, uncertain: 0 };
  for (const r of records) counts[r.outcome] += 1;
  const stable = records.map(({ durationMs: _d, ...rest }) => rest);
  return { runId, seed, records, counts, digest: digest({ runId, seed, stable }) };
}

export async function runTraffic(entryUrl: string, plan: TrafficPlan, deps: { requester?: Requester; now?: () => number } = {}): Promise<TrafficLedger> {
  const entry = new URL(entryUrl);
  if (entry.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(entry.hostname)) throw new Error("The entry URL must be https (or a local development host).");
  const requester = deps.requester ?? nodeRequester();
  const now = deps.now ?? Date.now;
  const timeoutMs = plan.timeoutMs ?? 5000;
  const concurrency = Math.max(1, Math.min(plan.concurrency ?? 4, 32));
  const orders = planOrders(plan.runId, plan.seed, plan.count);
  const records: WriteRecord[] = new Array<WriteRecord>(orders.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, orders.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= orders.length) return;
      records[i] = await send(entry, orders[i]!, requester, timeoutMs, now);
    }
  }));
  const replays: WriteRecord[] = [];
  for (const original of records.filter((r) => r.outcome === "acknowledged").slice(0, plan.replay ?? 0)) {
    replays.push(await send(entry, { clientKey: original.clientKey, sku: original.sku, qty: original.qty }, requester, timeoutMs, now, true));
  }
  return summarize(plan.runId, plan.seed, [...records, ...replays]);
}
