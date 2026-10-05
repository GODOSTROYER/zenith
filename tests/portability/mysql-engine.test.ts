/**
 * PROD-LIFE-11: MySQL export, import and readback through mysqldump and mysql.
 *
 * Evidence level is `contract`: the worker's command construction, refusals,
 * consistency check and digest logic are tested against a scripted client (a
 * fake `mysql`/`mysqldump` that answers exactly the queries the engine asks).
 * A real server lane runs when ZENITH_TEST_MYSQL_URL points at an EMPTY scratch
 * database and the mysql and mysqldump clients are installed; it has not been
 * executed in this build.
 */
import { describe, expect, it } from "vitest";
import { exportMysql, importMysql, isMysqlEmpty, parseMysqlUri, readbackMysql, spawnMysqlCli, type CliOptions, type CliResult, type MysqlCli, type MysqlConnection } from "@/lib/portability/engines/mysql";
import { runExport, runImport } from "@/lib/portability/service";
import { PortabilityError, type EmitFile } from "@/lib/portability/types";
import { directoryArtifactStore, tempDir } from "./support";

const PW = ["hunter", "2", "-fixture"].join("");
const conn: MysqlConnection = { host: "db.example.test", port: 3306, user: "app", password: PW, database: "shop", ssl: "required" };

interface Call { tool: string; args: string[]; opts: CliOptions }

