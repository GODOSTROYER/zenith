/**
 * The Security screen's pure logic: what a filter shows, what a status means,
 * which automatic fixes the caller can actually run, and the export. All of it
 * is a function of data the screen already holds, so it is testable without a
 * browser and the screen stays presentational.
 */
import type { ActionPlan, Role } from "@/lib/actions/core";
import type { SecurityFinding } from "@/lib/domain/types";

/* --------------------------------- status --------------------------------- */

/**
 * The stored status, in words. `fixed_pending_deploy` is deliberately not
 * called "fixed": the working copy is fixed and the environment is not.
 */
export const STATUS_LABEL: Record<SecurityFinding["status"], string> = {
  open: "open",
  fixed_pending_deploy: "fixed, not deployed",
  resolved: "resolved",
  dismissed: "dismissed",
};

/* --------------------------------- filters -------------------------------- */

export type SeverityFilter = "all" | SecurityFinding["severity"];
export type FixFilter = "all" | "fixable" | "manual";
/** `"all"`, `"none"` (not tied to an environment) or an environment id. */
export type EnvFilter = string;
export type SortKey = "severity" | "newest" | "oldest";

export interface Filters {
  severity: SeverityFilter;
  fix: FixFilter;
  environmentId: EnvFilter;
}

export const NO_FILTERS: Filters = { severity: "all", fix: "all", environmentId: "all" };

export function matches(f: SecurityFinding, filters: Filters): boolean {
  if (filters.severity !== "all" && f.severity !== filters.severity) return false;
  if (filters.fix !== "all" && (filters.fix === "fixable") !== !!f.fix) return false;
  if (filters.environmentId === "all") return true;
  if (filters.environmentId === "none") return !f.environmentId;
  return f.environmentId === filters.environmentId;
}

export const SEVERITY_ORDER: SecurityFinding["severity"][] = ["high", "medium", "low"];

const newestFirst = (a: SecurityFinding, b: SecurityFinding) => (a.createdAt < b.createdAt ? 1 : -1);

/** New array, never a sort in place — the caller's list is shared state. */
export function sortFindings(rows: SecurityFinding[], key: SortKey): SecurityFinding[] {
  return [...rows].sort(
    key === "severity"
      ? (a, b) =>
          SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
          newestFirst(a, b)
      : key === "newest"
        ? newestFirst
        : (a, b) => -newestFirst(a, b)
  );
}

/* ---------------------------------- fixes --------------------------------- */

