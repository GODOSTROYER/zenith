/**
 * MySQL export, import and readback (`mysql-cli-v1`) through the stock
 * `mysqldump` and `mysql` clients, which the worker must have installed. No
 * Node MySQL driver is a dependency of this repository, so the real tools do the
 * work and this module owns what surrounds them: refusing what it cannot carry,
 * pinning the password into the child's environment (never argv), and the
 * independent logical readback.
 *
 * Carried: tables, views and triggers of ONE database, with data. Refused:
 * stored routines and events (they are not in a default mysqldump either, so an
 * export that left them out would be incomplete without saying so).
 *
 * The logical digest is computed by plain `mysql` queries: column and index
 * structure from information_schema, and every table's rows as the client prints
 * them (sorted lines, hashed). It is computed on the source before and after the
 * dump (a changing source is refused) and recomputed on the restored target.
 *
 * Evidence level: `contract`. The command construction, refusals and digest
 * logic are tested against a recorded-behaviour fake CLI; a real server run is
 * env-gated (ZENITH_TEST_MYSQL_URL) and has not been executed in this build.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { digest } from "@/lib/controlplane/digest";
import { DEFAULT_LIMITS, PortabilityError, type EmitFile, type EngineExport, type EngineLimits, type EngineReadback } from "../types";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

export interface MysqlConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: "required" | "disabled";
}

/** Parse `mysql://user:pass@host:port/db?ssl=disabled`. Errors never echo the URI. */
export function parseMysqlUri(uri: string): MysqlConnection {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new PortabilityError("invalid_input", "The MySQL connection secret is not a valid URI.");
  }
  if (url.protocol !== "mysql:") throw new PortabilityError("invalid_input", "The MySQL connection secret must be a mysql:// URI.");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  if (!url.hostname || !user || !/^[A-Za-z0-9_$.-]{1,64}$/.test(database) || !/^[A-Za-z0-9_.@$-]{1,64}$/.test(user)) {
    throw new PortabilityError("invalid_input", "The MySQL connection secret needs a host, user and database name.");
  }
  const port = url.port ? Number(url.port) : 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PortabilityError("invalid_input", "The MySQL connection secret has an invalid port.");
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port, user, password: decodeURIComponent(url.password), database, ssl: url.searchParams.get("ssl") === "disabled" ? "disabled" : "required" };
}

export interface CliResult { code: number; stdout: Buffer; stderr: string }
export interface CliOptions { env: Record<string, string>; stdin?: Buffer; maxBytes: number; timeoutMs: number }
export interface MysqlCli {
  run(tool: "mysqldump" | "mysql", args: string[], opts: CliOptions): Promise<CliResult>;
}

/** The real clients. Binary names can be pinned with ZENITH_MYSQLDUMP_BIN / ZENITH_MYSQL_BIN. */
export function spawnMysqlCli(env: Record<string, string | undefined> = process.env): MysqlCli {
  return {
    run(tool, args, opts) {
      const bin = tool === "mysqldump" ? env.ZENITH_MYSQLDUMP_BIN || "mysqldump" : env.ZENITH_MYSQL_BIN || "mysql";
      return new Promise<CliResult>((resolve, reject) => {
        const child = spawn(bin, args, { shell: false, env: { PATH: process.env.PATH ?? "", ...opts.env } as unknown as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
        const out: Buffer[] = [];
        let size = 0;
        let stderr = "";
        let overflow = false;
        const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            overflow = true;
            child.kill("SIGKILL");
            return;
          }
          out.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < 2000) stderr += chunk.toString("utf8");
        });
        child.on("error", (err: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          reject(err.code === "ENOENT" ? new PortabilityError("unavailable", `${tool} is not installed on this worker.`) : new PortabilityError("unavailable", `${tool} could not be started.`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (overflow) return reject(new PortabilityError("limit_exceeded", "The MySQL output exceeded the export limit."));
          resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr });
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(opts.stdin);
      });
    },
  };
}

