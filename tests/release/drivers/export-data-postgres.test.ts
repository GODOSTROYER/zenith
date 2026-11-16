import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { postgresLeg } from "../../../scripts/release/drivers/export-data-postgres";
import { knownData, rowWitness, type FixtureRow } from "../../../scripts/release/drivers/export-data-plan";
import type { LegContext, LegEndpoint } from "../../../scripts/release/drivers/export-data-leg";

const mock = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("postgres", () => ({ default: mock.connect }));

type Database = { owner?: string; tables: string[]; rows: FixtureRow[] };
type Query = { port: string; database: string; text: string; values: unknown[] };
let ctx: LegContext, engines: Map<string, Map<string, Database>>, queries: Query[];
let sessions: { end: ReturnType<typeof vi.fn> }[];
let corruptRead: boolean, retainDrop: boolean;
function engine(endpoint: LegEndpoint): Map<string, Database> { return engines.get(new URL(endpoint.url).port)!; }
function database(endpoint: LegEndpoint, tenant: "a" | "b"): Database { return engine(endpoint).get(`tenant_${tenant}`)!; }
function restore(tenant: "a" | "b" = ctx.tenant): void {
  Object.assign(database(ctx.target, tenant), { tables: ["records"], rows: structuredClone(knownData(ctx.runId, tenant).rows) });
}
function expectClosed(): void { for (const session of sessions) expect(session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 }); }

beforeEach(() => {
  vi.resetAllMocks();
  ctx = { runId: "postgres-test", tenant: "a", ownerLabel: "DRV4-DATA:postgres-test",
    source: { url: "postgres://127.0.0.1:49152/postgres", user: "postgres", password: randomBytes(32).toString("hex") },
    target: { url: "postgres://127.0.0.1:49153/postgres", user: "postgres", password: randomBytes(32).toString("hex") } };
  engines = new Map([["49152", new Map()], ["49153", new Map()]]); queries = []; sessions = [];
  corruptRead = false; retainDrop = false;
  mock.connect.mockImplementation((connection: string) => {
    const url = new URL(connection), databases = engines.get(url.port)!;
    const name = url.pathname.slice(1);
    const execute = async (text: string, values: unknown[] = []): Promise<unknown[]> => {
      queries.push({ port: url.port, database: name, text, values });
      if (text.startsWith("select datname from pg_database")) return databases.has(String(values[0])) ? [{ datname: values[0] }] : [];
      if (text.startsWith("select shobj_description")) {
        const found = databases.get(String(values[0])); return found ? [{ owner: found.owner }] : [];
      }
      if (text.startsWith("create database ")) {
        const created = text.slice("create database ".length);
        if (databases.has(created)) throw new Error("duplicate database");
        databases.set(created, { tables: [], rows: [] }); return [];
      }
      if (text.startsWith("comment on database ")) {
        const match = /^comment on database (tenant_[ab]) is '([^']+)'$/.exec(text);
        if (!match) throw new Error("invalid database comment");
        databases.get(match[1])!.owner = match[2]; return [];
      }
      if (text.startsWith("drop database ")) {
        const match = /^drop database (tenant_[ab]) with \(force\)$/.exec(text);
        if (!match) throw new Error("invalid database drop");
        if (!retainDrop) databases.delete(match[1]); return [];
      }
      const selected = databases.get(name);
      if (!selected) throw new Error("database does not exist");
      if (text.startsWith("select tablename from pg_tables")) return selected.tables.map(tablename => ({ tablename }));
      if (text.startsWith("create table public.records")) { selected.tables.push("records"); return []; }
      if (text.startsWith("insert into public.records")) {
        selected.rows.push({ id: String(values[0]), tenant: String(values[1]), payload: String(values[2]), note: values[3] as string | null }); return [];
      }
      if (text.startsWith("select id::text,tenant,payload,note")) {
        const rows = structuredClone(selected.rows);
        if (corruptRead && rows.length) rows[0].payload += " altered by engine";
        return rows;
      }
      if (text === "select tenant from public.records") return selected.rows.map(row => ({ tenant: row.tenant }));
      throw new Error(`Unsupported fixture SQL: ${text}`);
    };
    const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => execute(strings.join("?"), values), {
      unsafe: (text: string) => execute(text), end: vi.fn().mockResolvedValue(undefined),
    });
    sessions.push(sql); return sql;
  });
});

