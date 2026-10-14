/**
 * Retention policy schema and loader (PROD-OPS-07).
 *
 * One window per data class (`RETENTION_CLASSES`): `archiveAfterDays` (copy cold rows to object storage) and
 * `pruneAfterDays` (remove the source rows that have a verified archive). `null` or absent means retain forever.
 *
 * DEC-RETENTION (owner-approved 2026-10-13) ships as the DEFAULT policy: production logs 30 days, sensitive execution
 * payloads 72 hours after settlement (see sensitivedata/minimize.ts), essential audit records at least one year and never
 * auto-deleted. Approved does not mean running: nothing is deleted on an installation until its operator sets the apply
 * switches. The built-in approval covers only the built-in default; an operator policy needs its own `approval`.
 * Deleting rows of an audit-evidence class (resource_observations, drift_reports) sooner than one year is refused.
 *
 * Shape (JSON, from `ZENITH_RETENTION_POLICY_FILE` or inline `ZENITH_RETENTION_POLICY`; setting both is refused):
 *
 *   {
 *     "version": 1,
 *     "classes":    { "runner_job_logs": { "archiveAfterDays": 30, "pruneAfterDays": 90, "archiveExpireAfterDays": 365 } },
 *     "workspaces": { "<workspaceId>": { "runner_job_logs": { "pruneAfterDays": null }, "tenantArchiveExpiry": "policy" } },
 *     "approval":   { "decision": "DEC-RETENTION", "approvedBy": "...", "approvedAt": "<ISO time>", "note": "..." }
 *   }
 *
 * `approval` records that DEC-RETENTION was approved for exactly this policy. Without it, and without the explicit
 * `ZENITH_RETENTION_APPLY=1`, nothing is ever deleted (see `retentionApplyGate`): archiving and the dry-run preview
 * still work. A name that is not a retention class (including every protected table) is refused with the reason, and
 * `pruneAfterDays` without a shorter-or-equal `archiveAfterDays` is refused, so a prune can never precede its archive.
 *
 * `archiveExpireAfterDays` (optional, log classes only) deletes the archive OBJECT that many days after its newest row (see
 * expiry.ts): it must not be earlier than `pruneAfterDays` and is refused on audit-evidence classes. Archives in a
 * tenant-owned bucket are never deleted by Zenith unless the workspace sets `tenantArchiveExpiry: "policy"`.
 *
 * An invalid policy is never half-applied: the job treats it as "retain everything" and reports it.
 */
import fs from "node:fs";
import { digest } from "@/lib/controlplane/digest";
import { RETENTION_CLASSES, refusalFor, type RetentionClass } from "./classes";

export const MAX_RETENTION_DAYS = 36_500;
export const POLICY_FILE_ENV = "ZENITH_RETENTION_POLICY_FILE";
export const POLICY_INLINE_ENV = "ZENITH_RETENTION_POLICY";
export const APPLY_ENV = "ZENITH_RETENTION_APPLY";

/** DEC-RETENTION: production log lines are kept this long. */
export const APPROVED_LOG_RETENTION_DAYS = 30;
/** DEC-RETENTION (archive expiry, 2026-10-14): log archive objects in the operator bucket are deleted this many days after their newest row, so logs live 30 days in the database and at most one year in total. */
export const APPROVED_ARCHIVE_EXPIRY_DAYS = 365;
/** DEC-RETENTION: sensitive execution payloads are deleted within this many hours after an operation settles. */
export const APPROVED_PAYLOAD_RETENTION_HOURS = 72;
/** DEC-RETENTION: essential audit records (approvals, infrastructure changes, outcomes) are kept at least this long. */
export const AUDIT_MINIMUM_RETENTION_DAYS = 365;
/** Classes that record infrastructure changes and outcomes; no prune window may be shorter than the audit minimum. */
export const AUDIT_EVIDENCE_CLASSES: readonly RetentionClass[] = Object.freeze(["resource_observations", "drift_reports"] as RetentionClass[]);

export interface RetentionWindow {
  archiveAfterDays: number | null;
  pruneAfterDays: number | null;
  /**
   * Delete the archive OBJECT this many days after its newest row (`last_recorded_at`). Optional: absent or null means
   * archives of the class are kept until the bucket's own lifecycle removes them. Refused on audit-evidence classes.
   */
  archiveExpireAfterDays?: number | null;
}
export type ClassWindows = Partial<Record<RetentionClass, Partial<RetentionWindow>>>;

/**
 * Who deletes archive objects written to a TENANT-owned destination. `customer_controlled` (the default): Zenith never
 * deletes them, the customer's bucket lifecycle governs. `policy`: the workspace opted in, so the class expiry applies.
 */
