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
import { describe, expect, it, vi } from "vitest";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportMysql, importMysql, isMysqlEmpty, parseMysqlUri, readbackMysql, spawnMysqlCli, type CliOptions, type CliResult, type MysqlCli, type MysqlConnection } from "@/lib/portability/engines/mysql";
import { openMysql, type OpenBinding } from "@/lib/portability/connect";
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

  it("revalidates every invocation, pins only the vetted address and excludes ambient redirects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zenith-mysql-wrapper-test-"));
    let restoreSpawn: () => void = () => undefined;
    try {
      const observedSpawn = vi.spyOn(childProcess, "spawn");
      syncBuiltinESMExports();
      restoreSpawn = () => { observedSpawn.mockRestore(); syncBuiltinESMExports(); };
      const bin = join(dir, "client");
      const receipt = join(dir, "calls");
      await writeFile(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(receipt)}, 'call\\n'); process.stdout.write(JSON.stringify({args:process.argv.slice(2),keys:Object.keys(process.env).filter(k=>k.startsWith('MYSQL_')).sort()}));`, { mode: 0o700 });
      await chmod(bin, 0o700);
      let reads = 0;
      const env = { ZENITH_MYSQL_BIN: bin, MYSQL_HOST: "forbidden", MYSQL_TCP_PORT: "1", HOME: "forbidden" };
      const cli = spawnMysqlCli(env, { allowPrivate: true, lookup: async () => ++reads === 1 ? ["192.168.1.10"] : ["192.168.1.10", "169.254.169.254"] });
      const args = ["--host=db.example.test", "--port=3306", "--user=app", "--ssl-mode=DISABLED", "-e", "select 1", "shop"];
      const first = await cli.run("mysql", args, { env: { MYSQL_PWD: PW, MYSQL_HOST: "forbidden", MYSQL_TEST_LOGIN_FILE: "forbidden" }, maxBytes: 4096, timeoutMs: 5000 });
      expect(first.code).toBe(0);
      expect(observedSpawn.mock.calls.length).toBe(1);
      const parsed = JSON.parse(first.stdout.toString()) as { args: string[]; keys: string[] };
      expect(parsed.args).toContain("--host=192.168.1.10");
      expect(parsed.args).not.toContain("--host=db.example.test");
      expect(parsed.args.slice(0, 2)).toEqual(["--no-defaults", "--no-login-paths"]);
      for (const required of ["--protocol=TCP", "--skip-reconnect", "--binary-mode", "--local-infile=0", "--ssl-mode=DISABLED"]) expect(parsed.args).toContain(required);
      expect(parsed.keys).toEqual(["MYSQL_PWD", "MYSQL_TEST_LOGIN_FILE"]);
      await expect(cli.run("mysql", args, { env: { MYSQL_PWD: PW }, maxBytes: 4096, timeoutMs: 5000 })).rejects.toMatchObject({ code: "invalid_input" });
      expect(reads).toBe(2);
      expect(observedSpawn.mock.calls.length).toBe(1);
      expect(await readFile(receipt, "utf8")).toBe("call\n");
      expect(args[0]).toBe("--host=db.example.test");
    } finally { restoreSpawn(); await rm(dir, { recursive: true }); }
  });

  it("refuses hostname TLS, private destinations without opt-in and caller-supplied redirect options before spawning", async () => {
    let reads = 0;
    const cli = spawnMysqlCli({ ZENITH_MYSQL_BIN: "zenith-definitely-not-installed-mysql" }, { lookup: async () => { reads++; return ["93.184.216.34"]; } });
    const base = ["--host=db.example.test", "--port=3306", "--user=app", "--ssl-mode=REQUIRED", "-e", "select 1", "shop"];
    await expect(cli.run("mysql", base, { env: { MYSQL_PWD: PW }, maxBytes: 4096, timeoutMs: 5000 })).rejects.toMatchObject({ code: "unsupported_objects" });
    expect(reads).toBe(1);
    for (const redirect of ["--host=127.0.0.1", "--socket=/tmp/other", "--protocol=SOCKET", "--defaults-file=/tmp/other", "--dns-srv-name=other", "--ssl-mode=PREFERRED", "--ssl-ca=/tmp/other", "--reconnect"]) {
      await expect(cli.run("mysql", [...base.slice(0, -1), redirect, "shop"], { env: { MYSQL_PWD: PW }, maxBytes: 4096, timeoutMs: 5000 })).rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const databaseOption of ["--reconnect", "--local-infile", "--help"]) await expect(cli.run("mysql", [...base.slice(0, -1), databaseOption], { env: { MYSQL_PWD: PW }, maxBytes: 4096, timeoutMs: 5000 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(reads).toBe(1);
    const local = [...base]; local[0] = "--host=127.0.0.1"; local[3] = "--ssl-mode=DISABLED";
    await expect(cli.run("mysql", local, { env: { MYSQL_PWD: PW }, maxBytes: 4096, timeoutMs: 5000 })).rejects.toMatchObject({ code: "invalid_input" });
    const publicPlain = [...base]; publicPlain[3] = "--ssl-mode=DISABLED";
    await expect(cli.run("mysql", publicPlain, { env: { MYSQL_PWD: PW }, maxBytes: 4096, timeoutMs: 5000 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(spawnMysqlCli({}, { allowPrivate: true, lookup: async () => ["93.184.216.34"] }).run("mysql", publicPlain, { env: { MYSQL_PWD: PW }, maxBytes: 4096, timeoutMs: 5000 })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

const REAL = process.env.ZENITH_TEST_MYSQL_URL?.trim();
describe.skipIf(!REAL)("real MySQL server (needs mysql and mysqldump on PATH and an EMPTY scratch database)", () => {
  it("exports, restores into a second empty database and verifies by readback", async () => {
    const dnsUri = new URL(REAL as string);
    dnsUri.hostname = "owned-mysql-dns.example.test";
    dnsUri.searchParams.set("ssl", "required");
    const openedNegative: OpenBinding[] = [];
    // A call-through observer, never a fake CLI or replacement success. Compare
    // only its scalar count so an unexpected call cannot print credential envs.
    const spawned = vi.spyOn(childProcess, "spawn");
    syncBuiltinESMExports();
    const invoke = (opened: OpenBinding) => {
      if (opened.binding.kind !== "mysql") throw new Error("The native MySQL negative opened the wrong engine.");
      const { conn: c, cli } = opened.binding;
      return cli.run("mysql", [`--host=${c.host}`, `--port=${c.port}`, `--user=${c.user}`, "--ssl-mode=REQUIRED", "--batch", "--skip-column-names", "-e", "select 1", c.database], { env: { MYSQL_PWD: c.password }, maxBytes: 4096, timeoutMs: 5000 });
    };
    try {
      let firstReads = 0;
      const rebinding = await openMysql(dnsUri.toString(), { allowPrivate: false, lookup: async () => ++firstReads === 1 ? ["93.184.216.34"] : ["10.0.0.1"] });
      openedNegative.push(rebinding);
      await expect(invoke(rebinding)).rejects.toMatchObject({ code: "invalid_input" });
      expect(firstReads).toBe(2); expect(spawned.mock.calls.length).toBe(0);

      let retryReads = 0;
      const retry = await openMysql(dnsUri.toString(), { allowPrivate: false, lookup: async () => ++retryReads <= 2 ? ["93.184.216.34"] : ["10.0.0.1"] });
      openedNegative.push(retry);
      await expect(invoke(retry)).rejects.toMatchObject({ code: "unsupported_objects" });
      await expect(invoke(retry)).rejects.toMatchObject({ code: "invalid_input" });
      expect(retryReads).toBe(3); expect(spawned.mock.calls.length).toBe(0);
    } finally {
      spawned.mockRestore();
      syncBuiltinESMExports();
      const closed = await Promise.allSettled(openedNegative.map((opened) => opened.close()));
      if (closed.some((result) => result.status === "rejected")) throw new Error("Native MySQL negative binding cleanup was unconfirmed.");
    }
    const sourceOpened = await openMysql(REAL as string, { allowPrivate: true });
    if (sourceOpened.binding.kind !== "mysql") throw new Error("The native MySQL fixture opened the wrong engine.");
    const source = sourceOpened.binding.conn;
    const cli = sourceOpened.binding.cli;
    const artifactDir = await mkdtemp(join(tmpdir(), "zenith-mysql-engine-"));
    const artifactIdentity = await lstat(artifactDir);
    const store = directoryArtifactStore(artifactDir);
    const q = async (c: MysqlConnection, sql: string) => {
      const result = await spawnMysqlCli(process.env, { allowPrivate: true }).run("mysql", [`--host=${c.host}`, `--port=${c.port}`, `--user=${c.user}`, `--ssl-mode=${c.ssl === "disabled" ? "DISABLED" : "REQUIRED"}`, "--batch", "--skip-column-names", "-e", sql, c.database], { env: { MYSQL_PWD: c.password }, maxBytes: 1_000_000, timeoutMs: 60_000 });
      expect(result.code, "Stock MySQL fixture command failed").toBe(0);
      return result.stdout.toString();
    };
    const targetName = `zenith_restore_${randomUUID().replaceAll("-", "")}`;
    const target = { ...source, database: targetName };
    const targetUri = new URL(REAL as string); targetUri.pathname = `/${targetName}`;
    let targetOpened: OpenBinding | undefined;
    let sourceOwned = false;
    let targetOwned = false;
    try {
      expect(await isMysqlEmpty(source, cli)).toBe(true);
      await q(source, "create table pt_orders (id int primary key auto_increment, who varchar(20), amount decimal(10,2))");
      sourceOwned = true;
      await q(source, "insert into pt_orders (who, amount) values ('ada', 10.50), ('grace', null)");
      await q(source, `create database \`${targetName}\``);
      targetOwned = true;
      targetOpened = await openMysql(targetUri.toString(), { allowPrivate: true });
      const outcome = await runExport({ workspaceId: "ws_1", environmentId: "env_1", operationId: "op_1", now: new Date(), source: { provider: "aws", nativeType: "aws:rds_instance", address: "mysql/shop" }, binding: sourceOpened.binding, store });
      expect(outcome.coverage).toMatchObject({ tables: 1, rows: 2 });
      const restored = await runImport({
        recorded: { manifestDigest: outcome.manifestDigest, contentDigest: outcome.contentDigest, kind: "mysql", engine: outcome.engine },
        store, target: { provider: "aws", kind: "mysql" }, binding: targetOpened.binding,
        openReadback: async () => openMysql(targetUri.toString(), { allowPrivate: true }),
      });
      expect(restored.status).toBe("verified");
      expect(restored.coverage).toMatchObject({ tables: 1, rows: 2 });
      // Independent stock-client readback, not a digest derived from the engine.
      expect(await q(target, "select id, who, amount from pt_orders order by id")).toBe("1\tada\t10.50\n2\tgrace\tNULL\n");
    } finally {
      // Each positively acknowledged create owns exactly this UUID database or
      // fixed source table. Unknown delivery is retained; no IF EXISTS cleanup.
      const cleanup = await Promise.allSettled([
        (async () => {
          if (!targetOwned) return;
          await q(source, `drop database \`${targetName}\``);
          expect(await q(source, `select count(*) from information_schema.schemata where schema_name = '${targetName}'`)).toBe("0\n");
        })(),
        (async () => {
          if (!sourceOwned) return;
          await q(source, "drop table pt_orders");
          expect(await isMysqlEmpty(source, cli)).toBe(true);
        })(),
        sourceOpened.close(),
        ...(targetOpened ? [targetOpened.close()] : []),
      ]);
      if (cleanup.some((result) => result.status === "rejected")) throw new Error("Owned MySQL fixture cleanup was unconfirmed; artifacts were retained.");
      const current = await lstat(artifactDir);
      expect(current.isSymbolicLink()).toBe(false); expect(current.dev).toBe(artifactIdentity.dev); expect(current.ino).toBe(artifactIdentity.ino); expect(current.uid).toBe(artifactIdentity.uid);
      await rm(artifactDir, { recursive: true });
      await expect(lstat(artifactDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
