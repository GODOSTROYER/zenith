/**
 * Postgres logical export, import and readback (`postgres-logical-v1`), over one
 * SQL session. It runs against any Postgres (managed RDS, Cloud SQL, Azure,
 * OCI, Neon, in-cluster) because it speaks only SQL and the system catalogs.
 *
 * What is carried: user schemas, enums, sequences (definition and current
 * value, including identity), tables with column types, defaults, identity and
 * generated columns, primary key / unique / check / exclusion constraints,
 * foreign keys, secondary indexes, and every row.
 *
 * What is REFUSED (never silently dropped): views, materialized views, foreign
 * tables, partitioned or inherited tables, row level security, functions and
 * procedures, triggers, extensions other than plpgsql, and user types other than
 * enums. An export that cannot be faithful does not exist.
 *
 * Values travel as TEXT (`col::text`) and come back through the column's own
 * type input (`::<format_type>`), so no JavaScript number or Date ever touches a
 * value and numeric, timestamptz, bytea, arrays, json and enums round trip
 * exactly. Both ends pin the session (UTC, ISO dates, hex bytea, full float
 * digits) so the same value has the same text on both sides.
 *
 * The logical digest (`contentDigest`) covers structure and every row (rows are
 * hashed order-independently), and `readbackPostgres` recomputes it from a live
 * session: that is the independent verification of a restore.
 */
import { createHash } from "node:crypto";
import { digest } from "@/lib/controlplane/digest";
import { DEFAULT_LIMITS, PortabilityError, type EmitFile, type EngineExport, type EngineLimits, type EngineReadback, type SqlRunner } from "../types";

const q = (id: string): string => `"${id.replace(/"/g, '""')}"`;
const qn = (schema: string, name: string): string => `${q(schema)}.${q(name)}`;
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number => Number(v);
const bool = (v: unknown): boolean => v === true || v === "t" || v === "true";

const UNIT_SEP = "\u001f";
const USER_SCHEMA = "n.nspname <> 'information_schema' and left(n.nspname, 3) <> 'pg_'";
const NOT_EXTENSION = (oid: string, cls: string): string => `not exists (select 1 from pg_depend d where d.objid = ${oid} and d.classid = '${cls}'::regclass and d.deptype = 'e')`;
const PAGE = 500;

/* --------------------------------- model ---------------------------------- */

interface ColumnModel {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  identity: "" | "a" | "d";
  generated: "" | "s";
  collation: string | null;
}
interface ConstraintModel { name: string; kind: string; def: string }
interface IndexModel { name: string; def: string }
interface TableModel {
  schema: string;
  name: string;
  columns: ColumnModel[];
  constraints: ConstraintModel[];
  indexes: IndexModel[];
  rowCount: number;
  rowsDigest: string;
}
interface SequenceModel {
  schema: string;
  name: string;
  type: string;
  start: string;
  min: string;
  max: string;
  inc: string;
  cache: string;
  cycle: boolean;
  last: string | null;
  owner: { schema: string; table: string; column: string; identity: boolean } | null;
}
interface EnumModel { schema: string; name: string; labels: string[] }

interface Collected {
  version: string;
  schemas: string[];
  enums: EnumModel[];
  sequences: SequenceModel[];
  tables: TableModel[];
  /** table index -> row lines (only when requested) */
  rows: string[][];
}

/* -------------------------------- session --------------------------------- */

async function pinSession(sql: SqlRunner): Promise<void> {
  for (const stmt of [
    "set timezone = 'UTC'",
    "set datestyle = 'ISO, MDY'",
    "set intervalstyle = 'postgres'",
    "set extra_float_digits = 3",
    "set bytea_output = 'hex'",
    "set search_path = public",
  ]) {
    await sql.query(stmt);
  }
}

async function rollbackQuietly(sql: SqlRunner): Promise<void> {
  try {
    await sql.query("rollback");
  } catch {
    /* the session may already be closed; the original error is what matters */
  }
}

/* ------------------------------- catalog read ------------------------------ */

