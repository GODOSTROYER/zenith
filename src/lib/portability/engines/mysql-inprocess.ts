/**
 * In-process MySQL transport (`mysql2`) for TLS connections to a DNS hostname.
 *
 * Why it exists: the stock `mysql` client authenticates `--host` against the
 * server certificate, so connecting it to a pinned IP loses the hostname
 * identity. This transport instead dials ONLY an address that
 * `resolveConnectableHost` just validated (loopback, link-local, metadata and,
 * without the operator's opt-in, private addresses are refused; EVERY answer
 * must pass) while the TLS layer verifies the certificate chain against the
 * trusted CA and the certificate identity against the ORIGINAL hostname
 * (`servername`/`checkServerIdentity` = hostname, `rejectUnauthorized` is
 * always true, never configurable).
 *
 * Every new connection - and every retry after a transient connect failure -
 * resolves and validates again, and the stream factory refuses to run twice, so
 * a DNS rebind between validation and connect, or between attempts, cannot
 * redirect a later connection. Resolved addresses never appear in errors.
 *
 * It implements the same closed `mysql` / `mysqldump` argument contract as the
 * CLI wrapper (parsed by the caller), so the engine code is unchanged. Rows are
 * rendered exactly as `mysql --batch --skip-column-names --binary-as-hex`
 * prints them (tab separated, NULL, batch escapes, 0x hex for binary
 * columns) so logical digests agree between the two transports.
 */
import { isIP } from "node:net";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { resolveConnectableHost, type HostLookup } from "../net";
import { PortabilityError } from "../types";
import type { CliResult } from "./mysql";

export interface InProcessRequest {
  tool: "mysql" | "mysqldump";
  host: string;
  port: number;
  user: string;
  database: string;
  /** the `-e` statement, when the mysql client is asked for a query */
  sql?: string;
  /** a restore script on the mysql client's stdin */
  script?: Buffer;
  password: string;
  maxBytes: number;
  timeoutMs: number;
  /** trusted CA bundle (operator file or the system roots) */
  ca: Buffer;
  allowPrivate: boolean;
  lookup?: HostLookup;
}

const CONNECT_ATTEMPTS = 3;
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_SCRIPT_BYTES = 1024 * 1024 * 1024;
const TRANSIENT = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "EAI_AGAIN", "PROTOCOL_CONNECTION_LOST"]);

interface Mysql2Module {
  createConnection(config: Record<string, unknown>): Promise<Mysql2Connection>;
}
interface Mysql2Connection {
  query(options: Record<string, unknown>): Promise<[unknown, unknown]>;
  query(sql: string): Promise<[unknown, unknown]>;
  end(): Promise<void>;
  destroy(): void;
  on(event: "error", listener: (error: unknown) => void): unknown;
  connection: { stream: unknown };
}
interface FieldInfo { columnType: number; characterSet: number; name: string }

const T = { BIT: 16, VARCHAR: 15, TINY_BLOB: 249, MEDIUM_BLOB: 250, LONG_BLOB: 251, BLOB: 252, VAR_STRING: 253, STRING: 254, GEOMETRY: 255 };
const BINARY_CHARSET = 63;
/** Column types the mysql client prints as hex under --binary-as-hex when their charset is binary. */
const HEX_TYPES = new Set([T.BIT, T.VARCHAR, T.TINY_BLOB, T.MEDIUM_BLOB, T.LONG_BLOB, T.BLOB, T.VAR_STRING, T.STRING, T.GEOMETRY]);
const isHexField = (f: FieldInfo) => f.characterSet === BINARY_CHARSET && HEX_TYPES.has(f.columnType);

const unreachable = () => new PortabilityError("unavailable", "The MySQL service could not be reached over verified TLS with the registered credentials.");

