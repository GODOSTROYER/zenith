/** An authorized operation, its recorded evidence and its browser-only decision controls. */
import { OperationTimeline } from "@/components/platform/operation-timeline";
import { PlanChangesTable } from "@/components/platform/plan-changes-table";
import { PolicyDecisionPanel } from "@/components/platform/policy-decision-panel";
import { CostEstimateCard } from "@/components/platform/cost-estimate-card";
import { Callout } from "@/components/ui/callout";
import { loadOperation } from "../../_lib/loaders";
import { EvidenceNote, PageState } from "../../_components/page-state";
import { OperationActions } from "./operation-actions";
import { operationPlanReview } from "@/lib/controlplane/db/repos/operation-review";
export const dynamic = "force-dynamic";
export default async function OperationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadOperation(id);
  if ("error" in result) return <PageState {...result} />;
  const { data, context } = result;
  const review = operationPlanReview(data.operation);
  return <div className="space-y-5"><h1 className="app-page-title">Operation details</h1><EvidenceNote />
    <OperationActions key={`${data.operation.updatedAt}:${data.approvals.map((a) => a.id).join(",")}`} operation={data.operation} decision={data.decision} approvals={data.approvals} viewer={{ id: context.principal.id, role: context.role, reviewedDigest: data.operation.proposalDigest }} workspaceId={context.workspaceId} plan={review?.view} planCostDeltaUsd={review ? review.cost.deltaUsdMonthly ?? null : undefined} />
    <OperationTimeline events={data.events} operation={data.operation} />
    {data.timelineTruncated && <Callout tone="info">Showing the first 500 recorded events. More events may exist.</Callout>}
    <PolicyDecisionPanel decision={data.decision} />
    <PlanChangesTable plan={review?.view} />
    {data.operation.planDigest && !review && <Callout tone="info">This operation is bound to plan digest <code>{data.operation.planDigest}</code>. Its recorded plan is unavailable for review; approval is disabled until the planning evidence is restored.</Callout>}
    <CostEstimateCard estimate={data.estimate} />
  </div>;
}
