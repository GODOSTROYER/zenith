/**
 * Platform components: presentational, fully typed views of the control plane
 * (operations, approvals, plans, policy, resource state, drift, incidents, cost,
 * autonomy, cloud connections). They fetch nothing: data and callbacks arrive as
 * props, and every surface has loading, empty and error states.
 *
 * Client-safe by construction: contracts are `import type` only, and nothing here
 * reaches `node:` APIs, the control-plane digest, the resources barrel, the tofu
 * runner, the policy engine or the placement price book. Import individual files
 * in app code where bundle isolation matters; this barrel documents the surface.
 */
export { SurfaceGate, type AsyncSurfaceProps, type SurfaceGateProps } from "./async-gate";
export { Disclosure, DigestValue, Fact, RiskLabel, ScopeBreadcrumb, type PlatformRisk, type ScopeNames } from "./badges";

export { OperationStatusBadge, type OperationStatusBadgeProps } from "./operation-status";
export { OperationTimeline, type OperationTimelineProps } from "./operation-timeline";
export { describeEvent, groupByCorrelation, safeDataEntries, type EventDescription, type EventGroup } from "./event-sentences";

export { ApprovalCard, type ApprovalCardProps, type ApprovalDecisionInput } from "./approval-card";
export {
  approvalEligibility,
  approvalProgress,
  requesterId,
  type ApprovalEligibility,
  type ApprovalProgress,
  type ApprovalViewer,
  type IneligibleReason,
} from "./approval-eligibility";

export { PlanChangesTable, PlanSummaryChips, type PlanChangesTableProps } from "./plan-changes-table";
export { describePlanValue, groupByNode, type PlanChange, type ShownValue } from "./plan-values";

export { PolicyDecisionPanel, PolicyReasonList, type PolicyDecisionPanelProps } from "./policy-decision-panel";
export { describeApprovalRequirement, describeConstraints, OUTCOME_PRESENTATION } from "./policy-language";

export { ResourceStateTable, type ResourceStateTableProps } from "./resource-state-table";
export { ResourceStateDetail, type ResourceStateDetailProps } from "./resource-state-detail";
export { compareAttributes, describeSignal, notObservedText, type AttributeComparison, type ResourceStateRow } from "./resource-state-model";
export { HealthBadge, PresenceBadge, ReadMeta } from "./state-badges";

export { DriftList, repairSentence, type DriftListProps } from "./drift-list";

export { InvestigationView, type InvestigationViewProps } from "./investigation-view";
export { INVESTIGATION_NOTE, sortHypotheses } from "./investigation-model";

export { CostEstimateCard, CostEstimateBody, type CostEstimateCardProps } from "./cost-estimate-card";
export { PlacementComparison, candidateLabel, type ComparedCandidate, type PlacementComparisonProps } from "./placement-comparison";
export {
  PRICE_EVIDENCE,
  evidenceFor,
  isWeakLine,
  summarizeWeakEvidence,
  type PriceVerification,
  type PricedCostEstimate,
  type PricedCostLine,
} from "./price-evidence";

export { AutonomyControl, adminOnlyReason, type AutonomyControlProps } from "./autonomy-control";
export { AUTONOMY_LEVELS, type AutonomyLevelInfo } from "./autonomy-levels";

export {
  AwsConnectionSetup,
  type AwsConnectionInput,
  type AwsConnectionSetupProps,
  type AwsTrust,
  type AwsVerifyResult,
} from "./aws-connection-setup";
export { CFN_TEMPLATE_PATH, looksLikeAccessKey, validateAwsForm, type AwsFormValues } from "./aws-connection-validation";