/** One verified connection to a freshly validated address. */
async function connect(req: InProcessRequest): Promise<Mysql2Connection> {
  const mod = (await import("mysql2/promise")) as unknown as Mysql2Module;
  let lastError: unknown;
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    // Fresh validation for every attempt: all answers must pass, and only the validated literal is dialed.
    const addresses = await resolveConnectableHost(req.host, { allowPrivate: req.allowPrivate, lookup: req.lookup });
    const target = addresses[attempt % addresses.length]!;
    let used = false;
    const stream = (): Duplex => {
      if (used) throw new PortabilityError("unavailable", "The MySQL connection attempted to dial more than once for one validation.");
      used = true;
      const socket = net.createConnection({ host: target.address, family: target.family, port: req.port });
      socket.setNoDelay(true);
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })));
      socket.once("connect", () => socket.setTimeout(0));
      return socket;
    };
    let connection: Mysql2Connection | undefined;
    try {
      connection = await mod.createConnection({
        // Identity is the ORIGINAL hostname: mysql2 takes TLS servername and the certificate identity check from `host`.
        host: req.host,
        port: req.port,
        user: req.user,
        password: req.password,
        database: req.database,
        stream,
        charset: "UTF8MB4_UNICODE_CI",
        connectTimeout: CONNECT_TIMEOUT_MS,
        ssl: { ca: req.ca, rejectUnauthorized: true, verifyIdentity: true, minVersion: "TLSv1.2" },
        flags: ["-LOCAL_FILES"],
        multipleStatements: false,
        rowsAsArray: true,
        typeCast: (field: { buffer(): Buffer | null }) => field.buffer(),
      });
      // A late socket error after we stop caring must never become an uncaught exception.
      connection.on("error", () => undefined);
      assertVerified(connection, req.host);
      return connection;
    } catch (error) {
      connection?.destroy();
      lastError = error;
      if (error instanceof PortabilityError) throw error;
      const code = (error as { code?: unknown }).code;
      // Only a failure BEFORE a TLS identity decision is retried; certificate and authentication failures are final.
      if (typeof code === "string" && TRANSIENT.has(code)) continue;
      break;
    }
  }
  void lastError;
  throw unreachable();
}

/** Defense in depth after mysql2's own check: the live stream must be authorized TLS whose certificate names the hostname. */
function assertVerified(connection: Mysql2Connection, host: string): void {
  const stream = connection.connection.stream as Partial<tls.TLSSocket> | undefined;
  if (!stream || !stream.encrypted || stream.authorized !== true || typeof stream.getPeerCertificate !== "function") throw unreachable();
  if (isIP(host)) throw unreachable();
  if (tls.checkServerIdentity(host, stream.getPeerCertificate!(true)) !== undefined) throw unreachable();
}

/** Render one cell as `mysql --batch --binary-as-hex` does. */
function cell(value: unknown, field: FieldInfo): string {
  if (value === null || value === undefined) return "NULL";
  const bytes = value as Buffer;
  if (isHexField(field)) return `0x${bytes.toString("hex").toUpperCase()}`;
  return bytes.toString("utf8").replace(/[\0\n\t\\]/g, (c) => (c === "\0" ? "\\0" : c === "\n" ? "\\n" : c === "\t" ? "\\t" : "\\\\"));
}

function renderRows(rows: unknown[][], fields: FieldInfo[], maxBytes: number): Buffer {
  const lines: string[] = [];
  let size = 0;
  for (const row of rows) {
    const line = row.map((v, i) => cell(v, fields[i]!)).join("\t");
    size += Buffer.byteLength(line) + 1;
    if (size > maxBytes) throw new PortabilityError("limit_exceeded", "The MySQL output exceeded the export limit.");
    lines.push(line);
  }
  return lines.length === 0 ? Buffer.alloc(0) : Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

const FAILED: CliResult = { code: 1, stdout: Buffer.alloc(0), stderr: "" };

/** A server-side statement failure is an exit status, never raw server text (it can carry names and addresses). */
const isServerError = (error: unknown): boolean => typeof (error as { errno?: unknown }).errno === "number" && typeof (error as { sqlState?: unknown }).sqlState === "string";

async function withDeadline<T>(req: InProcessRequest, work: (connection: Mysql2Connection) => Promise<T>): Promise<T> {
  let connection: Mysql2Connection | undefined;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; connection?.destroy(); }, req.timeoutMs);
  try {
    connection = await connect(req);
    if (timedOut) connection.destroy();
    return await work(connection);
  } catch (error) {
    if (timedOut) throw new PortabilityError("unavailable", "The MySQL client exceeded its deadline.");
    throw error;
  } finally {
    clearTimeout(timer);
    try { connection?.destroy(); } catch { /* already closed */ }
  }
}

/* --------------------------------- queries -------------------------------- */

async function runQuery(req: InProcessRequest): Promise<CliResult> {
  return withDeadline(req, async (connection) => {
    try {
      const [result, fields] = await connection.query({ sql: req.sql!, rowsAsArray: true });
      if (!Array.isArray(result) || !Array.isArray(fields)) return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
      return { code: 0, stdout: renderRows(result as unknown[][], fields as FieldInfo[], req.maxBytes), stderr: "" };
    } catch (error) {
      if (error instanceof PortabilityError) throw error;
      if (isServerError(error)) return FAILED;
      throw unreachable();
    }
  });
}

/* ---------------------------- restore (script run) -------------------------- */

