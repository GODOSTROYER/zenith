/**
 * PROD-LIFE-11 gap: MySQL over TLS to a DNS hostname through the in-process
 * mysql2 transport. These mirror the Postgres/S3 rebinding tests in
 * dns-transport.test.ts: the client dials ONLY an address that
 * `resolveConnectableHost` validated for THIS connection (re-validated on every
 * connection and retry, all answers must pass), the TLS identity is the
 * original hostname, and no resolved address reaches an error.
 *
 * The peer is an owned wire fixture (not a MySQL engine). The real-engine lane
 * at the bottom is gated by ZENITH_TEST_MYSQL_DNS_TLS_URL and has not been run
 * by the build worker.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importMysql, readbackMysql, spawnMysqlCli, type MysqlConnection } from "@/lib/portability/engines/mysql";
import { splitStatements } from "@/lib/portability/engines/mysql-inprocess";
import { openMysql } from "@/lib/portability/connect";
import { runExport, runImport } from "@/lib/portability/service";
import { directoryArtifactStore } from "./support";
import { testTlsIdentity } from "./tls-support";
import { mysqlWireFixture, T, type FixtureAnswer, type WireFixture } from "./mysql-wire-fixture";

const HOST = "db.example.test";
const PW = ["owned", "fixture", "secret"].join("-");
const cleanups: (() => Promise<void>)[] = [];
let dir: string;
let identity: ReturnType<typeof testTlsIdentity>;
let strangerIdentity: ReturnType<typeof testTlsIdentity>;
let caFile: string;
let strangerCaFile: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "zenith-mysql-inprocess-"));
  identity = testTlsIdentity(HOST);
  strangerIdentity = testTlsIdentity("other.example.test");
  caFile = join(dir, "ca.pem");
  strangerCaFile = join(dir, "stranger.pem");
  await writeFile(caFile, identity.cert, { mode: 0o600 });
  await writeFile(strangerCaFile, strangerIdentity.cert, { mode: 0o600 });
}, 60_000);
afterAll(async () => { await rm(dir, { recursive: true }); });
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });

async function wire(opts: Parameters<typeof mysqlWireFixture>[0]): Promise<WireFixture> {
  const fixture = await mysqlWireFixture(opts);
  cleanups.push(() => fixture.close());
  return fixture;
}

const args = (f: WireFixture, sql: string, host = HOST) => [`--host=${host}`, `--port=${f.port}`, "--user=app", "--ssl-mode=REQUIRED", "--batch", "--skip-column-names", "--binary-as-hex", "-e", sql, "shop"];
const opts = { env: { MYSQL_PWD: PW }, maxBytes: 1_000_000, timeoutMs: 15_000 };
const privateOk = (lookup: () => Promise<string[]>, ca = caFile) => spawnMysqlCli({ ZENITH_MYSQL_CA_FILE: ca }, { allowPrivate: true, lookup });
const loopback = async () => ["127.0.0.1"];
const answerOne = (sql: string): FixtureAnswer | undefined => (sql === "select 1" ? { fields: [{ name: "answer", type: T.LONG }], rows: [["1"]] } : undefined);

describe("in-process MySQL over verified TLS to a DNS hostname", () => {
  it("dials only the validated literal, sends the hostname as SNI and authenticates over the verified channel", async () => {
    const f = await wire({ identity, answer: answerOne });
    const dial = vi.spyOn(net, "createConnection");
    const result = await privateOk(loopback).run("mysql", args(f, "select 1"), opts);
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe("1\n");
    expect(result.stderr).toBe("");
    expect(f.stats.sni).toEqual([HOST]);
    expect(f.stats.encryptedAuth).toBe(1);
    expect(f.stats.plaintextAuth).toBe(0);
    expect(dial.mock.calls).toHaveLength(1);
    const dialed = dial.mock.calls[0]![0] as unknown as net.TcpNetConnectOpts;
    expect(dialed.host).toBe("127.0.0.1");
    expect(dialed.host).not.toBe(HOST);
  });

  it("refuses a CA-valid certificate that does not name the hostname before any credential is sent", async () => {
    const f = await wire({ identity: strangerIdentity, answer: answerOne });
    await expect(privateOk(loopback, strangerCaFile).run("mysql", args(f, "select 1"), opts)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.stats.encryptedAuth).toBe(0);
    expect(f.stats.queries).toEqual([]);
  });

  it("refuses an untrusted CA before any credential is sent", async () => {
    const f = await wire({ identity, answer: answerOne });
    await expect(privateOk(loopback, strangerCaFile).run("mysql", args(f, "select 1"), opts)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.stats.encryptedAuth).toBe(0);
    expect(f.stats.queries).toEqual([]);
  });

  it("refuses a server that does not offer TLS rather than downgrading", async () => {
    const f = await wire({ tls: false, answer: answerOne });
    await expect(privateOk(loopback).run("mysql", args(f, "select 1"), opts)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.stats.encryptedAuth).toBe(0);
    expect(f.stats.queries).toEqual([]);
  });

  it("never puts a resolved address or port in an error", async () => {
    const f = await wire({ identity, answer: answerOne });
    const error = await privateOk(loopback, strangerCaFile).run("mysql", args(f, "select 1"), opts).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).message} ${JSON.stringify(error)}`;
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain(String(f.port));
    expect(text).not.toContain(PW);
  });
});

describe("rebinding, all-answer rejection and private-host opt-in", () => {
  it("re-validates every new connection: a later never-allowed answer is refused with no second dial", async () => {
    const f = await wire({ identity, answer: answerOne });
    let reads = 0;
    const cli = privateOk(async () => (++reads === 1 ? ["127.0.0.1"] : ["127.0.0.1", "169.254.169.254"]));
    expect((await cli.run("mysql", args(f, "select 1"), opts)).code).toBe(0);
    await expect(cli.run("mysql", args(f, "select 1"), opts)).rejects.toMatchObject({ code: "invalid_input" });
    expect(reads).toBe(2);
    expect(f.stats.connections).toBe(1);
  });

  it("rejects the whole answer set when any address is not connectable, before dialing", async () => {
    const f = await wire({ identity, answer: answerOne });
    const dial = vi.spyOn(net, "createConnection");
    await expect(privateOk(async () => ["127.0.0.1", "169.254.169.254"]).run("mysql", args(f, "select 1"), opts)).rejects.toMatchObject({ code: "invalid_input" });
    expect(dial).not.toHaveBeenCalled();
    expect(f.stats.connections).toBe(0);
  });

  it("refuses private and loopback answers without the operator opt-in, before dialing", async () => {
    const f = await wire({ identity, answer: answerOne });
    const dial = vi.spyOn(net, "createConnection");
    const cli = spawnMysqlCli({ ZENITH_MYSQL_CA_FILE: caFile }, { allowPrivate: false, lookup: loopback });
    await expect(cli.run("mysql", args(f, "select 1"), opts)).rejects.toMatchObject({ code: "invalid_input" });
    const privateOnly = spawnMysqlCli({ ZENITH_MYSQL_CA_FILE: caFile }, { allowPrivate: false, lookup: async () => ["10.0.0.5"] });
    await expect(privateOnly.run("mysql", args(f, "select 1"), opts)).rejects.toMatchObject({ code: "invalid_input" });
    expect(dial).not.toHaveBeenCalled();
    expect(f.stats.connections).toBe(0);
  });

  it("a transient connect failure retries with a fresh validation each time", async () => {
    const f = await wire({ identity, answer: answerOne, dropFirst: 1 });
    let reads = 0;
    const result = await privateOk(async () => { reads++; return ["127.0.0.1"]; }).run("mysql", args(f, "select 1"), opts);
    expect(result.code).toBe(0);
    expect(reads).toBe(2);
    expect(f.stats.connections).toBe(2);
  });

  it("a rebind between retries is refused: the retry validates again and never dials the new answer", async () => {
    const f = await wire({ identity, answer: answerOne, dropFirst: 1 });
    let reads = 0;
    await expect(privateOk(async () => (++reads === 1 ? ["127.0.0.1"] : ["169.254.169.254"])).run("mysql", args(f, "select 1"), opts)).rejects.toMatchObject({ code: "invalid_input" });
    expect(reads).toBe(2);
    expect(f.stats.connections).toBe(1);
  });

  it("literal-IP TLS is not routed in-process (the stock client path and its refusals are unchanged)", async () => {
    const dial = vi.spyOn(net, "createConnection");
    const cli = spawnMysqlCli({ ZENITH_MYSQL_BIN: "zenith-definitely-not-installed-mysql" }, { allowPrivate: true });
    await expect(cli.run("mysql", ["--host=127.0.0.1", "--port=3306", "--user=app", "--ssl-mode=REQUIRED", "-e", "select 1", "shop"], opts)).rejects.toMatchObject({ code: "unavailable" });
    expect(dial).not.toHaveBeenCalled();
  });
});

describe("rendering matches the stock client's batch output", () => {
  it("prints NULL, batch escapes, hex for binary columns and plain numbers", async () => {
    const f = await wire({
      identity,
      answer: () => ({
        fields: [{ name: "a", type: T.LONG, charset: 63 }, { name: "b", type: T.VAR_STRING }, { name: "c", type: T.VAR_STRING }, { name: "d", type: T.BLOB, charset: 63 }],
        rows: [["1", null, "x\ty\nz\\w", Buffer.from("deadbeef", "hex")], ["2", "", "plain", Buffer.alloc(0)]],
      }),
    });
    const result = await privateOk(loopback).run("mysql", args(f, "select a, b, c, d from t"), opts);
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe("1\tNULL\tx\\ty\\nz\\\\w\t0xDEADBEEF\n2\t\tplain\t0x\n");
  });

  it("reports a server-side error as an exit status without server text", async () => {
    const f = await wire({ identity, answer: () => ({ error: true }) });
    const result = await privateOk(loopback).run("mysql", args(f, "select nonsense"), opts);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.length).toBe(0);
  });

  it("enforces the output limit as limit_exceeded", async () => {
    const f = await wire({ identity, answer: () => ({ fields: [{ name: "v", type: T.VAR_STRING }], rows: [["x".repeat(500)], ["y".repeat(500)]] }) });
    await expect(privateOk(loopback).run("mysql", args(f, "select v from t"), { ...opts, maxBytes: 600 })).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});

describe("restore script splitting", () => {
  it("honours quotes, comments, version comments and the DELIMITER directive", () => {
    const script = [
      "-- header comment",
      "SET NAMES utf8mb4;",
      "/* plain */ CREATE TABLE t (id int);",
      "INSERT INTO t VALUES (1,'a;b'),(2,'it''s'),(3,\"q;\"),(4,'back\\';slash');",
      "/*!40101 SET @x=1 */;",
      "# hash comment;",
      "DELIMITER ;;",
      "CREATE TRIGGER tg BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.id = 1; SET @y = 2; END;;",
      "DELIMITER ;",
      "SELECT `a;b` FROM t;",
    ].join("\n");
    expect(splitStatements(script)).toEqual([
      "SET NAMES utf8mb4",
      "CREATE TABLE t (id int)",
      "INSERT INTO t VALUES (1,'a;b'),(2,'it''s'),(3,\"q;\"),(4,'back\\';slash')",
      "/*!40101 SET @x=1 */",
      "CREATE TRIGGER tg BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.id = 1; SET @y = 2; END",
      "SELECT `a;b` FROM t",
    ]);
  });

  it("refuses an unterminated string or comment instead of sending a truncated statement", () => {
    expect(() => splitStatements("INSERT INTO t VALUES ('open;")).toThrowError(expect.objectContaining({ code: "verification_failed" }));
    expect(() => splitStatements("SELECT 1; /* open")).toThrowError(expect.objectContaining({ code: "verification_failed" }));
  });

  it("runs a restore script statement by statement on one verified connection, with no multi-statement mode", async () => {
    const f = await wire({ identity });
    const script = Buffer.from("SET NAMES utf8mb4;\nCREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\nDELIMITER ;;\nCREATE TRIGGER tg BEFORE INSERT ON t FOR EACH ROW SET NEW.id = 1;;\nDELIMITER ;\n");
    const result = await privateOk(loopback).run("mysql", [`--host=${HOST}`, `--port=${f.port}`, "--user=app", "--ssl-mode=REQUIRED", "--default-character-set=utf8mb4", "--batch", "shop"], { ...opts, stdin: script });
    expect(result.code).toBe(0);
    expect(f.stats.connections).toBe(1);
    expect(f.stats.queries).toEqual(["SET NAMES utf8mb4", "CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)", "CREATE TRIGGER tg BEFORE INSERT ON t FOR EACH ROW SET NEW.id = 1"]);
  });

  it("stops at the first failing statement and reports only an exit status", async () => {
    const f = await wire({ identity, answer: (sql) => (sql.startsWith("INSERT") ? { error: true } : undefined) });
    const script = Buffer.from("CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);\n");
    const result = await privateOk(loopback).run("mysql", [`--host=${HOST}`, `--port=${f.port}`, "--user=app", "--ssl-mode=REQUIRED", "--batch", "shop"], { ...opts, stdin: script });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(f.stats.queries).toEqual(["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1)"]);
  });
});

