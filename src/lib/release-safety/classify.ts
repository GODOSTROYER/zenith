/**
 * Schema migration classification: expand/compatible versus data versus contract/destructive.
 *
 * Two inputs can classify a migration and the stricter wins:
 *  - the class the manifest DECLARES for `release.migrate` (an argv is opaque to Zenith, so a
 *    person has to say what it does; absent means `unclassified`, treated like `contract`), and
 *  - the class OBSERVED from SQL text, when the caller supplies the SQL the command will run.
 *
 * The SQL pass is deliberately conservative and is not a parser: anything it does not recognise
 * is `unclassified`, never `expand`. It can raise the class above what was declared, never lower
 * it, so a manifest cannot talk a destructive statement down to "compatible".
 *
 * Only `none` and `expand` run without a separate human approval.
 */
import { digest } from "@/lib/controlplane/digest";
import type { MigrationClass } from "./types";

const SEVERITY: Readonly<Record<MigrationClass, number>> = { none: 0, expand: 1, data: 2, contract: 3, unclassified: 4 };

export const maxClass = (a: MigrationClass, b: MigrationClass): MigrationClass => (SEVERITY[b] > SEVERITY[a] ? b : a);

/** True when a person other than the requester must approve before the migration may run. */
export const requiresHumanApproval = (cls: MigrationClass): boolean => SEVERITY[cls] >= SEVERITY.data;

/** True when a code rollback across this migration is unsafe (older code may not understand the schema). */
export const blocksCodeRollback = (cls: MigrationClass): boolean => cls === "contract" || cls === "unclassified";

export interface SqlClassification {
  class: MigrationClass;
  statements: number;
  findings: string[];
}

