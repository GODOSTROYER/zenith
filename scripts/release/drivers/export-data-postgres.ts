/** PostgreSQL leg: separate tenant databases, real TCP SQL, independent logical witnesses. */
import postgres from "postgres";
import { assertEqualContent, knownData, pinnedFixtureImages, rowWitness, type FixtureRow, type Witness } from "./export-data-plan";
import type { DataLeg, LegContext, LegEndpoint } from "./export-data-leg";

export function postgresEndpoint(endpoint: LegEndpoint, database = "postgres"): string {
  const url = new URL(endpoint.url);
  if (url.protocol !== "postgres:" || url.hostname !== "127.0.0.1" || !url.port || !endpoint.user || !endpoint.password)
    throw new Error("Owned loopback PostgreSQL fixture endpoint required");
  url.username = endpoint.user; url.password = endpoint.password; url.pathname = "/" + database;
  url.search = "?sslmode=disable";
  return url.toString();
}
function identity(ctx: LegContext): void {
  if (ctx.ownerLabel !== `DRV4-DATA:${ctx.runId}` || !/^[a-z0-9][a-z0-9-]{3,19}$/.test(ctx.runId)) throw new Error("PostgreSQL fixture ownership mismatch");
}
async function session<T>(endpoint: LegEndpoint, database: string, work: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(postgresEndpoint(endpoint, database), { max: 1, ssl: false, prepare: false, connect_timeout: 5, onnotice: () => undefined });
  try { return await work(sql); } finally { await sql.end({ timeout: 5 }); }
}
async function read(endpoint: LegEndpoint, tenant: "a" | "b"): Promise<Witness> {
  return session(endpoint, `tenant_${tenant}`, async sql => {
    const tables = await sql`select tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') order by schemaname,tablename`;
    if (!tables.length) return rowWitness([]);
    if (tables.length !== 1 || tables[0]!.tablename !== "records") throw new Error("Unexpected PostgreSQL fixture table inventory");
    const rows = await sql`select id::text,tenant,payload,note from public.records order by id`;
    return rowWitness(rows as unknown as FixtureRow[]);
  });
}
export const postgresLeg: DataLeg = {
  kind: "postgres",
  image: env => pinnedFixtureImages(env).postgres,
  async seedSource(ctx) {
    identity(ctx);
    for (const endpoint of [ctx.source, ctx.target]) {
      await session(endpoint, "postgres", async sql => {
        for (const tenant of ["a", "b"] as const) {
          const name = `tenant_${tenant}`;
          const existing = await sql`select datname from pg_database where datname=${name}`;
          if (existing.length) throw new Error("PostgreSQL leg needs fresh tenant databases");
          await sql.unsafe(`create database ${name}`);
          await sql.unsafe(`comment on database ${name} is '${ctx.ownerLabel}'`);
        }
      });
    }
    for (const tenant of ["a", "b"] as const) await session(ctx.source, `tenant_${tenant}`, async sql => {
      await sql`create table public.records (id integer primary key, tenant text not null, payload text not null, note text)`;
      for (const row of knownData(ctx.runId, tenant).rows) await sql`insert into public.records (id,tenant,payload,note) values (${Number(row.id)},${row.tenant},${row.payload},${row.note})`;
      assertEqualContent(rowWitness(knownData(ctx.runId, tenant).rows), await read(ctx.source, tenant));
    });
    return read(ctx.source, ctx.tenant);
  },
  async readTarget(ctx) { identity(ctx); return read(ctx.target, ctx.tenant); },
  async assertNoForeignTenant(ctx) {
    identity(ctx);
    await session(ctx.target, `tenant_${ctx.tenant}`, async sql => {
      const tables = await sql`select tablename from pg_tables where schemaname not in ('pg_catalog','information_schema')`;
      if (tables.length !== 1 || tables[0]!.tablename !== "records") throw new Error("Unexpected restored PostgreSQL table inventory");
      const rows = await sql`select tenant from public.records`;
      if (rows.some(row => row.tenant !== `${ctx.runId}/${ctx.tenant}`)) throw new Error("Foreign tenant data in PostgreSQL restore");
    });
    const other = ctx.tenant === "a" ? "b" : "a";
    if ((await read(ctx.target, other)).count) throw new Error("Foreign target database changed");
  },
  async cleanup(ctx) {
    identity(ctx);
    let failed = false;
    for (const endpoint of [ctx.target, ctx.source]) {
      try {
        await session(endpoint, "postgres", async sql => {
          for (const tenant of ["b", "a"] as const) {
            const name = `tenant_${tenant}`;
            const rows = await sql`select shobj_description(oid,'pg_database') as owner from pg_database where datname=${name}`;
            if (!rows.length) continue;
            if (rows[0]!.owner !== ctx.ownerLabel) throw new Error("PostgreSQL database cleanup ownership mismatch");
            await sql.unsafe(`drop database ${name} with (force)`);
            if ((await sql`select datname from pg_database where datname=${name}`).length) throw new Error("PostgreSQL database cleanup unconfirmed");
          }
        });
      } catch { failed = true; }
    }
    if (failed) throw new Error("PostgreSQL leg cleanup failed");
  },
};