describe("in-process dump", () => {
  const text = (rows: string[][]): FixtureAnswer => ({ fields: rows[0]!.map((_, i) => ({ name: `c${i}`, type: T.VAR_STRING })), rows });
  const answer = (sql: string): FixtureAnswer | undefined => {
    if (/from information_schema\.tables/.test(sql)) return text([["t1", "BASE TABLE"], ["v2", "VIEW"], ["v1", "VIEW"]]);
    if (sql === "show create table `t1`") return text([["t1", "CREATE TABLE `t1` (\n  `id` int NOT NULL,\n  `name` varchar(20) DEFAULT NULL,\n  `blob` blob,\n  PRIMARY KEY (`id`)\n)"]]);
    if (/from information_schema\.columns/.test(sql)) return text([["id"], ["name"], ["blob"]]);
    if (sql === "select `id`, `name`, `blob` from `t1`") {
      return {
        fields: [{ name: "id", type: T.LONG, charset: 63 }, { name: "name", type: T.VAR_STRING }, { name: "blob", type: T.BLOB, charset: 63 }],
        rows: [["1", "o'brien", Buffer.from([0, 255])], ["2", null, Buffer.alloc(0)]],
      };
    }
    if (sql === "show create view `v1`") return text([["v1", "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v1` AS select `t1`.`id` AS `id` from `t1`"]]);
    if (sql === "show create view `v2`") return text([["v2", "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v2` AS select `v1`.`id` AS `id` from `v1`"]]);
    if (/from information_schema\.triggers/.test(sql)) return text([["tg"]]);
    if (sql === "show create trigger `tg`") return text([["tg", "STRICT_TRANS_TABLES", "CREATE DEFINER=`root`@`%` TRIGGER `tg` BEFORE INSERT ON `t1` FOR EACH ROW SET NEW.id = 1"]]);
    return undefined;
  };

  it("dumps tables, rows, views (dependencies first) and triggers read-only from one consistent snapshot", async () => {
    const f = await wire({ identity, answer });
    const result = await privateOk(loopback).run("mysqldump", [`--host=${HOST}`, `--port=${f.port}`, "--user=app", "--ssl-mode=REQUIRED", "--default-character-set=utf8mb4", "--single-transaction", "--skip-comments", "--skip-add-locks", "--no-tablespaces", "--set-gtid-purged=OFF", "--hex-blob", "--triggers", "shop"], opts);
    expect(result.code).toBe(0);
    const sql = result.stdout.toString();
    expect(sql).toContain("CREATE TABLE `t1`");
    expect(sql).toContain("INSERT INTO `t1` (`id`, `name`, `blob`) VALUES");
    expect(sql).toContain("(1,'o\\'brien',0x00ff)");
    expect(sql).toContain("(2,NULL,'')");
    expect(sql.indexOf("VIEW `v1`")).toBeGreaterThan(-1);
    expect(sql.indexOf("VIEW `v1`")).toBeLessThan(sql.indexOf("VIEW `v2`"));
    expect(sql).toContain("DELIMITER ;;");
    expect(sql).toContain("CREATE TRIGGER `tg`");
    expect(sql).not.toMatch(/DEFINER=/i);
    expect(f.stats.queries).toContain("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    expect(f.stats.queries[f.stats.queries.length - 1]).toBe("ROLLBACK");
    expect(f.stats.queries.filter((q) => /^\s*(insert|update|delete|drop|create|alter|truncate|grant)\b/i.test(q))).toEqual([]);
    // The dump is a script the restore path can read back.
    expect(splitStatements(sql).some((s) => s.startsWith("CREATE TRIGGER `tg`"))).toBe(true);
  });

  it("refuses an over-limit dump as limit_exceeded", async () => {
    const f = await wire({ identity, answer });
    await expect(privateOk(loopback).run("mysqldump", [`--host=${HOST}`, `--port=${f.port}`, "--user=app", "--ssl-mode=REQUIRED", "--single-transaction", "shop"], { ...opts, maxBytes: 200 })).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});

const REAL = process.env.ZENITH_TEST_MYSQL_DNS_TLS_URL?.trim();
const REAL_IP = process.env.ZENITH_TEST_MYSQL_IP_URL?.trim();
describe.skipIf(!REAL)("real MySQL server over TLS by DNS hostname (ZENITH_TEST_MYSQL_DNS_TLS_URL, ZENITH_MYSQL_CA_FILE; EMPTY scratch database)", () => {
  it("exports, restores into a second empty database and verifies by readback through the in-process path", async () => {
    const uri = new URL(REAL as string);
    expect(net.isIP(uri.hostname)).toBe(0);
    const sourceOpened = await openMysql(REAL as string, { allowPrivate: true });
    if (sourceOpened.binding.kind !== "mysql") throw new Error("The native MySQL fixture opened the wrong engine.");
    const source = sourceOpened.binding.conn;
    const cli = sourceOpened.binding.cli;
    const q = async (c: MysqlConnection, sql: string): Promise<string> => {
      const r = await cli.run("mysql", [`--host=${c.host}`, `--port=${c.port}`, `--user=${c.user}`, "--ssl-mode=REQUIRED", "--batch", "--skip-column-names", "-e", sql, c.database], { env: { MYSQL_PWD: c.password }, maxBytes: 1_000_000, timeoutMs: 60_000 });
      expect(r.code, "In-process MySQL fixture statement failed").toBe(0);
      return r.stdout.toString();
    };
    const artifactDir = await mkdtemp(join(tmpdir(), "zenith-mysql-inprocess-art-"));
    const store = directoryArtifactStore(artifactDir);
    const targetName = `zenith_restore_${randomUUID().replaceAll("-", "")}`;
    const targetUri = new URL(REAL as string); targetUri.pathname = `/${targetName}`;
    const target = { ...source, database: targetName };
    let sourceOwned = false;
    let targetOwned = false;
    let targetOpened: Awaited<ReturnType<typeof openMysql>> | undefined;
    try {
      await q(source, "create table pt_orders (id int primary key auto_increment, who varchar(20), amount decimal(10,2), raw varbinary(8))");
      sourceOwned = true;
      await q(source, "insert into pt_orders (who, amount, raw) values ('ada', 10.50, 0x00ff), ('gr;ace', null, null)");
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
      expect(await q(target, "select id, who, amount, hex(raw) from pt_orders order by id")).toBe("1\tada\t10.50\t00FF\n2\tgr;ace\tNULL\tNULL\n");
      if (REAL_IP) {
        // The same database through the stock client by literal IP must produce the same logical digest.
        const ipOpened = await openMysql(REAL_IP, { allowPrivate: true });
        if (ipOpened.binding.kind !== "mysql") throw new Error("The literal-IP fixture opened the wrong engine.");
        const viaDns = await readbackMysql(source, cli);
        const viaIp = await readbackMysql(ipOpened.binding.conn, ipOpened.binding.cli);
        expect(viaDns.contentDigest).toBe(viaIp.contentDigest);
        await ipOpened.close();
      }
      // A populated target is never merged into, on this path too.
      await expect(importMysql(target, cli, async () => Buffer.from("select 1;"))).rejects.toMatchObject({ code: "target_not_empty" });
    } finally {
      const cleanup = await Promise.allSettled([
        (async () => { if (targetOwned) await q(source, `drop database \`${targetName}\``); })(),
        (async () => { if (sourceOwned) await q(source, "drop table pt_orders"); })(),
        sourceOpened.close(),
        ...(targetOpened ? [targetOpened.close()] : []),
      ]);
      await rm(artifactDir, { recursive: true });
      if (cleanup.some((r) => r.status === "rejected")) throw new Error("Owned MySQL DNS TLS fixture cleanup was unconfirmed.");
    }
  });
});