/** Split SQL into statements, honouring comments, quotes and dollar quoting. Bounded input only. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < n && sql[i] !== "\n") i++;
      cur += " ";
    } else if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql.slice(i, i + 2) === "/*") { depth++; i += 2; }
        else if (sql.slice(i, i + 2) === "*/") { depth--; i += 2; }
        else i++;
      }
      cur += " ";
    } else if (c === "'" || c === '"') {
      const q = c;
      cur += q;
      i++;
      while (i < n) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) { cur += q + q; i += 2; continue; }
          break;
        }
        cur += sql[i];
        i++;
      }
      cur += q;
      i++;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        // a dollar-quoted body is opaque text of one statement (a function body); keep the tag only
        cur += tag + "x" + tag;
        i = stop;
      } else {
        cur += c;
        i++;
      }
    } else if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function classifyStatement(raw: string): { class: MigrationClass; finding: string } {
  // quoted strings are neutralised so a value cannot imitate a keyword
  const s = raw.replace(/'(?:[^']|'')*'/g, "''").replace(/\s+/g, " ").toLowerCase().trim();
  const head = s.split(" ").slice(0, 3).join(" ");
  const f = (cls: MigrationClass, why: string) => ({ class: cls, finding: `${cls}: ${why}` });

  if (/^(begin|commit|start transaction|set |reset |show |analyze|vacuum)\b/.test(s)) return f("none", "session or transaction control");
  if (/^drop (table|column|schema|view|materialized view|index|type|function|trigger|policy|sequence|extension|constraint|domain|rule)\b/.test(s)) return f("contract", `removes schema objects (${head})`);
  if (/^truncate\b/.test(s)) return f("contract", "truncates a table");
  if (/^revoke\b/.test(s)) return f("contract", "revokes privileges the previous code may use");
  if (/^alter table\b/.test(s)) {
    if (/\bdrop (column|constraint|default|not null)\b/.test(s)) return f("contract", "drops a column, constraint or default");
    if (/\brename\b/.test(s)) return f("contract", "renames a table, column or constraint");
    if (/\balter (column )?[\w"]+ (set data )?type\b/.test(s)) return f("contract", "changes a column type");
    if (/\bset not null\b/.test(s)) return f("contract", "adds NOT NULL to an existing column");
    if (/\badd (column )?(if not exists )?[\w"]+ .*\bnot null\b/.test(s) && !/\bdefault\b/.test(s)) return f("contract", "adds a NOT NULL column without a default");
    if (/\badd constraint\b/.test(s) && !/\bnot valid\b/.test(s)) return f("contract", "adds a validated constraint older writers may violate");
    if (/\b(enable|disable|force|no force) row level security\b/.test(s)) return f("contract", "changes row level security");
    if (/\badd (column )?/.test(s) || /\badd constraint\b/.test(s)) return f("expand", "adds a nullable or defaulted column, or an unvalidated constraint");
    return f("unclassified", "an ALTER TABLE form this classifier does not recognise");
  }
  if (/^alter (type|domain)\b/.test(s)) return /\badd value\b/.test(s) ? f("expand", "adds an enum value") : f("contract", "changes a type");
  if (/^alter (index|sequence|default privileges)\b/.test(s)) return f("unclassified", "an ALTER form this classifier does not recognise");
  if (/^(insert|update|delete|merge|copy)\b/.test(s)) return f("data", "writes or removes rows");
  if (/^create (temp|temporary )?table\b.*\bas\b\s*(select|with)\b/.test(s)) return f("data", "copies rows into a new table");
  if (/^select\b/.test(s)) return /\bfrom\b/.test(s) && !/\w+\(/.test(s) ? f("none", "read-only query") : f("data", "a SELECT that calls a function may write");
  if (/^(call|do|perform)\b/.test(s)) return f("data", "runs a procedure or anonymous block whose effect is opaque");
  if (/^create (unique )?index\b/.test(s)) return f("expand", /\bconcurrently\b/.test(s) ? "adds an index concurrently" : "adds an index");
  if (/^create (table|schema|extension|type|domain|sequence|view|materialized view|trigger|policy)\b/.test(s) || /^create or replace (view|function|trigger)\b/.test(s) || /^create (function|procedure)\b/.test(s)) return f("expand", "creates a new schema object");
  if (/^(comment on|grant)\b/.test(s)) return f("expand", "metadata or additive privileges");
  return f("unclassified", `unrecognised statement (${head})`);
}

/** Classify SQL text. An empty script is `none`. Findings are short and never repeat the statement text. */
export function classifySql(sql: string, opts: { maxBytes?: number } = {}): SqlClassification {
  const limit = opts.maxBytes ?? 512 * 1024;
  if (typeof sql !== "string" || sql.length > limit) return { class: "unclassified", statements: 0, findings: ["unclassified: the SQL is missing or larger than the classifier accepts"] };
  const statements = splitStatements(sql);
  let cls: MigrationClass = "none";
  const findings = new Set<string>();
  for (const stmt of statements) {
    const r = classifyStatement(stmt);
    cls = maxClass(cls, r.class);
    if (r.class !== "none") findings.add(r.finding);
    if (findings.size >= 20) break;
  }
  return { class: cls, statements: statements.length, findings: [...findings] };
}

export interface MigrationDeclaration {
  /** the class the manifest declares; absent means nobody classified it */
  declared?: MigrationClass;
  /** SQL the caller supplied for classification (never executed here) */
  sql?: string;
}

export interface MigrationAssessment {
  class: MigrationClass;
  findings: string[];
  sqlDigest?: string;
  /** the declared class was lower than what the SQL showed */
  raisedBySql: boolean;
}

/** The effective class of a declared migration. `none` is only reachable when no migration exists. */
export function assessMigration(decl: MigrationDeclaration | undefined): MigrationAssessment {
  if (!decl) return { class: "none", findings: [], raisedBySql: false };
  const declared: MigrationClass = decl.declared && decl.declared !== "none" ? decl.declared : "unclassified";
  const findings: string[] = decl.declared && decl.declared !== "none" ? [] : ["unclassified: the manifest declares no class for this migration, so it is treated as destructive"];
  if (decl.sql === undefined) return { class: declared, findings, raisedBySql: false };
  const observed = classifySql(decl.sql);
  const effective = maxClass(declared, observed.class);
  return { class: effective, findings: [...findings, ...observed.findings], sqlDigest: digest({ sql: decl.sql }), raisedBySql: effective !== declared };
}

/** The exact effect a person approves. Includes the image digest: another build is another approval. */
export function migrationBindingDigest(input: {
  workspaceId: string;
  environmentId: string;
  serviceAddress: string;
  imageDigest: string;
  commandDigest: string;
  sqlDigest?: string;
  class: MigrationClass;
}): string {
  return digest({ kind: "release.migration.v1", ...input });
}
