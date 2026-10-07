/**
 * API N-1 / N schema compatibility contract (PROD-OPS-03).
 *
 * Rule: inside one release train, a platform migration is EXPAND-ONLY. The
 * previous release (N-1) keeps running against the migrated schema while the new
 * release (N) rolls out, and a rollback to N-1 after migration must still work. So
 * a migration may add tables, nullable or defaulted columns, indexes, unvalidated
 * constraints, enum values, functions and additive grants, and nothing else.
 *
 * Anything classified `contract` or `unclassified` by the LIFE-10 classifier
 * (src/lib/release-safety/classify.ts: drops, renames, type changes, NOT NULL on
 * existing columns, validated constraints, revokes, RLS changes on existing
 * tables) is a CONTRACT migration. It is refused by `migratePlatformDb` unless
 *   (a) it is registered in `CONTRACT_MIGRATION_APPROVALS` with the sha256 of its
 *       exact SQL and a LIFE-10 approval reference (the registry is code, so the
 *       approval is reviewed like code and any SQL edit voids it), and
 *   (b) the operator names its version in ZENITH_ALLOW_CONTRACT_MIGRATIONS at apply
 *       time, which is the statement that the previous release is fully drained.
 * Neither alone is enough.
 *
 * Statements that act on a table created in the SAME migration are exempt: no N-1
 * code can have seen that table, so e.g. `alter table <new> enable row level
 * security` is safe. The classifier is conservative text analysis, not a parser; an
 * unrecognised statement is `unclassified` and therefore refused.
 *
 * Baseline: migrations up to `compatBaseline()` are already in the previous release
 * and are grandfathered; the baseline is derived (live ledger at runtime, registry
 * or ZENITH_COMPAT_BASELINE_VERSION in CI), never a constant.
 *
 * Runtime direction: a build that finds the database AHEAD of it (a newer release
 * migrated) is allowed, which is what makes N-1 run against schema N
 * (`platformSchemaStatus().ahead`); an N build against schema N-1 fails closed with
 * `schema_behind` until the operator runs the migration step first (expand, then
 * roll out). See docs/platform/operations/ROLLING-UPGRADES.md.
 */
import { classifyStatement, maxClass, splitStatements } from "@/lib/release-safety/classify";
import type { MigrationClass } from "@/lib/release-safety/types";
import { sha256Hex } from "@/lib/controlplane/digest";
import { ControlStoreError } from "./errors";
import { PLATFORM_SCHEMA_VERSION, type PlatformMigration } from "./migrations/index";

/**
 * The highest schema version the PREVIOUS release (N-1) already has. Never hard-coded:
 *  - at runtime `migratePlatformDb` uses the highest version applied in the live database
 *    (a fresh database has no N-1, so everything is grandfathered);
 *  - for static checks and CI it is ZENITH_COMPAT_BASELINE_VERSION (set to the previous
 *    release's highest version at release time), else the registry's current highest version.
 */
export function compatBaseline(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.ZENITH_COMPAT_BASELINE_VERSION?.trim();
  if (raw === undefined || raw === "") return PLATFORM_SCHEMA_VERSION;
  if (!/^d{1,6}$/.test(raw)) throw new ContractMigrationRefusedError("ZENITH_COMPAT_BASELINE_VERSION must be a whole migration version.", {});
  return Number(raw);
}

export interface ContractMigrationApproval {
  version: number;
  /** sha256 hex of the migration's exact `sql` text */
  sqlSha256: string;
  /** the LIFE-10 release approval (separate human approval) that authorised the contract class */
  approvalRef: string;
  /** one line: why a contract change was unavoidable and what N-1 behaviour breaks */
  rationale: string;
}

/**
 * Reviewed registry of approved contract migrations. Adding an entry needs the
 * LIFE-10 approval reference; it does not by itself allow the migration to run.
 */
export const CONTRACT_MIGRATION_APPROVALS: readonly ContractMigrationApproval[] = [{
  version: 42,
  sqlSha256: "3dcc8f12119594941f82dd749f5471fb2578f1d5c37ec09083491aa6dc91f4b2",
  approvalRef: "user-2026-10-07-external-effect-key-bounds",
  rationale: "Explicitly authorized repair of migration 33's PostgreSQL regex bound; preserves key alphabet and 256-character limit. Drain previous writers before applying.",
}];

export interface MigrationCompatAssessment {
  version: number;
  name: string;
  /** worst class over the statements that touch pre-existing objects */
  class: MigrationClass;
  findings: string[];
  /** statements exempted because they act on a table created in the same migration */
  localStatements: number;
  baseline: boolean;
}

