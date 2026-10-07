/**
 * Independent readback of the reference mixed app's data (PROD-MIX-06).
 *
 * "Independent" means three things, each enforced here rather than promised:
 *  1. a different channel: the rows are read DIRECTLY from the database with its own read-only credential FILE, not
 *     through the web app or the enricher that wrote them (`channel` must be "direct_database");
 *  2. a different implementation: the checker recomputes the expected price and checksum itself from the shared
 *     spec data and never imports app code;
 *  3. a different question: it does not ask "did the app answer" but "is every acknowledged write really there,
 *     exactly once, correct, and nothing else of this run".
 *
 * Rules (a problem is any violation):
 *  - every ACKNOWLEDGED write exists exactly once with the same sku, qty, price and checksum (recomputed here);
 *  - a REJECTED write does not exist;
 *  - a row under this run's prefix that the generator never sent is a phantom;
 *  - UNCERTAIN writes may exist or not; both counts are reported, neither is a pass or a fail;
 *  - rows record the providers that served them: they must match the expected web and enricher clouds;
 *  - a Postgres source must name a host with the expected suffix (the Azure endpoint), proving the data sits where
 *    the plan says, and its channel must be the database itself.
 * A clean verdict says only that the rows match the ledger. It does not prove the database is on Azure beyond the
 * host name, nor that nothing outside this run's prefix is wrong.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import spec from "../../../fixtures/mixed-app/spec.json";
import type { TrafficLedger } from "./traffic";

export interface StoredOrder { clientKey: string; sku: string; qty: number; priceCents: number; checksum: string; webProvider: string; enricherProvider: string }

export interface SourceInfo { channel: "direct_database" | "application" | "memory"; kind: "postgres" | "memory"; host?: string }
export interface ReadbackSource { describe(): SourceInfo; fetchByPrefix(prefix: string): Promise<StoredOrder[]> }

export interface ReadbackExpectations {
  runId: string;
  expectedProviders: { web: string; enricher: string };
  /** required suffix of the database host (for example `.postgres.database.azure.com`) when the source is postgres */
  databaseHostSuffix?: string;
}

export interface ReadbackVerdict {
  ok: boolean;
  problems: string[];
  counts: { acknowledged: number; foundAcknowledged: number; rejectedPresent: number; uncertainPresent: number; uncertainAbsent: number; phantoms: number; rows: number };
  providersSeen: { web: string[]; enricher: string[] };
  limits: string[];
}

const LIMITS = [
  "Only rows under this run's client-key prefix are inspected.",
  "The database host name is checked, not the network path or the account that owns it.",
  "Uncertain writes are reported, never counted as passed or failed.",
];

/** The checker's OWN price and checksum rules, from the shared spec data. */
export function expectedPriceCents(sku: string, qty: number): number | undefined {
  const unit = (spec.catalogCents as Record<string, number>)[sku];
  return unit === undefined ? undefined : unit * qty;
}

export function expectedChecksum(order: { clientKey: string; sku: string; qty: number; priceCents: number }): string {
  const values: Record<string, string | number> = { clientKey: order.clientKey, sku: order.sku, qty: order.qty, priceCents: order.priceCents };
  const parts = spec.checksum.fields.map((f) => String(values[f]));
  return createHash(spec.checksum.algorithm).update(`${spec.checksum.salt}${spec.checksum.separator}${parts.join(spec.checksum.separator)}`).digest("hex");
}

