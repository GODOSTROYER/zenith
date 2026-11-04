/**
 * Least-privilege diff: the actions a compiled bootstrap policy grants versus the
 * actions the compiler actually needs.
 *
 * This is a static, contract-level comparison. It never calls AWS and it never
 * proposes or applies a wider grant: its outputs are `missing` (needed but not
 * granted: a deployment would fail at IAM, fix the driver or consciously change
 * the bootstrap through review) and `unused` (granted write actions nothing in
 * the compiler needs: candidates to narrow). Read-only verbs are not reported as
 * unused because OpenTofu refresh and Zenith observation use many of them.
 * Independent live IAM acceptance is a separate, deferred requirement.
 */

const READ_VERB = /^(Describe|List|Get|BatchGet|Lookup|Search|Check|Head|View|Query|Scan|Filter)/;
/** Services where an unused grant matters more than elsewhere. */
export const SENSITIVE_SERVICES: ReadonlySet<string> = new Set(["iam", "kms", "secretsmanager", "sts", "organizations", "account"]);

export interface UsedAction {
  readonly action: string;
  /** Terraform resource types that need it, sorted. */
  readonly via: readonly string[];
}

export type MissingAction = UsedAction;

export interface LeastPrivilegeReport {
  /** Needed by the compiler and not matched by any granted pattern. */
  readonly missing: readonly MissingAction[];
  /** Granted write patterns no needed action matches (read verbs excluded). */
  readonly unused: readonly string[];
  /** The `unused` entries in a sensitive service. */
  readonly unusedSensitive: readonly string[];
  readonly grantedPatterns: number;
  readonly usedActions: number;
}

const escapeRegExp = (text: string): string => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** IAM action globbing: `*` and `?`, case-insensitive. */
export function actionMatches(pattern: string, action: string): boolean {
  if (typeof pattern !== "string" || typeof action !== "string" || pattern.length > 256 || action.length > 256) return false;
  const regexp = new RegExp(`^${escapeRegExp(pattern).replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return regexp.test(action);
}

const serviceOf = (action: string): string => action.split(":", 1)[0].toLowerCase();
export const isReadAction = (action: string): boolean => READ_VERB.test(action.slice(action.indexOf(":") + 1));

/** Distinct, validated action strings. `*` alone and malformed values refuse. */
function cleanActions(values: readonly string[], what: string): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !/^[A-Za-z0-9-]+:[A-Za-z0-9*?]+$/.test(value)) throw new Error(`Least-privilege input ${what} contains an invalid action.`);
    out.add(value);
  }
  return [...out].sort();
}

export function diffAgainstCompilerActions(granted: readonly string[], used: readonly UsedAction[]): LeastPrivilegeReport {
  const patterns = cleanActions(granted, "granted");
  const needed = new Map<string, Set<string>>();
  for (const item of used) {
    const [action] = cleanActions([item.action], "used");
    const via = needed.get(action) ?? new Set<string>();
    for (const type of item.via) via.add(type);
    needed.set(action, via);
  }
  const missing: MissingAction[] = [];
  for (const [action, via] of [...needed].sort(([a], [b]) => a.localeCompare(b))) {
    if (!patterns.some((pattern) => actionMatches(pattern, action))) missing.push(Object.freeze({ action, via: Object.freeze([...via].sort()) }));
  }
  const unused = patterns.filter((pattern) => !isReadAction(pattern) && ![...needed.keys()].some((action) => actionMatches(pattern, action)));
  return Object.freeze({
    missing: Object.freeze(missing),
    unused: Object.freeze(unused),
    unusedSensitive: Object.freeze(unused.filter((pattern) => SENSITIVE_SERVICES.has(serviceOf(pattern)))),
    grantedPatterns: patterns.length,
    usedActions: needed.size,
  });
}

/** Allow-statement actions of a policy document, deduplicated and sorted. Deny and NotAction statements are ignored. */
export function allowedActionsOf(doc: unknown): string[] {
  const parsed = typeof doc === "string" ? JSON.parse(doc) : doc;
  const statements = (parsed as { Statement?: unknown }).Statement;
  const list = Array.isArray(statements) ? statements : statements ? [statements] : [];
  const out = new Set<string>();
  for (const statement of list as Record<string, unknown>[]) {
    if (statement.Effect !== "Allow" || statement.NotAction !== undefined) continue;
    for (const action of ([] as unknown[]).concat(statement.Action ?? [])) if (typeof action === "string") out.add(action);
  }
  return [...out].sort();
}