export type TenantArchiveExpiry = "customer_controlled" | "policy";
export const TENANT_ARCHIVE_EXPIRY_MODES: readonly TenantArchiveExpiry[] = Object.freeze(["customer_controlled", "policy"] as TenantArchiveExpiry[]);

/** A workspace override: per-class windows plus the reserved key `tenantArchiveExpiry`. */
export type WorkspaceOverrides = ClassWindows & { tenantArchiveExpiry?: TenantArchiveExpiry };

export interface PolicyApproval { decision: "DEC-RETENTION"; approvedBy: string; approvedAt: string; note?: string }

export interface RetentionPolicy {
  version: 1;
  classes: ClassWindows;
  workspaces: Record<string, WorkspaceOverrides>;
  approval?: PolicyApproval;
}

export class RetentionPolicyError extends Error {
  readonly code = "retention_policy_invalid";
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`The retention policy is invalid: ${problems.slice(0, 5).join(" ")}`);
    this.name = "RetentionPolicyError";
    this.problems = problems;
  }
}

/**
 * The approved launch baseline (DEC-RETENTION). Logs: archive and prune at 30 days. Audit-evidence classes stay unset
 * (retained). Deletion still needs the operator's apply switch.
 */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  version: 1,
  classes: Object.freeze({
    runner_job_logs: Object.freeze({ archiveAfterDays: APPROVED_LOG_RETENTION_DAYS, pruneAfterDays: APPROVED_LOG_RETENTION_DAYS, archiveExpireAfterDays: APPROVED_ARCHIVE_EXPIRY_DAYS }),
    machine_request_logs: Object.freeze({ archiveAfterDays: APPROVED_LOG_RETENTION_DAYS, pruneAfterDays: APPROVED_LOG_RETENTION_DAYS, archiveExpireAfterDays: APPROVED_ARCHIVE_EXPIRY_DAYS }),
  }),
  workspaces: Object.freeze({}),
  approval: Object.freeze({
    decision: "DEC-RETENTION" as const,
    approvedBy: "Arnav Bule",
    approvedAt: "2026-10-13T00:00:00.000Z",
    note: "Launch baseline: production logs 30 days; sensitive execution payloads 72 hours after settlement; essential audit records kept at least one year and not auto-deleted; log archive objects in the operator bucket expire 365 days after their newest row (tenant-owned buckets are customer-controlled unless the workspace opts in). Deletion runs only where the operator sets the apply switch.",
  }),
}) as RetentionPolicy;

const WORKSPACE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseDays(value: unknown, where: string, problems: string[]): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_RETENTION_DAYS) {
    problems.push(`${where} must be a whole number of days from 1 to ${MAX_RETENTION_DAYS}, or null to retain forever.`);
    return undefined;
  }
  return value;
}

function parseClassWindows(value: unknown, where: string, problems: string[], requireOrder: boolean): ClassWindows {
  const out: ClassWindows = {};
  if (value === undefined) return out;
  if (!isRecord(value)) { problems.push(`${where} must be an object keyed by data class.`); return out; }
  for (const [name, raw] of Object.entries(value)) {
    const refusal = refusalFor(name);
    if (refusal) { problems.push(`${where}: ${refusal}`); continue; }
    if (!isRecord(raw)) { problems.push(`${where}.${name} must be an object.`); continue; }
    for (const key of Object.keys(raw)) if (key !== "archiveAfterDays" && key !== "pruneAfterDays" && key !== "archiveExpireAfterDays") problems.push(`${where}.${name}.${key} is not a retention setting.`);
    const archive = parseDays(raw.archiveAfterDays, `${where}.${name}.archiveAfterDays`, problems);
    const prune = parseDays(raw.pruneAfterDays, `${where}.${name}.pruneAfterDays`, problems);
    const expire = parseDays(raw.archiveExpireAfterDays, `${where}.${name}.archiveExpireAfterDays`, problems);
    if (typeof expire === "number" && AUDIT_EVIDENCE_CLASSES.includes(name as RetentionClass)) {
      problems.push(`${where}.${name}.archiveExpireAfterDays: ${name} is audit evidence, so its archives are not expired by Zenith.`);
    }
    if (requireOrder && typeof expire === "number" && typeof prune === "number" && expire < prune) {
      problems.push(`${where}.${name}.archiveExpireAfterDays must not be earlier than pruneAfterDays: an archive is the copy of rows that were pruned.`);
    }
    if (requireOrder && typeof prune === "number" && (typeof archive !== "number" || archive > prune)) {
      problems.push(`${where}.${name}: pruneAfterDays needs an archiveAfterDays that is not later, so rows are archived before they are pruned.`);
    }
    if (AUDIT_EVIDENCE_CLASSES.includes(name as RetentionClass) && typeof prune === "number" && prune < AUDIT_MINIMUM_RETENTION_DAYS) {
      problems.push(`${where}.${name}.pruneAfterDays: ${name} records infrastructure changes and outcomes, so it must be kept at least ${AUDIT_MINIMUM_RETENTION_DAYS} days (one year) before it can be pruned.`);
    }
    out[name as RetentionClass] = {
      ...(archive !== undefined ? { archiveAfterDays: archive } : {}),
      ...(prune !== undefined ? { pruneAfterDays: prune } : {}),
      ...(expire !== undefined ? { archiveExpireAfterDays: expire } : {}),
    };
  }
  return out;
}

