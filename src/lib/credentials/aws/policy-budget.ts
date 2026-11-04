/**
 * IAM managed-policy size budgeting and deterministic splitting.
 *
 * IAM limits a managed policy to 6,144 characters (whitespace excluded) and a
 * role to 10 attached managed policies by default. A statement list that does
 * not fit one policy is split into several, never trimmed: every statement is
 * kept whole and in a stable order, so the union of the parts grants exactly
 * what the original did. A single statement that cannot fit, or a split that
 * needs more policies than the role may carry, refuses explicitly. A
 * permissions boundary is ONE managed policy per role and cannot be split, so
 * its budget is a hard refusal (`assertBoundaryFits`), never an automatic split.
 *
 * Size convention matches the bootstrap tests and the preflight readback:
 * compact JSON with all whitespace removed.
 */

export const IAM_MANAGED_POLICY_MAX_CHARS = 6144;
/** IAM default quota; customers can raise it to 20, Zenith never assumes they did. */
export const IAM_ROLE_MANAGED_POLICIES_DEFAULT_QUOTA = 10;
/** Permission boundaries keep 344 characters of free space for future additions. */
export const BOUNDARY_POLICY_BUDGET_CHARS = 5800;
/** A policy at or above this share of its budget is reported as near the limit. */
export const POLICY_NEAR_LIMIT_RATIO = 0.9;

export class PolicyBudgetError extends Error {
  readonly code = "policy_budget_exceeded";
  constructor(message: string) {
    super(message);
    this.name = "PolicyBudgetError";
  }
}

export type PolicyStatementLike = Readonly<Record<string, unknown>>;

export interface PolicyDocumentLike {
  readonly Version: string;
  readonly Statement: readonly PolicyStatementLike[] | PolicyStatementLike;
}

/** IAM's size metric: the JSON text without whitespace. */
export const compactPolicySize = (doc: unknown): number =>
  JSON.stringify(typeof doc === "string" ? JSON.parse(doc) : doc).replace(/\s+/g, "").length;

const documentOf = (statements: readonly PolicyStatementLike[]): PolicyDocumentLike => ({ Version: "2012-10-17", Statement: statements });
const EMPTY_DOCUMENT_SIZE = compactPolicySize(documentOf([]));

export interface PolicyBudgetReading {
  readonly size: number;
  readonly budget: number;
  readonly headroom: number;
  readonly nearLimit: boolean;
  readonly overBudget: boolean;
}

export function readPolicyBudget(doc: unknown, budget = IAM_MANAGED_POLICY_MAX_CHARS): PolicyBudgetReading {
  if (!Number.isInteger(budget) || budget < 1 || budget > IAM_MANAGED_POLICY_MAX_CHARS) throw new PolicyBudgetError("Policy budget must be between 1 and 6144 characters.");
  const size = compactPolicySize(doc);
  return Object.freeze({ size, budget, headroom: budget - size, nearLimit: size >= budget * POLICY_NEAR_LIMIT_RATIO, overBudget: size > budget });
}

/** Boundaries cannot be split: refuse, naming the policy and the overage. */
export function assertBoundaryFits(name: string, doc: unknown, budget = BOUNDARY_POLICY_BUDGET_CHARS): void {
  const reading = readPolicyBudget(doc, budget);
  if (reading.overBudget) {
    throw new PolicyBudgetError(`${name}: ${reading.size} characters exceeds the ${budget}-character boundary budget (IAM maximum ${IAM_MANAGED_POLICY_MAX_CHARS}). A permissions boundary is a single managed policy and cannot be split; reduce its statements.`);
  }
}

export interface PolicySplitOptions {
  /** Per-policy character budget; defaults to the IAM maximum. */
  readonly budget?: number;
  /** Most policies the role may carry for this set; defaults to the IAM default quota. */
  readonly maxPolicies?: number;
}

export interface PolicySplitPart {
  readonly index: number;
  readonly statements: readonly PolicyStatementLike[];
  readonly size: number;
}

export interface PolicySplitPlan {
  readonly split: boolean;
  readonly totalStatements: number;
  readonly parts: readonly PolicySplitPart[];
}

/**
 * First-fit-decreasing packing with a stable result: parts are filled in
 * descending statement size (ties by original position) and each part keeps
 * its statements in the original order. The same input always yields the same
 * parts, so generated policy files and reviewed digests do not churn.
 */
export function planManagedPolicySplit(statements: readonly PolicyStatementLike[], options: PolicySplitOptions = {}): PolicySplitPlan {
  const budget = options.budget ?? IAM_MANAGED_POLICY_MAX_CHARS;
  const maxPolicies = options.maxPolicies ?? IAM_ROLE_MANAGED_POLICIES_DEFAULT_QUOTA;
  if (!Number.isInteger(budget) || budget <= EMPTY_DOCUMENT_SIZE || budget > IAM_MANAGED_POLICY_MAX_CHARS) throw new PolicyBudgetError("Policy budget is invalid.");
  if (!Number.isInteger(maxPolicies) || maxPolicies < 1 || maxPolicies > 20) throw new PolicyBudgetError("Managed policy count limit is invalid.");
  if (statements.length === 0) throw new PolicyBudgetError("A policy needs at least one statement.");
  const whole = compactPolicySize(documentOf(statements));
  if (whole <= budget) return Object.freeze({ split: false, totalStatements: statements.length, parts: Object.freeze([Object.freeze({ index: 0, statements: Object.freeze([...statements]), size: whole })]) });

  // Each statement costs its compact size plus one comma separator inside its part.
  const costs = statements.map((statement, position) => ({ statement, position, size: compactPolicySize(statement) }));
  for (const item of costs) {
    if (EMPTY_DOCUMENT_SIZE + item.size > budget) {
      const sid = typeof item.statement.Sid === "string" ? item.statement.Sid.slice(0, 64) : `#${item.position}`;
      throw new PolicyBudgetError(`Statement ${sid} is ${item.size} characters and cannot fit a ${budget}-character managed policy; shorten its resources or conditions.`);
    }
  }
  const bins: { items: typeof costs; size: number }[] = [];
  for (const item of [...costs].sort((a, b) => b.size - a.size || a.position - b.position)) {
    const bin = bins.find((candidate) => candidate.size + item.size + (candidate.items.length > 0 ? 1 : 0) <= budget - EMPTY_DOCUMENT_SIZE);
    if (bin) {
      bin.size += item.size + (bin.items.length > 0 ? 1 : 0);
      bin.items = [...bin.items, item];
    } else {
      bins.push({ items: [item], size: item.size });
    }
  }
  if (bins.length > maxPolicies) {
    throw new PolicyBudgetError(`The statements need ${bins.length} managed policies; the role may carry at most ${maxPolicies}. Reduce the permissions or raise the account quota deliberately.`);
  }
  const parts = bins.map((bin, index) => {
    const ordered = [...bin.items].sort((a, b) => a.position - b.position).map((item) => item.statement);
    return Object.freeze({ index, statements: Object.freeze(ordered), size: compactPolicySize(documentOf(ordered)) });
  });
  // Order parts by the position of their first statement so part 0 holds the head of the document.
  parts.sort((a, b) => costs.findIndex((c) => c.statement === a.statements[0]) - costs.findIndex((c) => c.statement === b.statements[0]));
  const indexed = parts.map((part, index) => Object.freeze({ ...part, index }));
  for (const part of indexed) if (part.size > budget) throw new PolicyBudgetError("Internal policy split exceeded its budget.");
  return Object.freeze({ split: true, totalStatements: statements.length, parts: Object.freeze(indexed) });
}
