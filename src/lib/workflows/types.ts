/**
 * Durable workflow contract (spec §16, ADR-0009).
 *
 * Temporal owns long-running orchestration for real infrastructure: deploys,
 * applies, day-two operations, remediation, reconciliation. Workflow code is
 * deterministic and holds no I/O; every side effect is an activity. Model
 * calls, if any, happen only inside activities.
 *
 * Payload rule: workflow inputs, activity inputs and activity results carry
 * ids, digests, counts and short redacted summaries — never credentials,
 * secret values, plan files or provider responses. Temporal history is
 * durable and replicated; treat it as a log someone else can read.
 *
 * Idempotency: workflow id = `op-<operationId>` (Temporal refuses a second
 * start with the same id). Every mutating activity is idempotent on
 * (operationId, step) and checks its fence token before and after the
 * external call. A lost lease raises `LeaseLost`, which is non-retryable and
 * finalizes the operation as `uncertain` unless the step can prove it did
 * not act.
 */

export const TASK_QUEUE = "zenith-execution";

export const WORKFLOW_ID = (operationId: string) => `op-${operationId}`;

export interface DeployWorkflowInput {
  operationId: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  /** product-store revision to deploy */
  revisionId: string;
  /** product-store deployment record the UI follows (projection) */
  deploymentId: string;
  connectionId: string;
  /** set when policy already allowed without approval */
  preApproved: boolean;
  /** skip build when the manifest pins images */
  build: boolean;
}

export interface DayTwoWorkflowInput {
  operationId: string;
  workspaceId: string;
  environmentId: string;
  capability: string;
}

export interface RemediationWorkflowInput {
  operationId: string;
  workspaceId: string;
  environmentId: string;
  incidentId: string;
}

export interface ReconcileWorkflowInput {
  workspaceId: string;
  environmentId: string;
  /** never repair automatically when false (observe + report only) */
  allowAutoRepair: boolean;
}

/** Signals the control plane sends to a waiting workflow. */
export const SIGNALS = {
  /** an approval row was written; the workflow re-verifies it via an activity */
  approvalRecorded: "approvalRecorded",
  cancel: "cancel",
} as const;

export const QUERIES = {
  progress: "progress",
} as const;

export type StepName =
  | "validate"
  | "lease"
  | "credentials"
  | "plan"
  | "policy"
  | "approval"
  | "final_plan"
  | "apply_network"
  | "apply_data"
  | "apply_infrastructure"
  | "build"
  | "publish"
  | "deploy"
  | "secrets"
  | "ingress"
  | "dns_tls"
  | "migrate"
  | "verify_infrastructure"
  | "verify_application"
  | "observe"
  | "finalize"
  | "release";

export interface StepProgress {
  step: StepName;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface WorkflowProgress {
  operationId: string;
  steps: StepProgress[];
  status: "running" | "awaiting_approval" | "succeeded" | "failed" | "uncertain" | "cancelled";
}

/* ------------------------------- activities ------------------------------- */

export interface LeaseRef {
  scope: string;
  holder: string;
  fenceToken: number;
}

export interface PlanSummary {
  planDigest: string;
  create: number;
  update: number;
  delete: number;
  replace: number;
  destroysData: boolean;
  costDeltaUsdMonthly?: number;
  empty: boolean;
}

export interface PolicyStepResult {
  outcome: "allow" | "deny" | "require_approval";
  decisionId: string;
  reasons: string[];
}

export interface VerifyStepResult {
  status: "passed" | "failed" | "unknown";
  checks: number;
  failed: number;
  /** public URL verified, when there is one */
  url?: string;
  evidenceId?: string;
}

/**
 * Every activity the workflows call. Implementations live in the execution
 * worker (`src/lib/workflows/activities/**`) and are the ONLY place drivers,
 * OpenTofu, the credential broker and the control store are touched.
 */
export interface ExecutionActivities {
  recordStep(input: { operationId: string; deploymentId?: string; step: StepName; status: StepProgress["status"]; detail?: string }): Promise<void>;
  markOperation(input: { operationId: string; status: "running" | "awaiting_approval" | "succeeded" | "failed" | "uncertain" | "cancelled"; error?: string }): Promise<void>;

  acquireLease(input: { operationId: string; scope: string; ttlMs: number }): Promise<LeaseRef>;
  renewLease(input: { lease: LeaseRef; ttlMs: number }): Promise<void>;
  releaseLease(input: { lease: LeaseRef }): Promise<void>;

  validateDesiredState(input: { operationId: string }): Promise<{ graphDigest: string; nodes: number; problems: string[] }>;
  planInfrastructure(input: { operationId: string; lease: LeaseRef }): Promise<PlanSummary>;
  evaluatePolicy(input: { operationId: string; planDigest?: string }): Promise<PolicyStepResult>;
  checkApproval(input: { operationId: string }): Promise<{ approved: boolean; rejected: boolean; approvalId?: string }>;
  /** re-plan and compare; throws a non-retryable `plan_changed` when it moved */
  finalPlan(input: { operationId: string; approvedPlanDigest: string; lease: LeaseRef }): Promise<PlanSummary>;
  /** heartbeats; renews the lease while tofu runs */
  applyInfrastructure(input: { operationId: string; planDigest: string; lease: LeaseRef }): Promise<{ applied: number; outputsDigest: string }>;
  buildArtifacts(input: { operationId: string; lease: LeaseRef }): Promise<{ images: { service: string; imageUri: string; digest: string }[] }>;
  deployWorkloads(input: { operationId: string; lease: LeaseRef; images: { service: string; imageUri: string; digest: string }[] }): Promise<{ services: number }>;
  runMigrations(input: { operationId: string; lease: LeaseRef }): Promise<{ ran: boolean; detail: string }>;
  verifyInfrastructure(input: { operationId: string }): Promise<VerifyStepResult>;
  verifyApplication(input: { operationId: string }): Promise<VerifyStepResult>;
  observeEnvironment(input: { operationId: string }): Promise<{ drift: number; unknown: number }>;
  executeCapability(input: { operationId: string; lease: LeaseRef }): Promise<{ ok: boolean; summary: string }>;
}