/** Validate a parsed policy document. Throws `RetentionPolicyError` listing every problem. */
export function parseRetentionPolicy(input: unknown): RetentionPolicy {
  const problems: string[] = [];
  if (!isRecord(input)) throw new RetentionPolicyError(["The policy must be a JSON object."]);
  for (const key of Object.keys(input)) if (!["version", "classes", "workspaces", "approval"].includes(key)) problems.push(`"${key}" is not a policy field.`);
  if (input.version !== 1) problems.push("version must be 1.");
  const classes = parseClassWindows(input.classes, "classes", problems, true);
  const workspaces: Record<string, WorkspaceOverrides> = {};
  if (input.workspaces !== undefined) {
    if (!isRecord(input.workspaces)) problems.push("workspaces must be an object keyed by workspace id.");
    else for (const [id, windows] of Object.entries(input.workspaces)) {
      if (!WORKSPACE_ID.test(id)) { problems.push(`workspaces: "${id.slice(0, 40)}" is not a valid workspace id.`); continue; }
      // The reserved key `tenantArchiveExpiry` is a workspace setting, not a data class.
      let classPart: unknown = windows;
      let tenantExpiry: TenantArchiveExpiry | undefined;
      if (isRecord(windows) && "tenantArchiveExpiry" in windows) {
        const { tenantArchiveExpiry, ...rest } = windows;
        classPart = rest;
        if (typeof tenantArchiveExpiry === "string" && (TENANT_ARCHIVE_EXPIRY_MODES as readonly string[]).includes(tenantArchiveExpiry)) tenantExpiry = tenantArchiveExpiry as TenantArchiveExpiry;
        else problems.push(`workspaces.${id}.tenantArchiveExpiry must be "customer_controlled" or "policy".`);
      }
      // Overrides are validated against the merged window below.
      workspaces[id] = { ...parseClassWindows(classPart, `workspaces.${id}`, problems, false), ...(tenantExpiry ? { tenantArchiveExpiry: tenantExpiry } : {}) };
    }
  }
  for (const [id, windows] of Object.entries(workspaces)) {
    for (const cls of RETENTION_CLASSES) {
      const w = resolveWindow({ version: 1, classes, workspaces }, id, cls);
      if (typeof w.pruneAfterDays === "number" && (typeof w.archiveAfterDays !== "number" || w.archiveAfterDays > w.pruneAfterDays) && windows[cls]) {
        problems.push(`workspaces.${id}.${cls}: pruneAfterDays needs an archiveAfterDays that is not later.`);
      }
      const expire = resolveArchiveExpiry({ classes, workspaces }, id, cls);
      if (windows[cls] && typeof expire === "number" && typeof w.pruneAfterDays === "number" && expire < w.pruneAfterDays) {
        problems.push(`workspaces.${id}.${cls}: archiveExpireAfterDays must not be earlier than pruneAfterDays.`);
      }
    }
  }
  let approval: PolicyApproval | undefined;
  if (input.approval !== undefined) {
    const a = input.approval;
    if (!isRecord(a) || a.decision !== "DEC-RETENTION" || typeof a.approvedBy !== "string" || !a.approvedBy.trim() || a.approvedBy.length > 200
      || typeof a.approvedAt !== "string" || Number.isNaN(Date.parse(a.approvedAt)) || (a.note !== undefined && (typeof a.note !== "string" || a.note.length > 500))) {
      problems.push('approval must be { "decision": "DEC-RETENTION", "approvedBy": text, "approvedAt": ISO time, "note"?: text }.');
    } else approval = { decision: "DEC-RETENTION", approvedBy: a.approvedBy.trim(), approvedAt: a.approvedAt, ...(a.note ? { note: a.note } : {}) };
  }
  if (problems.length) throw new RetentionPolicyError(problems);
  return { version: 1, classes, workspaces, ...(approval ? { approval } : {}) };
}

/** The window in force for one workspace and class: workspace override, else the default, else retain forever. */
export function resolveWindow(policy: RetentionPolicy, workspaceId: string, cls: RetentionClass): RetentionWindow {
  const base = policy.classes[cls] ?? {};
  const over = policy.workspaces[workspaceId]?.[cls] ?? {};
  const pick = (key: "archiveAfterDays" | "pruneAfterDays"): number | null => {
    const v = key in over ? over[key] : base[key];
    return typeof v === "number" ? v : null;
  };
  return { archiveAfterDays: pick("archiveAfterDays"), pruneAfterDays: pick("pruneAfterDays") };
}