async function unsupportedObjects(sql: SqlRunner): Promise<string[]> {
  const rows = await sql.query(
    `select class, name from (
       select case when c.relispartition then 'partition' when c.relkind = 'v' then 'view' when c.relkind = 'm' then 'materialized view'
                   when c.relkind = 'f' then 'foreign table' when c.relkind = 'p' then 'partitioned table' when c.relkind = 'c' then 'composite type' end as class,
              n.nspname || '.' || c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where ${USER_SCHEMA} and (c.relkind in ('v','m','f','p','c') or c.relispartition)
       union all
       select 'inherited table', n.nspname || '.' || c.relname
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where ${USER_SCHEMA} and c.relkind = 'r' and exists (select 1 from pg_inherits i where i.inhrelid = c.oid) and not c.relispartition
       union all
       select 'row level security', n.nspname || '.' || c.relname
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where ${USER_SCHEMA} and c.relkind = 'r' and c.relrowsecurity
       union all
       select 'function', n.nspname || '.' || p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where ${USER_SCHEMA} and ${NOT_EXTENSION("p.oid", "pg_proc")}
       union all
       select 'trigger', c.relname || '.' || t.tgname
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where not t.tgisinternal and ${USER_SCHEMA}
       union all
       select 'type', n.nspname || '.' || t.typname
         from pg_type t join pg_namespace n on n.oid = t.typnamespace left join pg_class c on c.oid = t.typrelid
        where ${USER_SCHEMA} and (t.typtype in ('d','r','m') or (t.typtype = 'c' and c.relkind = 'c'))
       union all
       select 'extension', e.extname from pg_extension e where e.extname <> 'plpgsql'
     ) x
     order by class, name limit 50`
  );
  return rows.map((r) => `${str(r.class)} ${str(r.name)}`);
}