const IDENT = String.raw`("?[a-z_][a-z0-9_$]*"?(?:\."?[a-z_][a-z0-9_$]*"?)?)`;
const norm = (s: string): string => s.replace(/"/g, "").replace(/^public\./, "");

function createdTable(stmt: string): string | undefined {
  const m = new RegExp(String.raw`^create (?:unlogged |temp |temporary )?table (?:if not exists )?${IDENT}`, "i").exec(stmt.replace(/\s+/g, " ").trim());
  return m ? norm(m[1]!.toLowerCase()) : undefined;
}

/** The table a statement acts on, when it can be named without parsing the whole statement. */
function targetTable(stmt: string): string | undefined {
  const s = stmt.replace(/\s+/g, " ").trim().toLowerCase();
  const patterns = [
    new RegExp(String.raw`^alter table (?:if exists )?(?:only )?${IDENT}`),
    new RegExp(String.raw`^create (?:unique )?index (?:concurrently )?(?:if not exists )?(?:${IDENT} )?on (?:only )?${IDENT}`),
    new RegExp(String.raw`^(?:create (?:or replace )?(?:constraint )?trigger|create policy|drop trigger(?: if exists)?|drop policy(?: if exists)?) ${IDENT}(?: [^;]*?)? on ${IDENT}`),
    new RegExp(String.raw`^(?:insert into|update|delete from) ${IDENT}`),
    new RegExp(String.raw`^(?:grant|revoke) [^;]*? on (?:table )?${IDENT}`),
    new RegExp(String.raw`^comment on (?:table|column) ${IDENT}`),
  ];
  for (const p of patterns) {
    const m = p.exec(s);
    if (!m) continue;
    const name = m[m.length - 1];
    if (name) return norm(name);
  }
  return undefined;
}

/** Classify one platform migration for N-1 compatibility. Pure. */
export function assessPlatformMigration(migration: PlatformMigration, baseline: number = compatBaseline()): MigrationCompatAssessment {
  const statements = splitStatements(migration.sql);
  const created = new Set<string>();
  for (const stmt of statements) {
    const t = createdTable(stmt);
    if (t) created.add(t);
  }
  let cls: MigrationClass = "none";
  let local = 0;
  const findings = new Set<string>();
  for (const stmt of statements) {
    const target = targetTable(stmt);
    if (target && created.has(target)) { local += 1; continue; }
    const r = classifyStatement(stmt);
    cls = maxClass(cls, r.class);
    if (r.class !== "none" && r.class !== "expand") findings.add(r.finding);
  }
  return { version: migration.version, name: migration.name, class: cls, findings: [...findings], localStatements: local, baseline: migration.version <= baseline };
}

const sqlSha256 = (migration: PlatformMigration): string => sha256Hex(migration.sql);

/** A migration that may not run: contract-class, past the baseline, and not (validly) approved. */
export interface ContractViolation {
  version: number;
  name: string;
  class: MigrationClass;
  findings: string[];
  reason: "not_registered" | "sql_changed_since_approval";
}

/**
 * Every non-baseline migration in `migrations` that is contract/unclassified and not
 * covered by a registry entry whose SQL hash still matches.
 */
export function contractViolations(
  migrations: readonly PlatformMigration[],
  opts: { baseline?: number; approvals?: readonly ContractMigrationApproval[] } = {}
): ContractViolation[] {
  const approvals = opts.approvals ?? CONTRACT_MIGRATION_APPROVALS;
  const out: ContractViolation[] = [];
  for (const migration of migrations) {
    const a = assessPlatformMigration(migration, opts.baseline);
    if (a.baseline || (a.class !== "contract" && a.class !== "unclassified")) continue;
    const approval = approvals.find((x) => x.version === migration.version);
    if (!approval) out.push({ version: a.version, name: a.name, class: a.class, findings: a.findings, reason: "not_registered" });
    else if (approval.sqlSha256 !== sqlSha256(migration)) out.push({ version: a.version, name: a.name, class: a.class, findings: a.findings, reason: "sql_changed_since_approval" });
  }
  return out;
}

export class ContractMigrationRefusedError extends ControlStoreError {
  constructor(message: string, details: Record<string, unknown>) {
    super("invalid_state", message, details);
    this.name = "ContractMigrationRefusedError";
  }
}

export function parseAllowedContractVersions(raw: string | undefined): Set<number> {
  const out = new Set<number>();
  for (const part of (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    if (!/^\d{1,6}$/.test(part)) throw new ContractMigrationRefusedError("ZENITH_ALLOW_CONTRACT_MIGRATIONS must be a comma-separated list of migration versions.", {});
    out.add(Number(part));
  }
  return out;
}

/**
 * Called by `migratePlatformDb` with the migrations it is about to apply. Throws, before
 * anything is applied, when a pending migration breaks the N-1 contract without both the
 * registered approval and the operator confirmation.
 */
export function assertPendingMigrationsCompatible(
  pending: readonly PlatformMigration[],
  opts: { baseline?: number; approvals?: readonly ContractMigrationApproval[]; allowed?: ReadonlySet<number> } = {}
): void {
  const allowed = opts.allowed ?? parseAllowedContractVersions(process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS);
  const approvals = opts.approvals ?? CONTRACT_MIGRATION_APPROVALS;
  const bad = contractViolations(pending, { baseline: opts.baseline, approvals });
  const unconfirmed = pending
    .filter((m) => {
      const a = assessPlatformMigration(m, opts.baseline);
      return !a.baseline && (a.class === "contract" || a.class === "unclassified") && approvals.some((x) => x.version === m.version) && !allowed.has(m.version);
    })
    .map((m) => m.version);
  if (bad.length === 0 && unconfirmed.length === 0) return;
  const parts = [
    ...bad.map((b) => `migration ${b.version} ("${b.name}") is ${b.class}: ${b.reason === "not_registered" ? "no LIFE-10 approval is registered for it" : "its SQL changed after approval"} (${b.findings.join("; ") || "no detail"})`),
    ...unconfirmed.map((v) => `migration ${v} is an approved contract migration; confirm the previous release is drained by setting ZENITH_ALLOW_CONTRACT_MIGRATIONS=${v}`),
  ];
  throw new ContractMigrationRefusedError(
    `Refusing to apply: ${parts.join(". ")}. Within a release a migration must be expand-only so the previous release keeps working and rollback stays possible. Nothing was applied.`,
    { versions: [...bad.map((b) => b.version), ...unconfirmed] }
  );
}