function connArgs(c: MysqlConnection): string[] {
  return [`--host=${c.host}`, `--port=${c.port}`, `--user=${c.user}`, `--ssl-mode=${c.ssl === "required" ? "REQUIRED" : "DISABLED"}`, "--default-character-set=utf8mb4"];
}

const TIMEOUT_MS = 30 * 60_000;

function failure(what: string, r: CliResult): PortabilityError {
  // The client's stderr can carry host names and server messages; only the exit status leaves this module.
  return new PortabilityError("verification_failed", `${what} failed (exit ${r.code}).`);
}

async function query(cli: MysqlCli, c: MysqlConnection, sql: string, limits: EngineLimits): Promise<string[][]> {
  const r = await cli.run("mysql", [...connArgs(c), "--batch", "--skip-column-names", "--binary-as-hex", "-e", sql, c.database], { env: { MYSQL_PWD: c.password }, maxBytes: limits.maxBytes, timeoutMs: TIMEOUT_MS });
  if (r.code !== 0) throw failure("A MySQL query", r);
  const text = r.stdout.toString("utf8");
  return text.length === 0 ? [] : text.replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
}

const ident = (name: string): string => {
  if (!/^[A-Za-z0-9_$ .-]{1,64}$/.test(name)) throw new PortabilityError("unsupported_objects", "A table name has characters the MySQL export does not carry.");
  return `\`${name.replace(/`/g, "``")}\``;
};

async function unsupportedObjects(cli: MysqlCli, c: MysqlConnection, limits: EngineLimits): Promise<string[]> {
  const rows = await query(cli, c, "select 'routine', routine_name from information_schema.routines where routine_schema = database() union all select 'event', event_name from information_schema.events where event_schema = database() limit 50", limits);
  return rows.map((r) => `${r[0]} ${r[1]}`);
}

interface Fingerprint { digest: string; tables: number; views: number; rows: number; version: string }

async function fingerprint(cli: MysqlCli, c: MysqlConnection, limits: EngineLimits): Promise<Fingerprint> {
  const version = (await query(cli, c, "select version()", limits))[0]?.[0] ?? "";
  const tableNames = (await query(cli, c, "select table_name from information_schema.tables where table_schema = database() and table_type = 'BASE TABLE' order by table_name", limits)).map((r) => r[0]!);
  const viewRows = await query(cli, c, "select table_name, view_definition from information_schema.views where table_schema = database() order by table_name", limits);
  const triggers = await query(cli, c, "select trigger_name, event_object_table, action_timing, event_manipulation, action_statement from information_schema.triggers where trigger_schema = database() order by trigger_name", limits);
  const tables: unknown[] = [];
  let totalRows = 0;
  let total = 0;
  for (const name of tableNames) {
    const columns = await query(cli, c, `select column_name, ordinal_position, column_type, is_nullable, column_default, extra, character_set_name, collation_name from information_schema.columns where table_schema = database() and table_name = '${name.replace(/'/g, "''")}' order by ordinal_position`, limits);
    const indexes = await query(cli, c, `select index_name, seq_in_index, column_name, non_unique, index_type from information_schema.statistics where table_schema = database() and table_name = '${name.replace(/'/g, "''")}' order by index_name, seq_in_index`, limits);
    const data = await cli.run("mysql", [...connArgs(c), "--batch", "--skip-column-names", "--binary-as-hex", "-e", `select * from ${ident(name)}`, c.database], { env: { MYSQL_PWD: c.password }, maxBytes: limits.maxBytes, timeoutMs: TIMEOUT_MS });
    if (data.code !== 0) throw failure("Reading a MySQL table", data);
    total += data.stdout.length;
    if (total > limits.maxBytes) throw new PortabilityError("limit_exceeded", "The database holds more than the export limit; it was not exported.");
    const text = data.stdout.toString("utf8");
    const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
    totalRows += lines.length;
    if (totalRows > limits.maxRows) throw new PortabilityError("limit_exceeded", "The database holds more rows than the export limit; it was not exported.");
    tables.push({ name, columns, indexes, rowCount: lines.length, rowsDigest: sha([...lines].sort().join("\n")) });
  }
  return { digest: digest({ v: 1, tables, views: viewRows, triggers }), tables: tableNames.length, views: viewRows.length, rows: totalRows, version };
}