async function collect(sql: SqlRunner, opts: { limits: EngineLimits; keepRows: boolean }): Promise<Collected> {
  const refused = await unsupportedObjects(sql);
  if (refused.length > 0) {
    throw new PortabilityError(
      "unsupported_objects",
      `This database holds objects the Postgres logical export does not carry, so it was not exported rather than exported incompletely: ${refused.slice(0, 10).join("; ")}${refused.length > 10 ? "; and more" : ""}.`,
      { objects: refused.slice(0, 50) }
    );
  }
  const version = str((await sql.query("show server_version"))[0]?.server_version);

  const schemaRows = await sql.query(`select n.nspname as name from pg_namespace n where ${USER_SCHEMA} order by 1`);
  const schemas = schemaRows.map((r) => str(r.name));

  const enumRows = await sql.query(
    `select n.nspname as schema, t.typname as name, string_agg(e.enumlabel, chr(31) order by e.enumsortorder) as labels
       from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
      where ${USER_SCHEMA} group by 1, 2 order by 1, 2`
  );
  const enums: EnumModel[] = enumRows.map((r) => ({ schema: str(r.schema), name: str(r.name), labels: str(r.labels).split(UNIT_SEP) }));

  const seqRows = await sql.query(
    `select n.nspname as schema, c.relname as name, format_type(s.seqtypid, null) as type, s.seqstart::text as start, s.seqmin::text as min,
            s.seqmax::text as max, s.seqincrement::text as inc, s.seqcache::text as cache, s.seqcycle as cycle,
            (select ps.last_value::text from pg_sequences ps where ps.schemaname = n.nspname and ps.sequencename = c.relname) as last,
            d.deptype as deptype, dn.nspname as owner_schema, dc.relname as owner_table, da.attname as owner_col
       from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_sequence s on s.seqrelid = c.oid
       left join pg_depend d on d.objid = c.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a','i')
       left join pg_class dc on dc.oid = d.refobjid left join pg_namespace dn on dn.oid = dc.relnamespace
       left join pg_attribute da on da.attrelid = d.refobjid and da.attnum = d.refobjsubid
      where c.relkind = 'S' and ${USER_SCHEMA} order by 1, 2`
  );
  const sequences: SequenceModel[] = seqRows.map((r) => ({
    schema: str(r.schema),
    name: str(r.name),
    type: str(r.type),
    start: str(r.start),
    min: str(r.min),
    max: str(r.max),
    inc: str(r.inc),
    cache: str(r.cache),
    cycle: bool(r.cycle),
    last: r.last === null || r.last === undefined ? null : str(r.last),
    owner: r.owner_table ? { schema: str(r.owner_schema), table: str(r.owner_table), column: str(r.owner_col), identity: str(r.deptype) === "i" } : null,
  }));

  const tableRows = await sql.query(
    `select n.nspname as schema, c.relname as name, c.oid::bigint as oid
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and ${USER_SCHEMA} order by 1, 2`
  );
  const tables: TableModel[] = [];
  const rows: string[][] = [];
  let totalBytes = 0;
  let totalRows = 0;
  for (const t of tableRows) {
    const schema = str(t.schema);
    const name = str(t.name);
    const oid = num(t.oid);
    const columns = (
      await sql.query(
        `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull, pg_get_expr(d.adbin, d.adrelid) as default_expr,
                a.attidentity as identity, a.attgenerated as generated,
                case when a.attcollation <> ty.typcollation then (select quote_ident(cn.nspname) || '.' || quote_ident(co.collname) from pg_collation co join pg_namespace cn on cn.oid = co.collnamespace where co.oid = a.attcollation) end as collation
           from pg_attribute a join pg_type ty on ty.oid = a.atttypid left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
          where a.attrelid = ${oid} and a.attnum > 0 and not a.attisdropped order by a.attnum`
      )
    ).map(
      (r): ColumnModel => ({
        name: str(r.name),
        type: str(r.type),
        notNull: bool(r.notnull),
        default: r.default_expr === null || r.default_expr === undefined ? null : str(r.default_expr),
        identity: str(r.identity) as ColumnModel["identity"],
        generated: str(r.generated) as ColumnModel["generated"],
        collation: r.collation === null || r.collation === undefined ? null : str(r.collation),
      })
    );
    const constraints = (
      await sql.query(`select conname as name, contype as kind, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = ${oid} and contype in ('p','u','c','f','x') order by conname`)
    ).map((r): ConstraintModel => ({ name: str(r.name), kind: str(r.kind), def: str(r.def) }));
    const indexes = (
      await sql.query(
        `select ci.relname as name, pg_get_indexdef(i.indexrelid) as def from pg_index i join pg_class ci on ci.oid = i.indexrelid
          where i.indrelid = ${oid} and not i.indisprimary and not exists (select 1 from pg_constraint c where c.conrelid = i.indrelid and c.conindid = i.indexrelid) order by ci.relname`
      )
    ).map((r): IndexModel => ({ name: str(r.name), def: str(r.def) }));

    const dataCols = columns.filter((c) => c.generated === "");
    const lines: string[] = [];
    if (dataCols.length > 0) {
      const select = dataCols.map((c) => `${q(c.name)}::text`).join(", ");
      for (let offset = 0; ; offset += PAGE) {
        const page = await sql.query(`select to_jsonb(array[${select}])::text as j from ${qn(schema, name)} order by ctid limit ${PAGE} offset ${offset}`);
        for (const r of page) {
          const line = str(r.j);
          totalBytes += Buffer.byteLength(line) + 1;
          totalRows += 1;
          if (totalBytes > opts.limits.maxBytes || totalRows > opts.limits.maxRows) {
            throw new PortabilityError("limit_exceeded", `The database holds more than the export limit (${opts.limits.maxRows} rows or ${Math.floor(opts.limits.maxBytes / 1048576)} MiB); it was not exported.`);
          }
          lines.push(line);
        }
        if (page.length < PAGE) break;
      }
    } else {
      const n = num((await sql.query(`select count(*)::int as n from ${qn(schema, name)}`))[0]?.n);
      totalRows += n;
      if (totalRows > opts.limits.maxRows) throw new PortabilityError("limit_exceeded", "The database holds more rows than the export limit; it was not exported.");
      for (let i = 0; i < n; i += 1) lines.push("[]");
    }
    const sorted = [...lines].sort();
    tables.push({ schema, name, columns, constraints, indexes, rowCount: lines.length, rowsDigest: sha(sorted.join("\n")) });
    rows.push(opts.keepRows ? lines : []);
  }
  return { version, schemas, enums, sequences, tables, rows };
}

/** Structure and data, order independent. Identity sequences are keyed by their column, not their generated name. */
function contentDigestOf(c: Collected): string {
  return digest({
    v: 1,
    enums: c.enums,
    sequences: c.sequences.map((s) => (s.owner?.identity ? { ...s, name: `identity:${s.owner.schema}.${s.owner.table}.${s.owner.column}` } : s)),
    tables: c.tables.map((t) => ({ schema: t.schema, name: t.name, columns: t.columns, constraints: t.constraints, indexes: t.indexes, rowCount: t.rowCount, rowsDigest: t.rowsDigest })),
  });
}

