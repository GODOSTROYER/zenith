/**
 * What a plan leaves behind in the evidence ledger — and what it must not.
 *
 * Stored (kind `tofu_plan`): the plan's digests, resource counts, the policy
 * facts extracted from it, the cost estimate, and the model-safe `planView`
 * (addresses, actions, changed attribute PATHS, and the values of non-sensitive
 * known scalars ≤ 200 characters; sensitive and secret-looking paths are
 * reduced to "this path changed").
 *
 * Never stored or returned: the binary plan file (it stays in `planDir`, mode
 * 0600, and is removed when the apply finishes), the raw `show -json` document,
 * sensitive values, the HMAC fingerprints that make sensitive changes move the
 * digest, or any output value. `planView` is the ONLY projection of the plan
 * that leaves the worker, and it is bounded so a large plan cannot overflow the
 * ledger's row limit: detail is dropped in stages (values, then change lists,
 * then resources) and `truncated` says so.
 *
 * The policy facts are kept here, in the row planning wrote, so that
 * `evaluatePolicy` — a separate activity that may run on another worker — uses
 * facts derived from OUR normalized plan and nothing a client supplied.
 */
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import type { PlanFacts } from "@/lib/policy/types";
import { planView, type PlanView } from "@/lib/tofu/plan";
import { assertPlanViewOnly } from "@/lib/security/raw-plan-material";
import type { NormalizedPlan } from "@/lib/tofu/types";
import type { PlanSummary } from "@/lib/workflows/types";
import { safeText } from "./text";
import { repairBindingDigest, type EcsReplicaRepairBindingV1 } from "./ecs-replica-repair-binding";

const MAX_VIEW_BYTES = 40_000;
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/** The plan view, bounded to fit a ledger row. */
export function boundedPlanView(plan: NormalizedPlan, maxBytes = MAX_VIEW_BYTES): PlanView {
  const view = planView(plan);
  if (bytes(view) <= maxBytes) return view;

  const withoutValues: PlanView = {
    ...view,
    truncated: true,
    resources: view.resources.map((r) => ({ ...r, changes: r.changes.map((c) => ({ path: c.path, forcesReplacement: c.forcesReplacement })) })),
  };
  if (bytes(withoutValues) <= maxBytes) return withoutValues;

  const withoutChanges: PlanView = {
    ...withoutValues,
    resources: withoutValues.resources.map((r) => ({ ...r, omittedChanges: r.changes.length + r.omittedChanges, changes: [] })),
  };
  let shown = withoutChanges.resources;
  while (shown.length > 0 && bytes({ ...withoutChanges, resources: shown }) > maxBytes) shown = shown.slice(0, Math.floor(shown.length / 2));
  return { ...withoutChanges, resources: shown };
}

const count = z.number().int().min(0).max(1_000_000);
const text = z.string().max(500);
const FactsSchema = z
  .object({
    create: count,
    update: count,
    delete: count,
    replace: count,
    destroysData: z.boolean(),
    destroyedStatefulAddresses: z.array(text).max(10_000),
    statefulDeletes: z.array(text).max(10_000).optional(),
    dnsDeletes: z.array(text).max(10_000).optional(),
    regions: z.array(text).max(1000),
    publicDatabases: z.array(text).max(10_000),
    openIngress: z.array(z.object({ address: text, port: text, cidr: text })).max(10_000),
    wildcardIam: z.array(text).max(10_000),
    identityChanges: z.array(text).max(10_000),
    firewallChanges: z.array(text).max(10_000),
    dnsChanges: z.array(text).max(10_000),
    unresolved: z.array(text).max(10_000).optional(),
  })
  .strict();

const CostSchema = z.object({ deltaUsdMonthly: z.number().finite().optional(), projectedMonthlyUsd: z.number().finite().optional(), catalogVersion: text.optional() }).strict();

export interface PlanCost {
  deltaUsdMonthly?: number;
  projectedMonthlyUsd?: number;
  catalogVersion?: string;
}