/**
 * Days after an archive's newest row at which its object is deleted, for one workspace and class (workspace override,
 * else the class default, else null = never deleted by Zenith). Audit-evidence classes are always null.
 */
export function resolveArchiveExpiry(policy: Pick<RetentionPolicy, "classes" | "workspaces">, workspaceId: string, cls: RetentionClass): number | null {
  if (AUDIT_EVIDENCE_CLASSES.includes(cls)) return null;
  const base = policy.classes[cls] ?? {};
  const over = policy.workspaces[workspaceId]?.[cls] ?? {};
  const v = "archiveExpireAfterDays" in over ? over.archiveExpireAfterDays : base.archiveExpireAfterDays;
  return typeof v === "number" ? v : null;
}

/** Did this workspace opt in to Zenith expiring archives that live in ITS OWN bucket? Default: no, the customer's lifecycle governs. */
export function tenantArchiveExpiryOptIn(policy: Pick<RetentionPolicy, "workspaces">, workspaceId: string): boolean {
  return policy.workspaces[workspaceId]?.tenantArchiveExpiry === "policy";
}

/** The smallest archive/prune window anywhere in the policy for a class, to bound candidate scans. Null = retain forever everywhere. */
export function widestScan(policy: RetentionPolicy, cls: RetentionClass, kind: keyof RetentionWindow): number | null {
  const values: number[] = [];
  const base = policy.classes[cls]?.[kind];
  if (typeof base === "number") values.push(base);
  for (const windows of Object.values(policy.workspaces)) { const v = windows[cls]?.[kind]; if (typeof v === "number") values.push(v); }
  return values.length ? Math.min(...values) : null;
}

export function policyDigest(policy: RetentionPolicy): string {
  return digest(policy);
}

export type PolicyLoad =
  | { ok: true; policy: RetentionPolicy; source: "default" | "file" | "inline"; digest: string }
  | { ok: false; policy: RetentionPolicy; source: "file" | "inline" | "both"; digest: string; problems: readonly string[] };

/**
 * Load the policy from configuration. Never throws: a missing policy is the retain-forever default, an unreadable or
 * invalid one is reported and nothing is archived or deleted (the gate and the job refuse an invalid load).
 */
export function loadRetentionPolicy(env: Readonly<Record<string, string | undefined>> = process.env, read: (path: string) => string = (p) => fs.readFileSync(p, "utf8")): PolicyLoad {
  const file = env[POLICY_FILE_ENV]?.trim();
  const inline = env[POLICY_INLINE_ENV]?.trim();
  const fallback = (source: "file" | "inline" | "both", problems: string[]): PolicyLoad => ({ ok: false, policy: DEFAULT_RETENTION_POLICY, source, digest: policyDigest(DEFAULT_RETENTION_POLICY), problems });
  if (file && inline) return fallback("both", [`Set only one of ${POLICY_FILE_ENV} and ${POLICY_INLINE_ENV}.`]);
  if (!file && !inline) return { ok: true, policy: DEFAULT_RETENTION_POLICY, source: "default", digest: policyDigest(DEFAULT_RETENTION_POLICY) };
  const source = file ? "file" : "inline";
  let text: string;
  try { text = file ? read(file) : inline!; } catch { return fallback(source, [`${POLICY_FILE_ENV} could not be read.`]); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fallback(source, ["The policy is not valid JSON."]); }
  try {
    const policy = parseRetentionPolicy(parsed);
    return { ok: true, policy, source, digest: policyDigest(policy) };
  } catch (error) {
    return fallback(source, error instanceof RetentionPolicyError ? [...error.problems] : ["The policy could not be validated."]);
  }
}

export interface ApplyGate { enabled: boolean; reason: string }

/**
 * May this process delete anything? Same shape as the OPS-06 gate (`minimizeApplyEnabled`): an explicit
 * `ZENITH_RETENTION_APPLY=1` AND the loaded policy's DEC-RETENTION approval record. Either missing: dry run only.
 */
export function retentionApplyGate(env: Readonly<Record<string, string | undefined>>, load: PolicyLoad): ApplyGate {
  if (!load.ok) return { enabled: false, reason: "The policy is invalid; nothing is archived or deleted." };
  if (env[APPLY_ENV] !== "1") return { enabled: false, reason: `Dry run: ${APPLY_ENV}=1 is not set, so nothing is deleted.` };
  if (!load.policy.approval) return { enabled: false, reason: "Dry run: the policy has no DEC-RETENTION approval record, so nothing is deleted." };
  return { enabled: true, reason: `Deletion enabled by ${load.policy.approval.approvedBy} (DEC-RETENTION).` };
}