function coverageOf(c: Collected): Record<string, number | string[]> {
  return {
    schemas: c.schemas,
    tables: c.tables.length,
    rows: c.tables.reduce((n, t) => n + t.rowCount, 0),
    enums: c.enums.length,
    sequences: c.sequences.length,
    constraints: c.tables.reduce((n, t) => n + t.constraints.length, 0),
    indexes: c.tables.reduce((n, t) => n + t.indexes.length, 0),
  };
}

/* ----------------------------------- DDL ---------------------------------- */

function columnDdl(c: ColumnModel, seq?: SequenceModel): string {
  const parts = [q(c.name), c.type];
  if (c.collation) parts.push(`collate ${c.collation}`);
  if (c.identity) {
    const opts = seq ? ` (start with ${seq.start} increment by ${seq.inc} minvalue ${seq.min} maxvalue ${seq.max} cache ${seq.cache} ${seq.cycle ? "" : "no "}cycle)` : "";
    parts.push(`generated ${c.identity === "a" ? "always" : "by default"} as identity${opts}`);
  } else if (c.generated === "s" && c.default !== null) {
    parts.push(`generated always as (${c.default}) stored`);
  } else if (c.default !== null) {
    parts.push(`default ${c.default}`);
  }
  if (c.notNull) parts.push("not null");
  return parts.join(" ");
}

interface PlanTable { schema: string; name: string; file: string; columns: string[]; types: string[]; overriding: boolean; rows: number }
interface Plan { pre: string[]; post: string[]; tables: PlanTable[] }

function planOf(c: Collected): Plan {
  const pre: string[] = [];
  const post: string[] = [];
  for (const s of c.schemas) if (s !== "public") pre.push(`create schema if not exists ${q(s)}`);
  for (const e of c.enums) pre.push(`create type ${qn(e.schema, e.name)} as enum (${e.labels.map(lit).join(", ")})`);
  for (const s of c.sequences) {
    if (s.owner?.identity) continue;
    pre.push(`create sequence ${qn(s.schema, s.name)} as ${s.type} increment by ${s.inc} minvalue ${s.min} maxvalue ${s.max} start with ${s.start} cache ${s.cache} ${s.cycle ? "" : "no "}cycle`);
  }
  const identitySeq = new Map(c.sequences.filter((s) => s.owner?.identity).map((s) => [`${s.owner!.schema}.${s.owner!.table}.${s.owner!.column}`, s]));
  const tables: PlanTable[] = [];
  c.tables.forEach((t, i) => {
    const inline = t.constraints.filter((k) => k.kind !== "f");
    const defs = [
      ...t.columns.map((col) => columnDdl(col, identitySeq.get(`${t.schema}.${t.name}.${col.name}`))),
      ...inline.map((k) => `constraint ${q(k.name)} ${k.def}`),
    ];
    pre.push(`create table ${qn(t.schema, t.name)} (${defs.join(", ")})`);
    const dataCols = t.columns.filter((col) => col.generated === "");
    tables.push({
      schema: t.schema,
      name: t.name,
      file: `tables/${String(i).padStart(4, "0")}.ndjson`,
      columns: dataCols.map((col) => col.name),
      types: dataCols.map((col) => col.type),
      overriding: dataCols.some((col) => col.identity === "a"),
      rows: t.rowCount,
    });
  });
  for (const s of c.sequences) {
    if (s.owner && !s.owner.identity) post.push(`alter sequence ${qn(s.schema, s.name)} owned by ${qn(s.owner.schema, s.owner.table)}.${q(s.owner.column)}`);
  }
  for (const t of c.tables) for (const k of t.constraints.filter((x) => x.kind === "f")) post.push(`alter table ${qn(t.schema, t.name)} add constraint ${q(k.name)} ${k.def}`);
  for (const t of c.tables) for (const ix of t.indexes) post.push(ix.def);
  for (const s of c.sequences) {
    if (s.last === null) continue;
    if (s.owner?.identity) post.push(`select setval(pg_get_serial_sequence(${lit(qn(s.owner.schema, s.owner.table))}, ${lit(s.owner.column)}), ${s.last}, true)`);
    else post.push(`select setval(${lit(qn(s.schema, s.name))}::regclass, ${s.last}, true)`);
  }
  return { pre, post, tables };
}

