/**
 * Additive ledger read metadata, without changing the operation/proposal contracts.
 * Round zero is the proposal; later rounds review the write-once plan digest.
 * Plan review comes only from tenant-scoped, non-simulated planning evidence.
 * This projection contains attribute names, never attribute or output values.
 */
import { z } from "zod";
import type { OperationRecord, Sql } from "@/lib/controlplane/types";
import type { PlanView } from "@/lib/tofu/plan";
import { redactOutput } from "@/lib/tofu/redact";

const factText = z.string().max(500);
const text = factText.transform((s) => redactOutput(s).replace(/[\u0000-\u001f\u007f]/g, " "));
const count = z.number().int().min(0).max(1_000_000);
export const ReviewFactsSchema = z.object({
  create: count, update: count, delete: count, replace: count, destroysData: z.boolean(),
  destroyedStatefulAddresses: z.array(factText).max(10_000), regions: z.array(factText).max(1000),
  publicDatabases: z.array(factText).max(10_000),
  openIngress: z.array(z.object({ address: factText, port: factText, cidr: factText })).max(10_000),
  wildcardIam: z.array(factText).max(10_000), identityChanges: z.array(factText).max(10_000),
  firewallChanges: z.array(factText).max(10_000), dnsChanges: z.array(factText).max(10_000),
  unresolved: z.array(factText).max(10_000).optional(),
}).strict();
const action = z.enum(["create", "update", "delete", "replace", "no-op", "read"]);
const ViewSchema = z.object({
  planDigest: z.string().regex(/^[a-f0-9]{64}$/), tofuVersion: text, empty: z.boolean(),
  summary: z.object({ create: count, update: count, delete: count, replace: count, noop: count }),
  resources: z.array(z.object({
    address: text, nodeAddress: text.optional(), type: text, action, destroysData: z.boolean(),
    changes: z.array(z.object({ path: text, forcesReplacement: z.boolean(), sensitive: z.boolean().optional() })).max(50),
    omittedChanges: count,
  })).max(200),
  outputs: z.array(z.object({ name: text, action, sensitive: z.boolean() })).max(200),
  diagnostics: z.array(z.object({ severity: z.enum(["error", "warning"]), summary: text })).max(10),
  truncated: z.boolean(), untrustedValues: z.literal(true),
});
const CostSchema = z.object({ deltaUsdMonthly: z.number().finite().optional(), projectedMonthlyUsd: z.number().finite().optional(), catalogVersion: text.optional() });

export interface OperationPlanReview {
  planDigest: string;
  view: PlanView;
  facts: z.infer<typeof ReviewFactsSchema>;
  cost: z.infer<typeof CostSchema>;
}
export interface ApprovalRoundMetadata { approvalRound: number }
export type ReviewedOperation = OperationRecord & ApprovalRoundMetadata & { planReview?: OperationPlanReview };

/** Missing round metadata is legacy proposal round zero, never a plan approval. */
export function approvalRoundOf(record: object): number {
  const n = (record as Partial<ApprovalRoundMetadata>).approvalRound;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
}

export function operationPlanReview(record: OperationRecord): OperationPlanReview | undefined {
  const review = (record as Partial<ReviewedOperation>).planReview;
  // Page loaders may further bound stored records. Refuse a malformed or
  // truncated shape rather than enabling approval for an unreadable artifact.
  return review && record.planDigest ? projectPlanReview({ ...review, stage: "plan" }, record.planDigest) : undefined;
}

export function projectPlanReview(summary: Record<string, unknown>, planDigest: string): OperationPlanReview | undefined {
  if (summary.stage !== "plan" || summary.planDigest !== planDigest) return undefined;
  const view = ViewSchema.safeParse(summary.view);
  const facts = ReviewFactsSchema.safeParse(summary.facts);
  if (!view.success || !facts.success || view.data.planDigest !== planDigest) return undefined;
  const cost = CostSchema.safeParse(summary.cost);
  const review = { planDigest, view: view.data as PlanView, facts: facts.data, cost: cost.success ? cost.data : {} };
  return Buffer.byteLength(JSON.stringify(review)) <= 60_000 ? review : undefined;
}

/** Read only the original gated plan, never a later final-plan artifact. */
export async function withPlanReview(sql: Sql, op: ReviewedOperation): Promise<ReviewedOperation> {
  if (!op.planDigest) return op;
  const rows = await sql.query<{ summary: Record<string, unknown> }>(
    `select summary from platform.evidence where workspace_id = $1 and operation_id = $2
       and kind = 'tofu_plan' and digest = $3 and simulated = false and summary->>'stage' = 'plan'
       order by created_at, id limit 1`, [op.workspaceId, op.id, op.planDigest]);
  const review = rows[0] ? projectPlanReview(rows[0].summary, op.planDigest) : undefined;
  return review ? { ...op, planReview: review } : op;
}
