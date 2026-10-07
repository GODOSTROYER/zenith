/**
 * Order stores of the reference mixed app. `postgres` is the real one (Azure Database for PostgreSQL); `memory` exists
 * only so the app can run in local tests and is refused unless STORE=memory is set explicitly, so a deployment can never
 * silently fall back to it.
 */
import { readFileSync } from "node:fs";

export function createMemoryStore() {
  const rows = new Map();
  let next = 1;
  return {
    kind: "memory",
    async insertOrder(row) {
      const existing = rows.get(row.clientKey);
      if (existing) return { created: false, row: existing };
      const stored = { id: next++, ...row };
      rows.set(row.clientKey, stored);
      return { created: true, row: stored };
    },
    async getOrder(clientKey) { return rows.get(clientKey) ?? null; },
    async countByPrefix(prefix) { return [...rows.keys()].filter((k) => k.startsWith(prefix)).length; },
    /** test hook: every row, for the independent checker's memory source */
    all() { return [...rows.values()]; },
  };
}

/** The connection URL comes from a FILE (DATABASE_URL_FILE), never from an environment value; it is never logged. */
export async function createPostgresStore({ urlFile }) {
  if (!urlFile) throw new Error("DATABASE_URL_FILE is not set");
  const url = readFileSync(urlFile, "utf8").trim();
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { ssl: "require", max: 4, idle_timeout: 20, connect_timeout: 10 });
  const toRow = (r) => ({ id: Number(r.id), clientKey: r.client_key, sku: r.sku, qty: r.qty, priceCents: r.price_cents, checksum: r.checksum, webProvider: r.web_provider, enricherProvider: r.enricher_provider });
  return {
    kind: "postgres",
    async insertOrder(row) {
      const inserted = await sql`insert into orders (client_key, sku, qty, price_cents, checksum, web_provider, enricher_provider)
        values (${row.clientKey}, ${row.sku}, ${row.qty}, ${row.priceCents}, ${row.checksum}, ${row.webProvider}, ${row.enricherProvider})
        on conflict (client_key) do nothing returning *`;
      if (inserted.length) return { created: true, row: toRow(inserted[0]) };
      const existing = await sql`select * from orders where client_key = ${row.clientKey}`;
      return { created: false, row: toRow(existing[0]) };
    },
    async getOrder(clientKey) {
      const found = await sql`select * from orders where client_key = ${clientKey}`;
      return found.length ? toRow(found[0]) : null;
    },
    async countByPrefix(prefix) {
      const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      const found = await sql`select count(*)::int as n from orders where client_key like ${`${escaped}%`}`;
      return found[0].n;
    },
    async close() { await sql.end({ timeout: 5 }); },
  };
}

export async function createStoreFromEnv(env = process.env) {
  if (env.STORE === "memory") return createMemoryStore();
  return createPostgresStore({ urlFile: env.DATABASE_URL_FILE });
}