const RESTORE_TEXT = [
  "# Restoring this export",
  "",
  "This is a Zenith Postgres logical export. Everything in it is readable without Zenith.",
  "",
  "- `schema.json` holds the DDL (`pre` before the data, `post` after it) and, per table, the column names and types.",
  "- `schema.sql` is the same DDL as plain SQL, for reading.",
  "- `tables/NNNN.ndjson` has one row per line as a JSON array of text values (null stays null), in the column order listed in `schema.json`.",
  "- Run the `pre` statements against an EMPTY Postgres database, then load each table with:",
  "  `insert into <table> (<columns>) select (e->>0)::<type0>, (e->>1)::<type1>, ... from jsonb_array_elements($1::jsonb) as e`",
  "  passing a JSON array of the file's lines. Then run the `post` statements (foreign keys, indexes, sequence values).",
  "- `manifest.json` lists every file with its SHA-256; verify them before restoring.",
  "",
].join("\n");

/* ---------------------------------- export --------------------------------- */

export async function exportPostgres(sql: SqlRunner, emit: EmitFile, opts: { limits?: EngineLimits } = {}): Promise<EngineExport> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  await pinSession(sql);
  await sql.query("begin isolation level repeatable read read only");
  let collected: Collected;
  try {
    collected = await collect(sql, { limits, keepRows: true });
    await sql.query("commit");
  } catch (err) {
    await rollbackQuietly(sql);
    throw err;
  }
  const plan = planOf(collected);
  const schemaJson = { v: 1, engine: "postgres-logical-v1", version: collected.version, pre: plan.pre, post: plan.post, tables: plan.tables };
  await emit("schema.json", Buffer.from(JSON.stringify(schemaJson, null, 2), "utf8"));
  await emit("schema.sql", Buffer.from(`${[...plan.pre, ...plan.post].map((s) => `${s};`).join("\n")}\n`, "utf8"));
  for (let i = 0; i < collected.tables.length; i += 1) {
    const lines = collected.rows[i]!;
    await emit(plan.tables[i]!.file, Buffer.from(lines.length ? `${lines.join("\n")}\n` : "", "utf8"));
  }
  await emit("RESTORE.md", Buffer.from(RESTORE_TEXT, "utf8"));
  return { engineVersion: collected.version, contentDigest: contentDigestOf(collected), coverage: coverageOf(collected), restore: RESTORE_TEXT };
}

/* --------------------------------- readback -------------------------------- */

/** Recompute the logical digest from a live session. This is what independently verifies a restore. */
export async function readbackPostgres(sql: SqlRunner, opts: { limits?: EngineLimits } = {}): Promise<EngineReadback> {
  await pinSession(sql);
  await sql.query("begin isolation level repeatable read read only");
  try {
    const collected = await collect(sql, { limits: opts.limits ?? DEFAULT_LIMITS, keepRows: false });
    await sql.query("commit");
    return { contentDigest: contentDigestOf(collected), coverage: coverageOf(collected) };
  } catch (err) {
    await rollbackQuietly(sql);
    throw err;
  }
}

/* ---------------------------------- import --------------------------------- */

export async function isPostgresEmpty(sql: SqlRunner): Promise<boolean> {
  const rows = await sql.query(
    `select count(*)::int as n from (
       select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p','v','m','S','f','c') and ${USER_SCHEMA}
       union all
       select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typtype in ('e','d','r','m') and ${USER_SCHEMA}
       union all
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${USER_SCHEMA} and ${NOT_EXTENSION("p.oid", "pg_proc")}
       union all
       select 1 from pg_namespace n where ${USER_SCHEMA} and n.nspname <> 'public'
     ) x`
  );
  return num(rows[0]?.n) === 0;
}