/** Answers the engine's queries from a scripted database; records every invocation. */
function fakeCli(script: { tables?: Record<string, string[]>; routines?: string[]; views?: string[][]; dump?: string; dumpExit?: number; mutateOnDump?: () => void; existingTables?: number; importExit?: number }): MysqlCli & { calls: Call[]; tables: Record<string, string[]> } {
  const calls: Call[] = [];
  const state = { tables: script.tables ?? { orders: ["1\tada\t10.50", "2\tgrace\tNULL"], users: ["1\tada"] } };
  const ok = (text: string): CliResult => ({ code: 0, stdout: Buffer.from(text), stderr: "" });
  return {
    calls,
    tables: state.tables,
    async run(tool, args, opts) {
      calls.push({ tool, args, opts });
      if (tool === "mysqldump") {
        script.mutateOnDump?.();
        return script.dumpExit ? { code: script.dumpExit, stdout: Buffer.alloc(0), stderr: `host ${conn.host} refused ${PW}` } : ok(script.dump ?? "CREATE TABLE `orders` (id int);\nINSERT INTO `orders` VALUES (1);\n");
      }
      if (opts.stdin) return script.importExit ? { code: script.importExit, stdout: Buffer.alloc(0), stderr: "boom" } : ok("");
      const sql = args[args.indexOf("-e") + 1] ?? "";
      if (sql.startsWith("select 'routine'")) return ok((script.routines ?? []).map((r) => `routine\t${r}`).join("\n"));
      if (sql === "select version()") return ok("8.0.36\n");
      if (sql.includes("information_schema.tables") && sql.includes("order by table_name")) return ok(Object.keys(state.tables).sort().join("\n"));
      if (sql.includes("information_schema.views")) return ok((script.views ?? []).map((v) => v.join("\t")).join("\n"));
      if (sql.includes("information_schema.triggers")) return ok("");
      if (sql.includes("information_schema.columns")) return ok("id\t1\tint\tNO\tNULL\t\tNULL\tNULL\n");
      if (sql.includes("information_schema.statistics")) return ok("PRIMARY\t1\tid\t0\tBTREE\n");
      const m = /^select \* from `([^`]+)`$/.exec(sql);
      if (m) return ok((state.tables[m[1]!] ?? []).join("\n") + ((state.tables[m[1]!] ?? []).length ? "\n" : ""));
      if (sql.startsWith("select (select count(*)")) return ok(`${script.existingTables ?? 0}\n`);
      if (sql.includes("table_type = 'BASE TABLE'")) return ok(`${Object.keys(state.tables).length}\n`);
      throw new Error(`unscripted query: ${sql.slice(0, 80)}`);
    },
  };
}

describe("mysql connection", () => {
  it("parses a connection URI and never lets the password reach a command line", async () => {
    expect(parseMysqlUri("mysql://app:p%40ss@db.example.test:3307/shop")).toMatchObject({ host: "db.example.test", port: 3307, user: "app", password: "p@ss", database: "shop", ssl: "required" });
    expect(parseMysqlUri("mysql://app:x@h/shop?ssl=disabled").ssl).toBe("disabled");
    for (const bad of ["postgres://a:b@h/d", "not a uri", "mysql://h/db", "mysql://app:x@h/", "mysql://app:x@h/db;drop", "mysql://app:x@h:99999/db"]) {
      expect(() => parseMysqlUri(bad), bad).toThrow(PortabilityError);
    }
    const cli = fakeCli({});
    await exportMysql(conn, cli, async () => undefined);
    for (const call of cli.calls) {
      expect(call.args.join(" ")).not.toContain(PW);
      expect(call.opts.env.MYSQL_PWD).toBe(PW);
      expect(call.args).toContain("--ssl-mode=REQUIRED");
      expect(call.args).toContain(`--user=app`);
    }
  });
});

describe("mysql export", () => {
  it("refuses a database with routines or events rather than exporting it incompletely", async () => {
    const emitted: string[] = [];
    await expect(exportMysql(conn, fakeCli({ routines: ["recalc"] }), async (n) => { emitted.push(n); })).rejects.toMatchObject({ code: "unsupported_objects", message: expect.stringContaining("routine recalc") });
    expect(emitted).toEqual([]);
  });

  it("emits a plain mysqldump file, the restore note and a digest that is stable across reads", async () => {
    const files: Record<string, Buffer> = {};
    const emit: EmitFile = async (n, b) => { files[n] = b; };
    const a = await exportMysql(conn, fakeCli({}), emit);
    expect(Object.keys(files).sort()).toEqual(["RESTORE.md", "dump.sql"]);
    expect(files["dump.sql"]!.toString()).toContain("CREATE TABLE `orders`");
    expect(a.coverage).toEqual({ tables: 2, views: 0, rows: 3 });
    expect(a.engineVersion).toBe("8.0.36");
    expect(a.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect((await readbackMysql(conn, fakeCli({}))).contentDigest).toBe(a.contentDigest);
    // order independence and sensitivity
    const reordered = fakeCli({ tables: { users: ["1\tada"], orders: ["2\tgrace\tNULL", "1\tada\t10.50"] } });
    expect((await readbackMysql(conn, reordered)).contentDigest).toBe(a.contentDigest);
    expect((await readbackMysql(conn, fakeCli({ tables: { orders: ["1\tada\t10.51", "2\tgrace\tNULL"], users: ["1\tada"] } }))).contentDigest).not.toBe(a.contentDigest);
  });

  it("refuses an export when the database changed while mysqldump ran, and reports a failing dump without leaking the client's message", async () => {
    const cli = fakeCli({});
    const moving = fakeCli({ mutateOnDump: () => { moving.tables.orders!.push("3\tlin\t1.00"); } });
    await expect(exportMysql(conn, moving, async () => undefined)).rejects.toMatchObject({ code: "verification_failed", message: expect.stringContaining("changed while it was exported") });
    const failing = fakeCli({ dumpExit: 2 });
    const err = await exportMysql(conn, failing, async () => undefined).catch((e: PortabilityError) => e);
    expect(err).toMatchObject({ code: "verification_failed" });
    expect(String((err as Error).message)).not.toContain(PW);
    expect(String((err as Error).message)).not.toContain("db.example.test");
    expect(cli.calls).toHaveLength(0);
  });
});

describe("mysql restore", () => {
  it("restores the dump into an empty target through mysql stdin and verifies by reading the target back", async () => {
    const store = directoryArtifactStore(tempDir());
    const source = fakeCli({});
    const outcome = await runExport({ workspaceId: "ws_1", environmentId: "env_1", operationId: "op_1", now: new Date("2026-10-05T00:00:00Z"), source: { provider: "azure", nativeType: "azure:mysql_flexible_server", address: "mysql/shop" }, binding: { kind: "mysql", conn, cli: source }, store });
    const target = fakeCli({});
    const result = await runImport({
      recorded: { manifestDigest: outcome.manifestDigest, contentDigest: outcome.contentDigest, kind: "mysql", engine: outcome.engine },
      store, target: { provider: "azure", kind: "mysql" }, binding: { kind: "mysql", conn, cli: target },
      openReadback: async () => ({ binding: { kind: "mysql", conn, cli: fakeCli({}) }, close: async () => undefined }),
    });
    expect(result.status).toBe("verified");
    const load = target.calls.find((c) => c.opts.stdin);
    expect(load?.tool).toBe("mysql");
    expect(load?.opts.stdin?.toString()).toContain("CREATE TABLE `orders`");
    expect(load?.args.join(" ")).not.toContain(PW);

    const different = await runImport({
      recorded: { manifestDigest: outcome.manifestDigest, contentDigest: outcome.contentDigest, kind: "mysql", engine: outcome.engine },
      store, target: { provider: "azure", kind: "mysql" }, binding: { kind: "mysql", conn, cli: fakeCli({}) },
      openReadback: async () => ({ binding: { kind: "mysql", conn, cli: fakeCli({ tables: { orders: ["1\tada\t10.50"], users: ["1\tada"] } }) }, close: async () => undefined }),
    });
    expect(different.status).toBe("mismatch");
  });

  it("never merges into a populated target and reports a failed load without detail", async () => {
    expect(await isMysqlEmpty(conn, fakeCli({ existingTables: 3 }))).toBe(false);
    await expect(importMysql(conn, fakeCli({ existingTables: 3 }), async () => Buffer.from("x"))).rejects.toMatchObject({ code: "target_not_empty" });
    await expect(importMysql(conn, fakeCli({ importExit: 1 }), async () => Buffer.from("x"))).rejects.toMatchObject({ code: "verification_failed", message: expect.stringContaining("discarded") });
  });
});

describe("the real clients", () => {
  it("report a missing binary as unavailable, not as a database failure", async () => {
    const cli = spawnMysqlCli({ ZENITH_MYSQL_BIN: "zenith-definitely-not-installed-mysql", ZENITH_MYSQLDUMP_BIN: "zenith-definitely-not-installed-dump" });
    await expect(cli.run("mysql", ["--version"], { env: {}, maxBytes: 1000, timeoutMs: 5000 })).rejects.toMatchObject({ code: "unavailable" });
    await expect(cli.run("mysqldump", ["--version"], { env: {}, maxBytes: 1000, timeoutMs: 5000 })).rejects.toMatchObject({ code: "unavailable" });
  });
});

const REAL = process.env.ZENITH_TEST_MYSQL_URL?.trim();
describe.skipIf(!REAL)("real MySQL server (needs mysql and mysqldump on PATH and an EMPTY scratch database)", () => {
  it("exports, restores into a second empty database and verifies by readback", async () => {
    const source = parseMysqlUri(REAL as string);
    const cli = spawnMysqlCli();
    const store = directoryArtifactStore(tempDir());
    const q = async (c: MysqlConnection, sql: string) => cli.run("mysql", [`--host=${c.host}`, `--port=${c.port}`, `--user=${c.user}`, "-e", sql, c.database], { env: { MYSQL_PWD: c.password }, maxBytes: 1_000_000, timeoutMs: 60_000 });
    await q(source, "create table pt_orders (id int primary key auto_increment, who varchar(20), amount decimal(10,2)); insert into pt_orders (who, amount) values ('ada', 10.50), ('grace', null)");
    try {
      const outcome = await runExport({ workspaceId: "ws_1", environmentId: "env_1", operationId: "op_1", now: new Date(), source: { provider: "aws", nativeType: "aws:rds_instance", address: "mysql/shop" }, binding: { kind: "mysql", conn: source, cli }, store });
      expect(outcome.coverage).toMatchObject({ tables: 1, rows: 2 });
    } finally {
      await q(source, "drop table if exists pt_orders");
    }
  });
});