export function verifyReadback(ledger: TrafficLedger, rows: readonly StoredOrder[], source: SourceInfo, expectations: ReadbackExpectations): ReadbackVerdict {
  const problems: string[] = [];
  const prefix = `${expectations.runId}-`;
  if (ledger.runId !== expectations.runId) problems.push("The ledger belongs to a different run than the one being checked.");
  if (source.channel !== "direct_database") problems.push(`The readback channel is "${source.channel}", not the database itself; it is not independent of the app.`);
  if (source.kind === "postgres") {
    if (!expectations.databaseHostSuffix) problems.push("A postgres readback needs the expected database host suffix.");
    else if (!source.host || !source.host.toLowerCase().endsWith(expectations.databaseHostSuffix.toLowerCase())) problems.push("The database host does not carry the expected provider suffix, so the data is not shown to sit where the plan says.");
  }
  const byKey = new Map<string, StoredOrder[]>();
  for (const row of rows) {
    if (!row.clientKey.startsWith(prefix)) continue;
    byKey.set(row.clientKey, [...(byKey.get(row.clientKey) ?? []), row]);
  }
  const sent = new Map<string, TrafficLedger["records"][number]>();
  for (const record of ledger.records) if (!record.replay) sent.set(record.clientKey, record);
  for (const [key, list] of byKey) if (list.length > 1) problems.push(`Client key ${key} is stored ${list.length} times.`);

  let foundAcknowledged = 0; let rejectedPresent = 0; let uncertainPresent = 0; let uncertainAbsent = 0; let acknowledged = 0;
  for (const record of sent.values()) {
    const stored = byKey.get(record.clientKey)?.[0];
    if (record.outcome === "acknowledged") {
      acknowledged += 1;
      if (!stored) { problems.push(`Acknowledged write ${record.clientKey} is not in the database.`); continue; }
      foundAcknowledged += 1;
      const price = expectedPriceCents(record.sku, record.qty);
      if (stored.sku !== record.sku || stored.qty !== record.qty) problems.push(`Row ${record.clientKey} differs from what was sent.`);
      if (price === undefined || stored.priceCents !== price) problems.push(`Row ${record.clientKey} has price ${stored.priceCents}, expected ${String(price)}.`);
      if (price !== undefined && stored.checksum !== expectedChecksum({ clientKey: record.clientKey, sku: record.sku, qty: record.qty, priceCents: price })) problems.push(`Row ${record.clientKey} has a wrong checksum.`);
      if (stored.webProvider !== expectations.expectedProviders.web) problems.push(`Row ${record.clientKey} was served by web provider "${stored.webProvider}", expected "${expectations.expectedProviders.web}".`);
      if (stored.enricherProvider !== expectations.expectedProviders.enricher) problems.push(`Row ${record.clientKey} was enriched by "${stored.enricherProvider}", expected "${expectations.expectedProviders.enricher}".`);
      if (record.ack && (record.ack.priceCents !== stored.priceCents || record.ack.checksum !== stored.checksum)) problems.push(`The acknowledgement for ${record.clientKey} disagrees with the stored row.`);
    } else if (record.outcome === "rejected") {
      if (stored) { rejectedPresent += 1; problems.push(`Rejected write ${record.clientKey} exists in the database.`); }
    } else if (stored) uncertainPresent += 1;
    else uncertainAbsent += 1;
  }
  let phantoms = 0;
  for (const key of byKey.keys()) if (!sent.has(key)) { phantoms += 1; problems.push(`Row ${key} under this run's prefix was never sent by the generator.`); }
  for (const record of ledger.records.filter((r) => r.replay)) {
    if (record.outcome !== "acknowledged" || record.status !== 200) problems.push(`Replay of ${record.clientKey} was not acknowledged as an idempotent 200.`);
  }
  const web = [...new Set([...byKey.values()].flat().map((r) => r.webProvider))].sort();
  const enricher = [...new Set([...byKey.values()].flat().map((r) => r.enricherProvider))].sort();
  if (acknowledged === 0) problems.push("No acknowledged writes: nothing was served, so nothing is proven.");
  return { ok: problems.length === 0, problems, counts: { acknowledged, foundAcknowledged, rejectedPresent, uncertainPresent, uncertainAbsent, phantoms, rows: [...byKey.values()].flat().length }, providersSeen: { web, enricher }, limits: LIMITS };
}

/** A source over fixed rows, for contract tests and the local engine. Its channel is "memory", so it can never satisfy a live verdict. */
export function memoryReadback(rows: readonly StoredOrder[]): ReadbackSource {
  return { describe: () => ({ channel: "memory", kind: "memory" }), fetchByPrefix: async (prefix) => rows.filter((r) => r.clientKey.startsWith(prefix)) };
}

/**
 * The real source: PostgreSQL over TLS with a READ ONLY transaction, from a credential FILE the operator names
 * (never a value in the environment or on the command line). The host is parsed for the suffix check; the URL is never
 * logged or returned.
 */
export async function postgresReadback(input: { urlFile: string }): Promise<ReadbackSource & { close(): Promise<void> }> {
  const url = readFileSync(input.urlFile, "utf8").trim();
  if (!url) throw new Error("The readback credential file is empty.");
  let host: string;
  try { host = new URL(url).hostname; } catch { throw new Error("The readback credential file does not hold a postgres URL."); }
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { ssl: "require", max: 2, idle_timeout: 10, connect_timeout: 15 });
  return {
    describe: () => ({ channel: "direct_database", kind: "postgres", host }),
    async fetchByPrefix(prefix) {
      const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      const result = await sql.begin("read only", (tx) => tx`select client_key, sku, qty, price_cents, checksum, web_provider, enricher_provider from orders where client_key like ${`${escaped}%`} order by client_key`);
      return result.map((r) => ({ clientKey: String(r.client_key), sku: String(r.sku), qty: Number(r.qty), priceCents: Number(r.price_cents), checksum: String(r.checksum), webProvider: String(r.web_provider), enricherProvider: String(r.enricher_provider) }));
    },
    async close() { await sql.end({ timeout: 5 }); },
  };
}
