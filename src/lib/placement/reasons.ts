/**
 * Rejection-reason vocabulary shared by the solver (which writes reasons) and
 * the feasibility report (which reads them). One definition per category keeps
 * the two from drifting; a test round-trips every builder through its parser.
 *
 * A reason is `<category>: <text>`. Categories the solver emits are listed in
 * `REJECTION_CATEGORIES`.
 */

export const REJECTION_CATEGORIES = [
  "budget",
  "residency",
  "availability",
  "capability",
  "pin",
  "price",
  "region",
  "denylist",
  "cross-cloud margin",
  "connection",
  "input",
] as const;
export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number];

const money = (x: number) => `${x < 0 ? "-" : ""}${Math.abs(x).toFixed(2)}`;

/** The category prefix of a reason, or "other". */
export function reasonCategory(reason: string): RejectionCategory | "other" {
  const i = reason.indexOf(":");
  const head = i > 0 ? reason.slice(0, i) : "";
  return (REJECTION_CATEGORIES as readonly string[]).includes(head) ? (head as RejectionCategory) : "other";
}

/**
 * Budget rejection. The budget is a limit on the ESTIMATED list-price total at
 * planning time; the wording never says the provider will stop at it.
 */
export function budgetReason(estimatedUsd: number, budgetUsd: number): string {
  return `budget: estimated $${money(estimatedUsd)}/month exceeds the $${money(budgetUsd)} budget by $${money(estimatedUsd - budgetUsd)}`;
}

const BUDGET_RE = /^budget: estimated \$(-?\d+(?:\.\d+)?)\/month exceeds the \$(-?\d+(?:\.\d+)?) budget by \$(-?\d+(?:\.\d+)?)$/;

export function parseBudgetReason(reason: string): { estimatedUsd: number; budgetUsd: number; overUsd: number } | undefined {
  const m = BUDGET_RE.exec(reason);
  return m ? { estimatedUsd: Number(m[1]), budgetUsd: Number(m[2]), overUsd: Number(m[3]) } : undefined;
}