/**
 * Split a mysql-client script into statements: honours quotes, comments and the
 * client-side DELIMITER directive mysqldump uses for trigger bodies. A statement
 * made only of ordinary comments is dropped; `/*! ... *\/` version comments are
 * statements and go to the server unchanged.
 */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let delimiter = ";";
  let buf = "";
  let meaningful = false;
  let i = 0;
  const n = text.length;
  const flush = () => {
    const s = buf.trim();
    if (s.length > 0 && meaningful) out.push(s);
    buf = "";
    meaningful = false;
  };
  while (i < n) {
    const c = text[i]!;
    if (buf.trim().length === 0 && !meaningful && /^delimiter[ \t]/i.test(text.slice(i, i + 10))) {
      const end = text.indexOf("\n", i);
      const line = text.slice(i + 10, end === -1 ? n : end).trim();
      if (line.length === 0 || /\s/.test(line)) throw new PortabilityError("verification_failed", "The restore script has an invalid DELIMITER directive.");
      delimiter = line;
      buf = "";
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      flush();
      i += delimiter.length;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (; j < n; j++) {
        if (c !== "`" && text[j] === "\\") { j++; continue; }
        if (text[j] === c) {
          if (text[j + 1] === c) { j++; continue; }
          break;
        }
      }
      if (j >= n) throw new PortabilityError("verification_failed", "The restore script ends inside a quoted string.");
      buf += text.slice(i, j + 1);
      meaningful = true;
      i = j + 1;
      continue;
    }
    if (c === "#" || (c === "-" && text[i + 1] === "-" && (i + 2 >= n || /[\s\x00-\x1f]/.test(text[i + 2]!)))) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new PortabilityError("verification_failed", "The restore script ends inside a comment.");
      const comment = text.slice(i, end + 2);
      if (comment[2] === "!" || comment[2] === "M") { buf += comment; meaningful = true; }
      i = end + 2;
      continue;
    }
    buf += c;
    if (!/\s/.test(c)) meaningful = true;
    i++;
  }
  flush();
  return out;
}

