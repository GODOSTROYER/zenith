import { readFileSync } from "node:fs";
import { digest } from "@/lib/controlplane/digest";
import { runTraffic, nodeRequester } from "../../mixed/traffic";
import { verifyReadback, type ReadbackSource } from "../../mixed/readback";
import { nodeProbeIo, runConnectivityProbes } from "../../mixed/connectivity-probe";
import type { Request, Step, Target } from "../managed/plan";
import { privateFile } from "../managed/transport";
type Env = Readonly<Record<string, string | undefined>>;

/** Reuses MIX's independent checker, with TLS peer verification and a read-only DB transaction.
 * The file is opened only after the entire approved envelope has passed. No URL or rows are emitted. */
async function database(t: Target, env: Env, guard: () => void): Promise<ReadbackSource & { close(): Promise<void> }> {
  const uri = readFileSync(privateFile(t.credentialRef!, env), "utf8").trim();
  const parsed = new URL(uri);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname.endsWith(t.hostSuffix!) || !parsed.username || !parsed.password) throw new Error("Independent database identity does not match the approved target");
  // Connection string query options cannot override TLS verification or the scoped target.
  parsed.search = "";
  const ca = readFileSync(privateFile(t.caRef!, env), "utf8");
  guard();
  const { default: postgres } = await import("postgres");
  const sql = postgres(parsed.toString(), { ssl: { ca, rejectUnauthorized: true }, max: 1, connect_timeout: 15, idle_timeout: 5, prepare: false, connection: { statement_timeout: 20000, lock_timeout: 5000 } });
  return {
    describe: () => ({ channel: "direct_database", kind: "postgres", host: parsed.hostname }),
    async fetchByPrefix(prefix) {
      guard();
      const escaped = prefix.replace(/[\\%_]/g, c => `\\${c}`);
      const rows = await sql.begin("read only", tx => tx`select client_key, sku, qty, price_cents, checksum, web_provider, enricher_provider from orders where client_key like ${`${escaped}%`} order by client_key limit 1001`);
      if (rows.length > 1000) throw new Error("Independent readback row bound exceeded; an incomplete scan is not evidence");
      return rows.map(r => ({ clientKey: String(r.client_key), sku: String(r.sku), qty: Number(r.qty), priceCents: Number(r.price_cents), checksum: String(r.checksum), webProvider: String(r.web_provider), enricherProvider: String(r.enricher_provider) }));
    }, async close() { await sql.end({ timeout: 5 }); },
  };
}
export async function mixedTraffic(q: Extract<Request, { kind: "mixed_traffic" }>, t: Target, targets: readonly Target[], env: Env, runId: string, guard: (action?: Step["action"], targetId?: string) => void): Promise<{ ok: boolean }> {
  const phaseId = `${runId}-${q.phase}`;
  const ledger = await runTraffic(t.origin!, { runId: phaseId, seed: Number.parseInt(digest(runId).slice(0, 8), 16), count: q.orders, concurrency: 1, replay: q.phase === "outage" ? 0 : Math.min(5, q.orders) }, {
    requester: request => { guard("mutate_run_tagged"); return nodeRequester()(request); },
  });
  const db = targets.find(t => t.id === q.databaseTarget)!;
  const source = await database(db, env, () => guard("read", db.id));
  try {
    const rows = await source.fetchByPrefix(`${phaseId}-`);
    const result = verifyReadback(ledger, rows, source.describe(), { runId: phaseId, expectedProviders: { web: "gcp", enricher: "aws" }, databaseHostSuffix: db.hostSuffix });
    // Outage readback checks possible uncertain writes; absence of acknowledgements is required, not a serving pass.
    const problems = q.phase === "outage" ? result.problems.filter(p => p !== "No acknowledged writes: nothing was served, so nothing is proven.") : result.problems;
    return { ok: problems.length === 0 && (q.phase === "outage" ? ledger.counts.acknowledged === 0 && ledger.counts.uncertain > 0 : ledger.counts.acknowledged > 0) };
  } finally { await source.close(); }
}
export async function connectivity(q: Extract<Request, { kind: "connectivity" }>, env: Env, guard: () => void): Promise<{ ok: boolean }> {
  const client = { cert: readFileSync(privateFile(q.certRef, env)), key: readFileSync(privateFile(q.keyRef, env)), ca: readFileSync(privateFile(q.caRef, env)) };
  const result = await runConnectivityProbes({ endpoints: q.endpoints, client, sourceOutsideAllowlist: q.outsideAllowlist,
    io: { resolve: host => { guard(); return nodeProbeIo.resolve(host); }, tlsConnect: request => { guard(); return nodeProbeIo.tlsConnect(request); } },
  });
  return { ok: result.ok && result.complete };
}