/** A finding and the plan for its automatic fix, computed before anything ran. */
export interface FixRow {
  finding: SecurityFinding;
  plan?: ActionPlan;
  error?: string;
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/**
 * Does `have` reach `need`? An unknown role — demo mode, or a store with no
 * members — reaches everything, which is what the server does too.
 */
export const roleReaches = (have: Role | null | undefined, need: Role | null | undefined): boolean =>
  !need || !have || RANK[have] >= RANK[need];

/**
 * Why a control on this screen is closed to a viewer. Same sentence wherever
 * it appears — the filters bar, a row's buttons, and Reopen in History.
 */
export const viewerReason = (verb: string, role: Role | null): string =>
  `${verb} needs the editor role and you are ${role ?? "a viewer"} in this workspace. Ask a workspace admin to raise your role in Settings → Members, or have them run it.`;

export interface FixSplit {
  /** planned and not refused: exactly what "Fix all" will run */
  runnable: FixRow[];
  /** the fix's own action needs a role the caller does not have */
  roleBlocked: FixRow[];
  /** the plan refuses for another reason (nowhere to put a secret, …) */
  otherBlocked: FixRow[];
  /** no plan came back at all */
  unplannable: FixRow[];
}

/**
 * A fix whose plan says it would be refused is not a fix. Splitting on the
 * plan — rather than on the finding — is what keeps "Fix all N" from meaning
 * "attempt N and report failures afterwards".
 */
export function splitFixes(rows: FixRow[], role: Role | null): FixSplit {
  const out: FixSplit = { runnable: [], roleBlocked: [], otherBlocked: [], unplannable: [] };
  for (const r of rows) {
    if (!r.plan) out.unplannable.push(r);
    else if (!r.plan.blocked) out.runnable.push(r);
    else if (!roleReaches(role, r.plan.requiredRole)) out.roleBlocked.push(r);
    else out.otherBlocked.push(r);
  }
  return out;
}

/** One sentence naming everything "Fix all" leaves out, and why. */
export function excludedNote(split: FixSplit, role: Role | null): string | undefined {
  const parts: string[] = [];
  if (split.roleBlocked.length > 0) {
    const n = split.roleBlocked.length;
    const roles = [...new Set(split.roleBlocked.map((r) => r.plan?.requiredRole).filter(Boolean))];
    parts.push(
      `${n} ${n === 1 ? "needs" : "need"} the ${roles.join("/") || "required"} role` +
        (role ? ` and you are ${role}` : "")
    );
  }
  if (split.otherBlocked.length > 0) {
    const n = split.otherBlocked.length;
    parts.push(`${n} would be refused by ${n === 1 ? "its" : "their"} own action`);
  }
  if (split.unplannable.length > 0) {
    const n = split.unplannable.length;
    parts.push(`${n} could not be previewed`);
  }
  if (parts.length === 0) return undefined;
  return `Left out of “Fix all”: ${parts.join("; ")}.`;
}

/**
 * Findings whose fix is an environment policy change — budget, approval gate,
 * stateful deletion. They are all edited in one place, so the row can say so.
 */
export const isEnvironmentPolicy = (f: SecurityFinding): boolean =>
  !!f.fix?.actionId.startsWith("env.");

/* --------------------------------- export --------------------------------- */

export const CSV_COLUMNS = [
  "id",
  "severity",
  "status",
  "title",
  "environment",
  "detail",
  "fixAction",
  "fixLabel",
  "createdAt",
  "resolvedAt",
  "resolvedBy",
  "resolvedReason",
  "fixedInRevisionId",
] as const;

/**
 * A cell, quoted. A leading =, +, - or @ is prefixed with an apostrophe:
 * spreadsheets treat those as formulas, and findings quote names and reasons
 * people typed. (Same guard as the Activity export — kept local rather than
 * reaching across screens for a five-line private helper.)
 */
function cell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export const EXPORT_NOTE =
  "Every finding this project has right now, whatever its status. The scanner recomputes findings from the working copy each time the project loads, so this is a snapshot rather than a log — and “fixed, not deployed” means the working copy is fixed while the environment still is not.";

export function toCsv(findings: SecurityFinding[], envName: Record<string, string>): string {
  const rows = findings.map((f) =>
    [
      f.id,
      f.severity,
      STATUS_LABEL[f.status],
      f.title,
      f.environmentId ? (envName[f.environmentId] ?? f.environmentId) : "",
      f.detail,
      f.fix?.actionId,
      f.fix?.label,
      f.createdAt,
      f.resolvedAt,
      f.resolvedBy?.name,
      f.resolvedReason,
      f.fixedInRevisionId,
    ]
      .map(cell)
      .join(",")
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}

export function toJson(
  findings: SecurityFinding[],
  meta: { project: string; at: string; envName: Record<string, string> }
): string {
  return JSON.stringify(
    {
      exportedAt: meta.at,
      project: meta.project,
      note: EXPORT_NOTE,
      counts: findings.reduce<Record<string, number>>((acc, f) => {
        acc[f.status] = (acc[f.status] ?? 0) + 1;
        return acc;
      }, {}),
      findings: findings.map((f) => ({
        ...f,
        environmentName: f.environmentId ? meta.envName[f.environmentId] : undefined,
        statusLabel: STATUS_LABEL[f.status],
      })),
    },
    null,
    2
  );
}