/** Read the facts and cost back out of a plan-evidence summary, refusing anything malformed. */
export function readPlanEvidence(summary: Record<string, unknown>): { facts: PlanFacts; cost: PlanCost } | undefined {
  const facts = FactsSchema.safeParse(summary.facts);
  if (!facts.success) return undefined;
  const cost = CostSchema.safeParse(summary.cost ?? {});
  return { facts: facts.data as PlanFacts, cost: cost.success ? cost.data : {} };
}

export interface PlanEvidenceInput {
  plan: NormalizedPlan;
  facts: PlanFacts;
  cost: PlanCost;
  graphDigest: string;
  stage: "plan" | "final_plan";
  /** final_plan only: the digest that was approved */
  approvedDigest?: string;
  repairBinding?: EcsReplicaRepairBindingV1;
  approvedSources?: readonly import("./source-snapshot").ApprovedSourceSnapshot[];
}

export function planEvidence(input: PlanEvidenceInput): { digest: string; key: string; summary: Record<string, unknown> } {
  const { plan } = input;
  const approvedSources=input.approvedSources?.slice(0,64).map(s=>({service:s.serviceAddress,commit:s.commitSha,dockerfileDigest:s.dockerfileDigest,recipeDigest:s.recipeDigest,archiveDigest:s.archiveDigest,archiveFormat:s.archiveFormat}));
  const view=boundedPlanView(plan,approvedSources?.length?MAX_VIEW_BYTES-bytes(approvedSources)-256:MAX_VIEW_BYTES);
  const summary: Record<string, unknown> = {
    stage: input.stage,
    planDigest: plan.planDigest,
    configDigest: plan.configDigest,
    lockDigest: plan.lockDigest,
    tofuVersion: plan.tofuVersion,
    graphDigest: input.graphDigest,
    counts: plan.summary,
    empty: plan.empty,
    destroysData: input.facts.destroysData || plan.resourceChanges.some((r) => r.destroysData && (r.action === "delete" || r.action === "replace")),
    facts: input.facts,
    cost: input.cost,
    diagnostics: plan.diagnostics.slice(0, 10).map((d) => ({ severity: d.severity, summary: safeText(d.summary, 300) })),
    ...(plan.executableSourceDigest ? { executableSourceDigest: plan.executableSourceDigest } : {}),
    view: { ...view, ...(approvedSources?.length ? { approvedSources, ...(input.approvedSources!.length>64?{approvedSourcesTruncated:true,approvedSourcesOmitted:input.approvedSources!.length-64}:{}) } : {}) },
    ...(input.repairBinding ? { repairBinding: input.repairBinding, repairBindingDigest: repairBindingDigest(input.repairBinding) } : {}),
    ...(input.stage === "final_plan" && input.approvedDigest ? { approvedDigest: input.approvedDigest, matchesApproved: input.approvedDigest === plan.planDigest } : {}),
  };
  // PROD-DUR-05: evidence is the sanitized PlanView side only; raw custody material can never be persisted here.
  assertPlanViewOnly(summary);
  return { digest: plan.planDigest, key: `${input.stage}:${plan.planDigest}`, summary };
}

export function toPlanSummary(plan: NormalizedPlan, facts: PlanFacts, cost: PlanCost): PlanSummary {
  return {
    planDigest: plan.planDigest,
    create: plan.summary.create,
    update: plan.summary.update,
    delete: plan.summary.delete,
    replace: plan.summary.replace,
    destroysData: facts.destroysData || plan.resourceChanges.some((r) => r.destroysData && (r.action === "delete" || r.action === "replace")),
    ...(cost.deltaUsdMonthly !== undefined ? { costDeltaUsdMonthly: cost.deltaUsdMonthly } : {}),
    empty: plan.empty,
  };
}

/** Digest of a set of non-sensitive tofu outputs (`{ name: { sensitive, type, value? } }`); sensitive entries carry no value. */
export const outputsDigest = (outputs: Record<string, unknown>): string => digest(outputs);