async function runScript(req: InProcessRequest): Promise<CliResult> {
  const script = req.script!;
  if (script.length > MAX_SCRIPT_BYTES) throw new PortabilityError("limit_exceeded", "The restore script exceeds the import limit.");
  const statements = splitStatements(script.toString("utf8"));
  return withDeadline(req, async (connection) => {
    for (const statement of statements) {
      try {
        await connection.query(statement);
      } catch (error) {
        if (error instanceof PortabilityError) throw error;
        if (isServerError(error)) return FAILED;
        throw unreachable();
      }
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
  });
}

/* ----------------------------------- dump ---------------------------------- */

const qid = (name: string): string => `\`${name.replace(/`/g, "``")}\``;
const DEFINER = / DEFINER\s*=\s*`(?:[^`]|``)*`@`(?:[^`]|``)*`/i;

function sqlString(value: string): string {
  return `'${value.replace(/[\\'"\0\n\r\x1a]/g, (c) => (c === "\0" ? "\\0" : c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\x1a" ? "\\Z" : `\\${c}`))}'`;
}

function literal(value: unknown, field: FieldInfo): string {
  if (value === null || value === undefined) return "NULL";
  const bytes = value as Buffer;
  if (field.columnType === T.BIT) return BigInt(`0x${bytes.length ? bytes.toString("hex") : "0"}`).toString();
  if (isHexField(field)) return bytes.length === 0 ? "''" : `0x${bytes.toString("hex")}`;
  const text = bytes.toString("utf8");
  // Numbers (INT, DECIMAL, FLOAT, ...) are bare; everything else is a quoted string literal.
  return NUMERIC.has(field.columnType) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) ? text : sqlString(text);
}
const NUMERIC = new Set([0, 1, 2, 3, 4, 5, 8, 9, 13, 246]); // DECIMAL, TINY, SHORT, LONG, FLOAT, DOUBLE, LONGLONG, INT24, YEAR, NEWDECIMAL

const HEADER = [
  "-- Zenith MySQL dump (in-process transport). Restore into an EMPTY database with the mysql client.",
  "SET NAMES utf8mb4;",
  "SET @OLD_TIME_ZONE=@@TIME_ZONE, TIME_ZONE='+00:00';",
  "SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0;",
  "SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;",
  "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';",
  "",
].join("\n");
const FOOTER = ["SET SQL_MODE=@OLD_SQL_MODE;", "SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;", "SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS;", "SET TIME_ZONE=@OLD_TIME_ZONE;", ""].join("\n");
const ROWS_PER_STATEMENT_BYTES = 512 * 1024;

async function runDump(req: InProcessRequest): Promise<CliResult> {
  return withDeadline(req, async (connection) => {
    const chunks: string[] = [];
    let size = 0;
    const push = (text: string) => {
      size += Buffer.byteLength(text);
      if (size > req.maxBytes) throw new PortabilityError("limit_exceeded", "The MySQL output exceeded the export limit.");
      chunks.push(text);
    };
    const rows = async (sql: string): Promise<[unknown[][], FieldInfo[]]> => {
      const [result, fields] = await connection.query({ sql, rowsAsArray: true });
      return [(Array.isArray(result) ? result : []) as unknown[][], (Array.isArray(fields) ? fields : []) as FieldInfo[]];
    };
    const text = (v: unknown): string => (v === null || v === undefined ? "" : (v as Buffer).toString("utf8"));
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      push(HEADER);
      const [objects] = await rows("select table_name, table_type from information_schema.tables where table_schema = database() order by table_name");
      const tables = objects.filter((r) => text(r[1]) === "BASE TABLE").map((r) => text(r[0]));
      const views = objects.filter((r) => text(r[1]) === "VIEW").map((r) => text(r[0]));
      for (const name of tables) {
        const [create] = await rows(`show create table ${qid(name)}`);
        push(`\n${text(create[0]?.[1])};\n`);
        const [cols] = await rows(`select column_name from information_schema.columns where table_schema = database() and table_name = ${sqlString(name)} and (extra not like '%GENERATED%' or extra like '%DEFAULT_GENERATED%') order by ordinal_position`);
        const names = cols.map((r) => text(r[0]));
        if (names.length === 0) continue;
        const [data, fields] = await rows(`select ${names.map(qid).join(", ")} from ${qid(name)}`);
        const head = `INSERT INTO ${qid(name)} (${names.map(qid).join(", ")}) VALUES\n`;
        let batch: string[] = [];
        let batchBytes = 0;
        const flush = () => { if (batch.length) { push(`${head}${batch.join(",\n")};\n`); batch = []; batchBytes = 0; } };
        for (const row of data) {
          const tuple = `(${row.map((v, i) => literal(v, fields[i]!)).join(",")})`;
          batch.push(tuple);
          batchBytes += tuple.length;
          if (batchBytes >= ROWS_PER_STATEMENT_BYTES) flush();
        }
        flush();
      }
      // A view may select from another view: emit dependencies first.
      const defs = new Map<string, string>();
      for (const name of views) {
        const [create] = await rows(`show create view ${qid(name)}`);
        defs.set(name, text(create[0]?.[1]).replace(DEFINER, ""));
      }
      const emitted = new Set<string>();
      const emit = (name: string, stack: string[] = []) => {
        if (emitted.has(name) || stack.includes(name)) return;
        for (const other of views) if (other !== name && defs.get(name)!.includes(qid(other))) emit(other, [...stack, name]);
        emitted.add(name);
        push(`\n${defs.get(name)};\n`);
      };
      for (const name of views) emit(name);
      const [triggers] = await rows("select trigger_name from information_schema.triggers where trigger_schema = database() order by trigger_name");
      if (triggers.length > 0) push("\nDELIMITER ;;\n");
      for (const t of triggers) {
        const [create] = await rows(`show create trigger ${qid(text(t[0]))}`);
        const row = create[0];
        if (!row) continue;
        push(`SET @saved_sql_mode = @@sql_mode;;\nSET sql_mode = ${sqlString(text(row[1]))};;\n${text(row[2]).replace(DEFINER, "")};;\nSET sql_mode = @saved_sql_mode;;\n`);
      }
      if (triggers.length > 0) push("DELIMITER ;\n");
      push(`\n${FOOTER}`);
      await connection.query("ROLLBACK");
      return { code: 0, stdout: Buffer.from(chunks.join(""), "utf8"), stderr: "" };
    } catch (error) {
      if (error instanceof PortabilityError) throw error;
      if (isServerError(error)) return FAILED;
      throw unreachable();
    }
  });
}

/** Run one closed-shape mysql / mysqldump request in-process over verified, pinned TLS. */
export async function runMysqlInProcess(req: InProcessRequest): Promise<CliResult> {
  if (isIP(req.host.replace(/^\[|\]$/g, ""))) throw new PortabilityError("invalid_input", "The in-process MySQL transport carries DNS hostnames; literal addresses use the client path.");
  if (req.tool === "mysqldump") return runDump(req);
  if (req.script !== undefined) return runScript(req);
  if (req.sql !== undefined) return runQuery(req);
  throw new PortabilityError("invalid_input", "The MySQL client arguments include an unsupported connection or command option.");
}