describe("PostgreSQL leg (offline SQL fake, no engine acceptance)", () => {
  it.each(["a", "b"] as const)("seeds separate databases for both tenants and independently witnesses tenant %s", async tenant => {
    ctx.tenant = tenant;
    expect(await postgresLeg.seedSource(ctx)).toEqual(rowWitness(knownData(ctx.runId, tenant).rows));
    for (const selected of ["a", "b"] as const) {
      expect(database(ctx.source, selected)).toEqual({ owner: ctx.ownerLabel, tables: ["records"], rows: knownData(ctx.runId, selected).rows });
      expect(database(ctx.target, selected)).toEqual({ owner: ctx.ownerLabel, tables: [], rows: [] });
    }
    const inserts = queries.filter(query => query.text.startsWith("insert into"));
    expect(inserts).toHaveLength(6);
    expect(inserts.every(query => query.port === "49152" && query.values[1] === `${ctx.runId}/${query.database.slice(-1)}`)).toBe(true);
    expect(queries.filter(query => query.text.startsWith("select id::text"))).toHaveLength(3);
    expectClosed();
  });
  it("detects source readback corruption instead of returning a witness made from fixture inputs", async () => {
    corruptRead = true;
    await expect(postgresLeg.seedSource(ctx)).rejects.toThrow("Independent content readback mismatch");
    expectClosed();
  });
  it("refuses to overwrite even a correctly owned existing tenant database", async () => {
    engine(ctx.source).set("tenant_a", { owner: ctx.ownerLabel, tables: ["records"], rows: knownData(ctx.runId, "a").rows });
    await expect(postgresLeg.seedSource(ctx)).rejects.toThrow("fresh tenant databases");
    expect(queries.some(query => /^(create|insert|drop)/.test(query.text))).toBe(false);
    expectClosed();
  });
  it("reads empty targets and all restored rows, including corrupt content, without tenant filtering", async () => {
    await postgresLeg.seedSource(ctx);
    expect(await postgresLeg.readTarget(ctx)).toEqual(rowWitness([]));
    restore();
    expect(await postgresLeg.readTarget(ctx)).toEqual(rowWitness(knownData(ctx.runId, "a").rows));
    database(ctx.target, "a").rows[0].payload += " changed";
    expect(await postgresLeg.readTarget(ctx)).not.toEqual(rowWitness(knownData(ctx.runId, "a").rows));
    const reads = queries.filter(query => query.port === "49153" && query.text.startsWith("select id::text"));
    expect(reads).toHaveLength(2); expect(reads.every(query => !query.text.includes("where"))).toBe(true);
    expectClosed();
  });
  it("refuses unexpected restored tables and foreign tenant rows", async () => {
    await postgresLeg.seedSource(ctx); restore();
    database(ctx.target, "a").tables.push("foreign_records");
    await expect(postgresLeg.readTarget(ctx)).rejects.toThrow("table inventory");
    await expect(postgresLeg.assertNoForeignTenant(ctx)).rejects.toThrow("table inventory");
    database(ctx.target, "a").tables.pop();
    database(ctx.target, "a").rows[0].tenant = `${ctx.runId}/b`;
    await expect(postgresLeg.assertNoForeignTenant(ctx)).rejects.toThrow("Foreign tenant data");
    expectClosed();
  });
  it.each(["a", "b"] as const)("requires the other target database to remain empty when tenant %s is restored", async tenant => {
    ctx.tenant = tenant; await postgresLeg.seedSource(ctx); restore();
    await expect(postgresLeg.assertNoForeignTenant(ctx)).resolves.toBeUndefined();
    restore(tenant === "a" ? "b" : "a");
    await expect(postgresLeg.assertNoForeignTenant(ctx)).rejects.toThrow("Foreign target database changed");
    expectClosed();
  });
  it("checks ownership before deleting and attempts source cleanup after target refusal", async () => {
    await postgresLeg.seedSource(ctx); database(ctx.target, "b").owner = "another-run";
    queries.length = 0;
    await expect(postgresLeg.cleanup(ctx)).rejects.toThrow("cleanup failed");
    expect(engine(ctx.target).size).toBe(2); expect(engine(ctx.source).size).toBe(0);
    expect(queries.filter(query => query.text.startsWith("drop database")).map(query => `${query.port}:${query.text}`)).toEqual([
      "49152:drop database tenant_b with (force)", "49152:drop database tenant_a with (force)",
    ]);
    expectClosed();
  });
  it("removes all labelled databases in reverse order and cleanup is idempotent", async () => {
    await postgresLeg.seedSource(ctx); queries.length = 0;
    await postgresLeg.cleanup(ctx); await postgresLeg.cleanup(ctx);
    expect([...engines.values()].every(databases => databases.size === 0)).toBe(true);
    expect(queries.filter(query => query.text.startsWith("drop database")).map(query => `${query.port}:${query.text}`)).toEqual([
      "49153:drop database tenant_b with (force)", "49153:drop database tenant_a with (force)",
      "49152:drop database tenant_b with (force)", "49152:drop database tenant_a with (force)",
    ]);
    expectClosed();
  });
  it("requires independent absence readback after deletion and still attempts both endpoints", async () => {
    await postgresLeg.seedSource(ctx); queries.length = 0; retainDrop = true;
    await expect(postgresLeg.cleanup(ctx)).rejects.toThrow("cleanup failed");
    expect(queries.filter(query => query.text.startsWith("drop database")).map(query => query.port)).toEqual(["49153", "49152"]);
    expect([...engines.values()].every(databases => databases.size === 2)).toBe(true);
    expectClosed();
  });
  it("rejects ownership mismatches before every public operation opens a session", async () => {
    ctx.ownerLabel = "another-run";
    for (const operation of [postgresLeg.seedSource, postgresLeg.readTarget, postgresLeg.assertNoForeignTenant, postgresLeg.cleanup])
      await expect(operation(ctx)).rejects.toThrow("ownership mismatch");
    expect(mock.connect).not.toHaveBeenCalled();
  });
});