const DDL_ALLOWED: readonly RegExp[] = [
  /^create schema if not exists "/i,
  /^create type "[^"]+"\."[^"]+" as enum \(/i,
  /^create sequence "[^"]+"\."[^"]+" as /i,
  /^create table "[^"]+"\."[^"]+" \(/i,
  /^alter sequence "[^"]+"\."[^"]+" owned by "/i,
  /^alter table "[^"]+"\."[^"]+" add constraint "/i,
  /^create (unique )?index /i,
  /^select setval\(/i,
];

/** True when the statement has a `;` outside quotes: it would be a second statement. */
function hasTopLevelSemicolon(stmt: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < stmt.length; i += 1) {
    const ch = stmt[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ";") return true;
  }
  return false;
}

export function assertAllowedDdl(stmt: unknown): string {
  if (typeof stmt !== "string" || stmt.length === 0 || stmt.length > 200_000 || !DDL_ALLOWED.some((re) => re.test(stmt)) || hasTopLevelSemicolon(stmt) || stmt.includes("--") || stmt.includes("/*")) {
    throw new PortabilityError("artifact_invalid", "The export contains a statement the importer does not run.");
  }
  return stmt;
}

const SAFE_TYPE = /^[A-Za-z0-9_ ."(),[\]]{1,200}$/;

export interface PostgresImportResult { tables: number; rows: number }

export async function importPostgres(sql: SqlRunner, read: (name: string) => Promise<Buffer>): Promise<PostgresImportResult> {
  let schema: { v?: unknown; pre?: unknown; post?: unknown; tables?: unknown };
  try {
    schema = JSON.parse((await read("schema.json")).toString("utf8")) as typeof schema;
  } catch {
    throw new PortabilityError("artifact_invalid", "The export's schema.json is not readable.");
  }
  if (schema.v !== 1 || !Array.isArray(schema.pre) || !Array.isArray(schema.post) || !Array.isArray(schema.tables)) {
    throw new PortabilityError("artifact_invalid", "The export's schema.json has an unknown shape.");
  }
  const pre = schema.pre.map(assertAllowedDdl);
  const post = schema.post.map(assertAllowedDdl);
  const tables = (schema.tables as Record<string, unknown>[]).map((t) => {
    const columns = t.columns;
    const types = t.types;
    if (
      typeof t.schema !== "string" || typeof t.name !== "string" || typeof t.file !== "string" || !/^tables\/\d{4}\.ndjson$/.test(t.file) ||
      !Array.isArray(columns) || !Array.isArray(types) || columns.length !== types.length ||
      columns.some((c) => typeof c !== "string") || types.some((x) => typeof x !== "string" || !SAFE_TYPE.test(x))
    ) {
      throw new PortabilityError("artifact_invalid", "The export's table list is malformed.");
    }
    const rows = typeof t.rows === "number" && Number.isInteger(t.rows) && t.rows >= 0 && t.rows <= 5_000_000 ? t.rows : 0;
    return { schema: t.schema, name: t.name, file: t.file, columns: columns as string[], types: types as string[], overriding: t.overriding === true, rows };
  });

  if (!(await isPostgresEmpty(sql))) {
    throw new PortabilityError("target_not_empty", "The target database already holds objects. Restores go into a new, empty database and never merge into existing data.");
  }
  await pinSession(sql);
  await sql.query("begin");
  let rows = 0;
  try {
    for (const stmt of pre) await sql.query(stmt);
    for (const t of tables) {
      if (t.columns.length === 0) {
        // A table with no loadable column (generated only) still has rows.
        for (let i = 0; i < t.rows; i += 1) await sql.query(`insert into ${qn(t.schema, t.name)} default values`);
        rows += t.rows;
        continue;
      }
      const file = (await read(t.file)).toString("utf8");
      const lines = file.length === 0 ? [] : file.replace(/\n$/, "").split("\n");
      const select = t.columns.map((_, i) => `(e->>${i})::${t.types[i]}`).join(", ");
      const insert = `insert into ${qn(t.schema, t.name)} (${t.columns.map(q).join(", ")}) ${t.overriding ? "overriding system value " : ""}select ${select} from jsonb_array_elements($1::text::jsonb) as e`;
      for (let i = 0; i < lines.length; i += PAGE) {
        await sql.query(insert, [`[${lines.slice(i, i + PAGE).join(",")}]`]);
        rows += Math.min(PAGE, lines.length - i);
      }
    }
    for (const stmt of post) await sql.query(stmt);
    await sql.query("commit");
  } catch (err) {
    await rollbackQuietly(sql);
    if (err instanceof PortabilityError) throw err;
    throw new PortabilityError("verification_failed", "The restore into the target failed and was rolled back; nothing was left in the target.");
  }
  return { tables: tables.length, rows };
}
