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
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createSecureContext, rootCertificates } from "node:tls";
import { digest } from "@/lib/controlplane/digest";
import { allowPrivateHostsFromEnv, classifyAddress, resolveConnectableHost, type HostLookup } from "../net";
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

export interface MysqlNetworkOptions { allowPrivate?: boolean; lookup?: HostLookup }

/**
 * The real clients. Each child has a newly vetted literal TCP destination.
 * Stock VERIFY_IDENTITY authenticates --host, not its separate SNI option:
 * DNS-host TLS is refused rather than silently replacing hostname identity
 * with encryption-only or a detached preflight. Literal IP TLS verifies IP SAN.
 * ZENITH_MYSQL_CA_FILE is a trusted operator file, never a connection-URI path.
 */
export function spawnMysqlCli(env: Record<string, string | undefined> = process.env, network: MysqlNetworkOptions = {}): MysqlCli {
  const binaries = { mysql: env.ZENITH_MYSQL_BIN || "mysql", mysqldump: env.ZENITH_MYSQLDUMP_BIN || "mysqldump" };
  const allowPrivate = network.allowPrivate ?? allowPrivateHostsFromEnv(env);
  const lookup = network.lookup;
  const caFile = env.ZENITH_MYSQL_CA_FILE;
  const childPath = env.PATH ?? process.env.PATH ?? "";
  return {
    async run(tool, args, opts) {
      const supplied = [...args];
      const password = opts.env.MYSQL_PWD;
      const input = opts.stdin === undefined ? undefined : Buffer.from(opts.stdin);
      const maxBytes = opts.maxBytes;
      const timeoutMs = opts.timeoutMs;
      // A fixed version probe is non-networking; all other calls need the closed
      // engine argument shape, including the original host and database.
      const version = supplied.length === 1 && supplied[0] === "--version";
      const parsed = version ? undefined : parseClientArgs(tool, supplied);
      let prepared = supplied;
      let ca: Buffer | undefined;
      if (parsed) {
        const addresses = await resolveConnectableHost(parsed.host, { allowPrivate, lookup });
        if (parsed.ssl === "DISABLED" && (!allowPrivate || addresses.some(({ address }) => !["private", "loopback"].includes(classifyAddress(address))))) throw new PortabilityError("invalid_input", "A MySQL connection without TLS requires the operator's private-network opt-in and only private destinations.");
        if (parsed.ssl !== "DISABLED") {
          if (!isIP(parsed.host)) throw new PortabilityError("unsupported_objects", "Stock MySQL clients cannot preserve DNS hostname TLS identity when connecting to a vetted address; this connection is refused.");
          ca = await trustedCa(caFile);
        }
        prepared = supplied.map((arg) => arg.startsWith("--host=") ? `--host=${addresses[0]!.address}` : arg.startsWith("--ssl-mode=") ? `--ssl-mode=${parsed.ssl === "DISABLED" ? "DISABLED" : "VERIFY_IDENTITY"}` : arg);
        if (!supplied.some((arg) => arg.startsWith("--ssl-mode="))) prepared.unshift("--ssl-mode=VERIFY_IDENTITY");
        prepared.unshift("--protocol=TCP");
        if (tool === "mysql") prepared.unshift("--skip-reconnect", "--binary-mode", "--local-infile=0");
      }
      const dir = await mkdtemp(join(tmpdir(), "zenith-mysql-client-"));
      const original = await lstat(dir);
      let settled = true;
      try {
        if (ca) {
          const snapshot = join(dir, "ca.pem");
          await writeFile(snapshot, ca, { mode: 0o600, flag: "wx" });
          prepared.unshift(`--ssl-ca=${snapshot}`);
        }
        prepared.unshift("--no-defaults", "--no-login-paths");
        return await new Promise<CliResult>((resolve, reject) => {
        settled = false;
        let child;
        try {
          child = spawn(binaries[tool], prepared, { shell: false, env: { PATH: childPath, HOME: dir, MYSQL_TEST_LOGIN_FILE: join(dir, "absent-login.cnf"), ...(password !== undefined ? { MYSQL_PWD: password } : {}) } as unknown as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
        } catch {
          settled = true;
          reject(new PortabilityError("unavailable", `${tool} could not be started.`));
          return;
        }
        const out: Buffer[] = [];
        let size = 0;
        let overflow = false;
        let timedOut = false;
        let spawnFailure: "missing" | "unavailable" | undefined;
        let closeDeadline: ReturnType<typeof setTimeout> | undefined;
        const terminate = () => {
          child.kill("SIGKILL");
          closeDeadline ??= setTimeout(() => reject(new PortabilityError("unavailable", "The MySQL client did not settle after termination; its private files were retained.")), 5000);
        };
        const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            overflow = true;
            terminate();
            return;
          }
          out.push(chunk);
        });
        // Drain server diagnostics, but never return raw addresses/messages.
        child.stderr.on("data", () => undefined);
        child.on("error", (err: NodeJS.ErrnoException) => {
          spawnFailure = err.code === "ENOENT" ? "missing" : "unavailable";
        });
        child.on("close", (code) => {
          settled = true;
          clearTimeout(timer);
          if (closeDeadline) clearTimeout(closeDeadline);
          if (spawnFailure) return reject(new PortabilityError("unavailable", spawnFailure === "missing" ? `${tool} is not installed on this worker.` : `${tool} could not be started.`));
          if (overflow) return reject(new PortabilityError("limit_exceeded", "The MySQL output exceeded the export limit."));
          if (timedOut) return reject(new PortabilityError("unavailable", "The MySQL client exceeded its deadline."));
          resolve({ code: code ?? 1, stdout: code === 0 ? Buffer.concat(out) : Buffer.alloc(0), stderr: "" });
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(input);
        });
      } finally {
        if (settled) {
          const current = await lstat(dir);
          if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino || current.uid !== original.uid) throw new PortabilityError("unavailable", "MySQL private-file ownership changed; cleanup was refused.");
          await rm(dir, { recursive: true });
          let absent = false;
          try { await lstat(dir); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") absent = true; else throw error; }
          if (!absent) throw new PortabilityError("unavailable", "MySQL private-file cleanup was unconfirmed.");
        }
      }
    },
  };
}

function parseClientArgs(tool: "mysqldump" | "mysql", args: readonly string[]): { host: string; ssl: "REQUIRED" | "DISABLED" } {
  let host: string | undefined;
  let ssl: "REQUIRED" | "DISABLED" = "REQUIRED";
  const seen = new Set<string>();
  const dump = new Set(["--single-transaction", "--skip-comments", "--skip-add-locks", "--no-tablespaces", "--set-gtid-purged=OFF", "--hex-blob", "--triggers"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const key = arg.split("=", 1)[0]!;
    if (["--host", "--port", "--user", "--ssl-mode"].includes(key)) {
      if (seen.has(key) || !arg.includes("=")) throw new PortabilityError("invalid_input", "The MySQL client connection arguments are invalid.");
      seen.add(key);
      const value = arg.slice(key.length + 1);
      if (key === "--host") host = value;
      if (key === "--port" && (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new PortabilityError("invalid_input", "The MySQL client port is invalid.");
      if (key === "--user" && !/^[A-Za-z0-9_.@$-]{1,64}$/.test(value)) throw new PortabilityError("invalid_input", "The MySQL client user is invalid.");
      if (key === "--ssl-mode") {
        if (value !== "REQUIRED" && value !== "DISABLED") throw new PortabilityError("invalid_input", "The MySQL TLS mode is invalid.");
        ssl = value;
      }
    } else if (arg === "--default-character-set=utf8mb4" || (tool === "mysqldump" && dump.has(arg)) || (tool === "mysql" && ["--batch", "--skip-column-names", "--binary-as-hex"].includes(arg))) {
      continue;
    } else if (tool === "mysql" && arg === "-e" && i + 1 < args.length - 1) {
      i++;
    } else if (i !== args.length - 1 || arg.startsWith("-") || !/^[A-Za-z0-9_$.-]{1,64}$/.test(arg)) {
      throw new PortabilityError("invalid_input", "The MySQL client arguments include an unsupported connection or command option.");
    }
  }
  if (!host || !seen.has("--port") || !seen.has("--user") || !args.length || args[args.length - 1]!.startsWith("-") || !/^[A-Za-z0-9_$.-]{1,64}$/.test(args[args.length - 1]!)) throw new PortabilityError("invalid_input", "The MySQL client requires an explicit host, port, user and database.");
  return { host, ssl };
}

async function trustedCa(file: string | undefined): Promise<Buffer> {
  try {
    if (!file) return Buffer.from(rootCertificates.join("\n"));
    if (!isAbsolute(file)) throw new Error("relative");
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 1_000_000) throw new Error("file");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("changed");
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new Error("changed");
      createSecureContext({ ca: bytes });
      return bytes;
    } finally { await handle.close(); }
  } catch {
    throw new PortabilityError("unavailable", "The trusted MySQL CA bundle could not be loaded; TLS was refused.");
  }
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
