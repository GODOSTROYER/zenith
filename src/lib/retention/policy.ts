/**
 * Retention policy schema and loader (PROD-OPS-07).
 *
 * One window per data class (`RETENTION_CLASSES`): `archiveAfterDays` (copy cold rows to object storage) and
 * `pruneAfterDays` (remove the source rows that have a verified archive). `null` or absent means retain forever, and
 * the default policy is all-null: nothing is archived or pruned until an operator supplies a policy.
 *
 * Shape (JSON, from `ZENITH_RETENTION_POLICY_FILE` or inline `ZENITH_RETENTION_POLICY`; setting both is refused):
 *
 *   {
 *     "version": 1,
 *     "classes":    { "runner_job_logs": { "archiveAfterDays": 30, "pruneAfterDays": 90 } },
 *     "workspaces": { "<workspaceId>": { "runner_job_logs": { "pruneAfterDays": null } } },
 *     "approval":   { "decision": "DEC-RETENTION", "approvedBy": "...", "approvedAt": "<ISO time>", "note": "..." }
 *   }
 *
 * `approval` records that DEC-RETENTION was approved for exactly this policy. Without it, and without the explicit
 * `ZENITH_RETENTION_APPLY=1`, nothing is ever deleted (see `retentionApplyGate`): archiving and the dry-run preview
 * still work. A name that is not a retention class (including every protected table) is refused with the reason, and
 * `pruneAfterDays` without a shorter-or-equal `archiveAfterDays` is refused, so a prune can never precede its archive.
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

export interface RetentionWindow {
  archiveAfterDays: number | null;
  pruneAfterDays: number | null;
}
export type ClassWindows = Partial<Record<RetentionClass, Partial<RetentionWindow>>>;

export interface PolicyApproval { decision: "DEC-RETENTION"; approvedBy: string; approvedAt: string; note?: string }

export interface RetentionPolicy {
  version: 1;
  classes: ClassWindows;
  workspaces: Record<string, ClassWindows>;
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

/** Retain everything forever. */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({ version: 1, classes: {}, workspaces: {} }) as RetentionPolicy;

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
    for (const key of Object.keys(raw)) if (key !== "archiveAfterDays" && key !== "pruneAfterDays") problems.push(`${where}.${name}.${key} is not a retention setting.`);
    const archive = parseDays(raw.archiveAfterDays, `${where}.${name}.archiveAfterDays`, problems);
    const prune = parseDays(raw.pruneAfterDays, `${where}.${name}.pruneAfterDays`, problems);
    if (requireOrder && typeof prune === "number" && (typeof archive !== "number" || archive > prune)) {
      problems.push(`${where}.${name}: pruneAfterDays needs an archiveAfterDays that is not later, so rows are archived before they are pruned.`);
    }
    out[name as RetentionClass] = { ...(archive !== undefined ? { archiveAfterDays: archive } : {}), ...(prune !== undefined ? { pruneAfterDays: prune } : {}) };
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
  const workspaces: Record<string, ClassWindows> = {};
  if (input.workspaces !== undefined) {
    if (!isRecord(input.workspaces)) problems.push("workspaces must be an object keyed by workspace id.");
    else for (const [id, windows] of Object.entries(input.workspaces)) {
      if (!WORKSPACE_ID.test(id)) { problems.push(`workspaces: "${id.slice(0, 40)}" is not a valid workspace id.`); continue; }
      // Overrides are validated against the merged window below.
      workspaces[id] = parseClassWindows(windows, `workspaces.${id}`, problems, false);
    }
  }
  for (const [id, windows] of Object.entries(workspaces)) {
    for (const cls of RETENTION_CLASSES) {
      const w = resolveWindow({ version: 1, classes, workspaces }, id, cls);
      if (typeof w.pruneAfterDays === "number" && (typeof w.archiveAfterDays !== "number" || w.archiveAfterDays > w.pruneAfterDays) && windows[cls]) {
        problems.push(`workspaces.${id}.${cls}: pruneAfterDays needs an archiveAfterDays that is not later.`);
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
  const pick = (key: keyof RetentionWindow): number | null => {
    const v = key in over ? over[key] : base[key];
    return typeof v === "number" ? v : null;
  };
  return { archiveAfterDays: pick("archiveAfterDays"), pruneAfterDays: pick("pruneAfterDays") };
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
 * invalid one is reported with the default (retain everything) in force.
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