const RESTORE_TEXT = [
  "# Restoring this export",
  "",
  "This is a Zenith MySQL export made with mysqldump. Everything in it is readable without Zenith.",
  "",
  "- `dump.sql` is a plain mysqldump file (tables, views, triggers, data). Restore it into an EMPTY database with `mysql <database> < dump.sql`.",
  "- `manifest.json` lists every file with its SHA-256; verify them before restoring.",
  "",
].join("\n");

export async function exportMysql(conn: MysqlConnection, cli: MysqlCli, emit: EmitFile, opts: { limits?: EngineLimits } = {}): Promise<EngineExport> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const refused = await unsupportedObjects(cli, conn, limits);
  if (refused.length > 0) {
    throw new PortabilityError("unsupported_objects", `This database holds objects the MySQL export does not carry, so it was not exported rather than exported incompletely: ${refused.slice(0, 10).join("; ")}.`, { objects: refused });
  }
  const before = await fingerprint(cli, conn, limits);
  const dump = await cli.run(
    "mysqldump",
    [...connArgs(conn), "--single-transaction", "--skip-comments", "--skip-add-locks", "--no-tablespaces", "--set-gtid-purged=OFF", "--hex-blob", "--triggers", conn.database],
    { env: { MYSQL_PWD: conn.password }, maxBytes: limits.maxBytes, timeoutMs: TIMEOUT_MS }
  );
  if (dump.code !== 0) throw failure("mysqldump", dump);
  const after = await fingerprint(cli, conn, limits);
  if (after.digest !== before.digest) {
    throw new PortabilityError("verification_failed", "The database changed while it was exported. Quiesce writers and export again; an inconsistent export is not recorded.");
  }
  await emit("dump.sql", dump.stdout);
  await emit("RESTORE.md", Buffer.from(RESTORE_TEXT, "utf8"));
  return { engineVersion: before.version, contentDigest: before.digest, coverage: { tables: before.tables, views: before.views, rows: before.rows }, restore: RESTORE_TEXT };
}

export async function readbackMysql(conn: MysqlConnection, cli: MysqlCli, opts: { limits?: EngineLimits } = {}): Promise<EngineReadback> {
  const fp = await fingerprint(cli, conn, opts.limits ?? DEFAULT_LIMITS);
  return { contentDigest: fp.digest, coverage: { tables: fp.tables, views: fp.views, rows: fp.rows } };
}

export async function isMysqlEmpty(conn: MysqlConnection, cli: MysqlCli, limits: EngineLimits = DEFAULT_LIMITS): Promise<boolean> {
  const rows = await query(cli, conn, "select (select count(*) from information_schema.tables where table_schema = database()) + (select count(*) from information_schema.routines where routine_schema = database())", limits);
  return Number(rows[0]?.[0] ?? "1") === 0;
}

export async function importMysql(conn: MysqlConnection, cli: MysqlCli, read: (name: string) => Promise<Buffer>, opts: { limits?: EngineLimits } = {}): Promise<{ tables: number }> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  if (!(await isMysqlEmpty(conn, cli, limits))) throw new PortabilityError("target_not_empty", "The target database already holds objects. Restores go into a new, empty database and never merge into existing data.");
  const dump = await read("dump.sql");
  const r = await cli.run("mysql", [...connArgs(conn), "--batch", conn.database], { env: { MYSQL_PWD: conn.password }, stdin: dump, maxBytes: 1_000_000, timeoutMs: TIMEOUT_MS });
  if (r.code !== 0) throw new PortabilityError("verification_failed", `The restore into the target failed (exit ${r.code}); the target may hold a partial restore and must be discarded.`);
  const tables = Number((await query(cli, conn, "select count(*) from information_schema.tables where table_schema = database() and table_type = 'BASE TABLE'", limits))[0]?.[0] ?? "0");
  return { tables };
}
