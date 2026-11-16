/**
 * One projection for the privileged operator journey (PROD-UX-01).
 *
 * The same four questions are answered for every long-running change, whichever
 * authority records it: where is it, can it still be stopped, is the outcome
 * known, and what does a person do next. Three record shapes feed the one view:
 *
 *   platform_operation  `platform.operations` (the broker's operation, status incl. `uncertain`)
 *   legacy_deployment   the product-store `Deployment` (in-process engine, or a workflow
 *                       projection that points at a platform operation)
 *   runbook_run         a signed-runbook run (`machine_runbook_runs`) with step custody
 *
 * Pure and dependency-light on purpose: the server pages render it for the first
 * paint and the browser re-runs the same function on every poll, so a legacy and a
 * platform record can never describe the same state in two vocabularies. Nothing here
 * decides authority. Approval, cancellation and execution stay with the API routes;
 * `cancel.available` only says whether to OFFER the control, and the route re-checks.
 *
 * Honesty rules: `uncertain` is its own stage and is never folded into failed or
 * succeeded; "succeeded" is the control plane's bookkeeping, not an observation;
 * nothing says "verified".
 */
import type { OperationStatus } from "@/lib/controlplane/types";
import type { DeploymentStatus, DeploymentStep } from "@/lib/domain/types";

export type JourneySource = "platform_operation" | "legacy_deployment" | "runbook_run";

export type JourneyStage =
  | "proposed"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "rolling_back"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "rolled_back"
  | "cancelled"
  | "rejected"
  | "denied"
  | "expired";

export type JourneyStepState = "pending" | "running" | "done" | "failed" | "skipped" | "uncertain";
export type JourneyTone = "neutral" | "info" | "warn" | "ok" | "err";

export interface JourneyStep {
  id: string;
  title: string;
  state: JourneyStepState;
  /** short, already-safe text; never a provider message */
  detail?: string;
}

export interface JourneyCancel {
  /** whether the control is offered; the route is still the authority */
  available: boolean;
  /** printed beside a disabled control */
  reason?: string;
}

export interface JourneyView {
  source: JourneySource;
  id: string;
  stage: JourneyStage;
  label: string;
  /** one calm sentence for the live region and the heading */
  sentence: string;
  tone: JourneyTone;
  terminal: boolean;
  /** false only for `uncertain`: the control plane does not know the outcome */
  outcomeKnown: boolean;
  steps: JourneyStep[];
  cancel: JourneyCancel;
  /** what a person does now; always present for failed and uncertain */
  nextSteps: string[];
  /** the digest an approver must have reviewed, when the record is bound to one */
  reviewDigest?: string;
}

const STAGE_LABEL: Record<JourneyStage, string> = {
  proposed: "Proposed",
  awaiting_approval: "Awaiting approval",
  queued: "Queued",
  running: "Running",
  rolling_back: "Rolling back",
  succeeded: "Succeeded",
  failed: "Failed",
  uncertain: "Outcome uncertain",
  rolled_back: "Rolled back",
  cancelled: "Cancelled",
  rejected: "Rejected",
  denied: "Blocked by policy",
  expired: "Expired",
};

const STAGE_SENTENCE: Record<JourneyStage, string> = {
  proposed: "Recorded and being checked against policy. Nothing has changed.",
  awaiting_approval: "Waiting for a person to approve this exact plan. Nothing has changed.",
  queued: "Approved and queued. Execution has not started.",
  running: "In progress. Changes are being made.",
  rolling_back: "Rolling back to the previous revision.",
  succeeded: "Finished without an error. Zenith confirms the result the next time it observes the real state.",
  failed: "Stopped with an error. Some changes may have been made before it stopped.",
  uncertain: "Zenith cannot prove whether this change happened. It will not guess and will not retry on its own.",
  rolled_back: "Rolled back. The previous revision is serving again.",
  cancelled: "Cancelled before it ran to completion.",
  rejected: "Rejected by a person. Nothing was changed.",
  denied: "Policy does not allow this change. Nothing was changed.",
  expired: "The proposal or its approval expired before it ran. Nothing was changed.",
};

const STAGE_TONE: Record<JourneyStage, JourneyTone> = {
  proposed: "neutral",
  awaiting_approval: "warn",
  queued: "info",
  running: "info",
  rolling_back: "warn",
  succeeded: "ok",
  failed: "err",
  uncertain: "warn",
  rolled_back: "neutral",
  cancelled: "neutral",
  rejected: "neutral",
  denied: "err",
  expired: "neutral",
};

const TERMINAL: ReadonlySet<JourneyStage> = new Set(["succeeded", "failed", "uncertain", "rolled_back", "cancelled", "rejected", "denied", "expired"]);

/** Next steps are explicit for the two states people most often get wrong. */
export function nextStepsFor(stage: JourneyStage, source: JourneySource): string[] {
  switch (stage) {
    case "uncertain":
      return source === "runbook_run"
        ? [
            "Do not re-run this runbook yet: a step may already have run on a target.",
            "Open the target machine or its resource state and check what actually changed.",
            "When you know the real state, request a new run for exactly the targets that still need it.",
          ]
        : [
            "Do not retry yet: the change may already have been applied.",
            "Open the resource state and wait for the next reconciliation, or check the cloud console directly.",
            "When you know the real state, propose a new operation for whatever is still missing.",
          ];
    case "failed":
      return [
        "Read the timeline for the step that stopped.",
        "Check the resource state: changes made before the error are not undone automatically.",
        "Fix the cause, then propose a new change. A failed operation is not retried for you.",
      ];
    case "awaiting_approval":
      return ["Review the exact changes and the digest below, then approve or reject."];
    case "denied":
      return ["Ask an admin to review the workspace policy, or propose a change policy allows."];
    case "expired":
      return ["Ask for a new proposal. An expired approval cannot be revived."];
    case "succeeded":
      return ["Check the resource state after the next observation to confirm the result."];
    default:
      return [];
  }
}

function make(source: JourneySource, id: string, stage: JourneyStage, extra: Partial<Pick<JourneyView, "steps" | "cancel" | "reviewDigest" | "nextSteps">> = {}): JourneyView {
  return {
    source,
    id,
    stage,
    label: STAGE_LABEL[stage],
    sentence: STAGE_SENTENCE[stage],
    tone: STAGE_TONE[stage],
    terminal: TERMINAL.has(stage),
    outcomeKnown: stage !== "uncertain",
    steps: extra.steps ?? [],
    cancel: extra.cancel ?? { available: false },
    nextSteps: extra.nextSteps ?? nextStepsFor(stage, source),
    ...(extra.reviewDigest ? { reviewDigest: extra.reviewDigest } : {}),
  };
}

/* ------------------------------ platform operation ------------------------------ */

const OPERATION_STAGE: Record<OperationStatus, JourneyStage> = {
  proposed: "proposed",
  awaiting_approval: "awaiting_approval",
  approved: "queued",
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  uncertain: "uncertain",
  cancelled: "cancelled",
  rejected: "rejected",
  denied: "denied",
  expired: "expired",
};

/** Statuses the cancel route accepts: nothing has started yet. */
export const CANCELLABLE_OPERATION_STATUSES: readonly OperationStatus[] = ["proposed", "awaiting_approval", "approved", "queued"];

/** The part of an external-effect ledger row the journey needs (see `@/lib/effects/view`). */
export interface EffectLike {
  effectId: string;
  state: "pending" | "accepted" | "uncertain" | "conflict" | "confirmed" | "tombstoned";
  familyLabel: string;
}

export interface PlatformOperationLike {
  id: string;
  status: OperationStatus;
  planDigest?: string;
  proposalDigest?: string;
  /** Ledger effects of this operation. An unresolved one makes the outcome unknown whatever the status says. */
  effects?: readonly EffectLike[];
}

/** PROD-DUR-07/08: effects that leave the outcome unknown, shown as `uncertain` rather than as a failure. */
export function unresolvedEffects(effects: readonly EffectLike[] | undefined): EffectLike[] {
  return (effects ?? []).filter((e) => e.state === "uncertain" || e.state === "conflict");
}

export function effectNextSteps(effects: readonly EffectLike[]): string[] {
  if (effects.length === 0) return [];
  const names = [...new Set(effects.map((e) => e.familyLabel.toLowerCase()))].join(", ");
  return [
    `Do not retry: Zenith will not repeat the ${names} on its own. The provider may already have done it.`,
    "Run readback on each effect below. It reads the provider independently and changes nothing.",
    "Review the evidence. An admin in the browser can then confirm it happened, or confirm it did not (only after the original lease is gone and the settle window has passed).",
    "After a resolution, propose a new operation for whatever is still missing.",
  ];
}

export function projectPlatformOperation(op: PlatformOperationLike): JourneyView {
  const recorded = OPERATION_STAGE[op.status] ?? "proposed";
  const open = unresolvedEffects(op.effects);
  // A provider call whose outcome is unknown outranks a recorded failure or success: the operation cannot be called either.
  const stage: JourneyStage = open.length > 0 && (recorded === "failed" || recorded === "succeeded" || recorded === "running" || recorded === "uncertain") ? "uncertain" : recorded;
  const ended = TERMINAL.has(stage);
  const neverRan = stage === "rejected" || stage === "denied" || stage === "expired" || stage === "cancelled";
  const approval: JourneyStepState = stage === "awaiting_approval" ? "running" : stage === "proposed" ? "pending" : stage === "rejected" || stage === "denied" || stage === "expired" ? "failed" : "done";
  const execution: JourneyStepState = stage === "running" ? "running" : neverRan ? "skipped" : stage === "failed" ? "failed" : stage === "uncertain" ? "uncertain" : stage === "succeeded" ? "done" : "pending";
  const outcome: JourneyStepState = stage === "succeeded" ? "done" : stage === "failed" ? "failed" : stage === "uncertain" ? "uncertain" : ended ? "skipped" : "pending";
  const steps: JourneyStep[] = [
    { id: "proposed", title: "Proposal recorded", state: "done" },
    { id: "approval", title: "Approval", state: approval, detail: stage === "rejected" ? "Rejected by a person" : stage === "denied" ? "Blocked by policy" : stage === "expired" ? "Expired" : undefined },
    { id: "execution", title: "Execution", state: execution },
    { id: "outcome", title: "Outcome", state: outcome, detail: stage === "uncertain" ? "Not known" : stage === "succeeded" ? "Recorded, confirmed at next observation" : undefined },
  ];
  if (open.length > 0 && stage === "uncertain") steps.push({ id: "effects", title: "External changes", state: "uncertain", detail: `${open.length} need review` });
  const cancellable = CANCELLABLE_OPERATION_STATUSES.includes(op.status);
  return make("platform_operation", op.id, stage, {
    steps,
    ...(open.length > 0 && stage === "uncertain" ? { nextSteps: effectNextSteps(open) } : {}),
    reviewDigest: op.planDigest ?? op.proposalDigest,
    cancel: cancellable
      ? { available: true }
      : { available: false, reason: stage === "running" ? "Execution has started and cannot be cancelled here. Zenith will not guess at a partial stop." : ended ? "This operation has finished." : undefined },
  });
}

/* ------------------------------- legacy deployment ------------------------------- */

const LEGACY_STAGE: Record<DeploymentStatus, JourneyStage> = {
  planning: "proposed",
  awaiting_approval: "awaiting_approval",
  applying: "running",
  verifying: "running",
  succeeded: "succeeded",
  failed: "failed",
  rolling_back: "rolling_back",
  rolled_back: "rolled_back",
  cancelled: "cancelled",
};

const LEGACY_STEP_STATE: Record<DeploymentStep["status"], JourneyStepState> = { pending: "pending", running: "running", done: "done", failed: "failed", skipped: "skipped" };

export interface LegacyDeploymentLike {
  id: string;
  status: DeploymentStatus;
  steps: readonly Pick<DeploymentStep, "id" | "seq" | "title" | "status" | "error">[];
  executor?: "engine" | "workflow";
  operationId?: string;
}

/**
 * A workflow-executed legacy deployment is a projection of a platform operation: it must never
 * look different from it. When the linked operation is supplied, ITS status wins (the legacy
 * record can lag the control plane), and uncertainty is carried over rather than shown as a failure.
 */
export function projectLegacyDeployment(dep: LegacyDeploymentLike, linked?: PlatformOperationLike): JourneyView {
  const base = linked && dep.executor === "workflow" ? projectPlatformOperation(linked) : undefined;
  const stage = base?.stage ?? LEGACY_STAGE[dep.status] ?? "proposed";
  const steps: JourneyStep[] = [...dep.steps]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => ({ id: s.id, title: s.title, state: stage === "uncertain" && s.status === "running" ? "uncertain" : LEGACY_STEP_STATE[s.status], ...(s.status === "failed" ? { detail: "Stopped here. See the deployment log." } : {}) }));
  const cancellable = base ? base.cancel : dep.executor === "workflow"
    ? { available: false, reason: "Open the linked platform operation to cancel." }
    : { available: !TERMINAL.has(stage), reason: TERMINAL.has(stage) ? "This deployment has finished." : undefined };
  return make("legacy_deployment", dep.id, stage, { steps: steps.length ? steps : base?.steps, cancel: cancellable, reviewDigest: base?.reviewDigest, ...(base && base.stage === "uncertain" ? { nextSteps: base.nextSteps } : {}) });
}

/* ---------------------------------- runbook run ---------------------------------- */

export interface RunbookRunLike {
  id: string;
  status: "pending_approval" | "approved" | "running" | "succeeded" | "failed" | "cancelled" | "expired" | "uncertain";
  cancelRequestedAt?: string;
  bindingDigest: string;
}
export interface RunbookStepLike {
  targetIndex: number;
  stepId: string;
  status: "started" | "succeeded" | "failed" | "uncertain" | "skipped";
  errorCode?: string;
}

const RUNBOOK_STAGE: Record<RunbookRunLike["status"], JourneyStage> = {
  pending_approval: "awaiting_approval",
  approved: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
  uncertain: "uncertain",
};
const RUNBOOK_STEP_STATE: Record<RunbookStepLike["status"], JourneyStepState> = { started: "running", succeeded: "done", failed: "failed", uncertain: "uncertain", skipped: "skipped" };

export function projectRunbookRun(run: RunbookRunLike, steps: readonly RunbookStepLike[], titles: Readonly<Record<string, string>> = {}): JourneyView {
  const stage = RUNBOOK_STAGE[run.status] ?? "proposed";
  // A step whose outcome is unknown makes the run uncertain even if a later record says otherwise.
  const anyUncertain = steps.some((s) => s.status === "uncertain");
  const effective: JourneyStage = anyUncertain && stage === "failed" ? "uncertain" : stage;
  const view = make("runbook_run", run.id, effective, {
    reviewDigest: run.bindingDigest,
    steps: [...steps]
      .sort((a, b) => a.targetIndex - b.targetIndex || a.stepId.localeCompare(b.stepId))
      .map((s) => ({ id: `${s.targetIndex}:${s.stepId}`, title: `Target ${s.targetIndex + 1}: ${titles[s.stepId] ?? s.stepId}`, state: RUNBOOK_STEP_STATE[s.status], ...(s.errorCode ? { detail: `Code ${s.errorCode}` } : {}) })),
    cancel:
      run.status === "pending_approval" || run.status === "approved"
        ? { available: true }
        : run.status === "running"
          ? run.cancelRequestedAt
            ? { available: false, reason: "Cancellation was requested. The run stops before its next step; a step already in flight is aborted." }
            : { available: true }
          : { available: false, reason: "This run has finished." },
  });
  if (run.status === "running" && anyUncertain) view.nextSteps = nextStepsFor("uncertain", "runbook_run");
  return view;
}

/* ---------------------------- replan and reapproval ---------------------------- */

export interface ReapprovalState {
  /** the plan or proposal the viewer reviewed no longer matches the record */
  required: boolean;
  reviewed?: string;
  current?: string;
  message?: string;
}

/**
 * The reviewed digest is the one the page was rendered with; the current one is what the
 * server reports now. A different digest means the plan was replaced (replanned): earlier
 * approvals were bound to the old digest and do not carry over, so the viewer must reload
 * and review the new plan before any decision.
 */
export function reapprovalState(reviewed: string | undefined, current: string | undefined): ReapprovalState {
  if (!reviewed || !current || reviewed === current) return { required: false, reviewed, current };
  return {
    required: true,
    reviewed,
    current,
    message: "The plan changed after you opened this page. Approvals given for the earlier plan do not apply. Review the updated plan, then decide.",
  };
}

/* ------------------------------ ownership transfers ------------------------------ */

export interface TransferLike {
  address: string;
  resourceType: string;
  path: string;
  from: string;
  to: string;
  digest: string;
}
export interface TransferRow extends TransferLike {
  /** one sentence naming exactly what approval changes */
  effect: string;
}

const OWNER_LABEL: Record<string, string> = { iac: "infrastructure as code", "native-op": "native operations", autoscaler: "the autoscaler", "provider-managed": "the provider" };

/** Reads the proposal's `broker.ownershipTransfers` defensively; anything malformed is dropped, not guessed. */
export function ownershipTransferRows(proposal: unknown): TransferRow[] {
  const raw = (proposal as { broker?: { ownershipTransfers?: unknown } } | undefined)?.broker?.ownershipTransfers;
  if (!Array.isArray(raw)) return [];
  const out: TransferRow[] = [];
  for (const t of raw.slice(0, 100)) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    const ok = ["address", "resourceType", "path", "from", "to", "digest"].every((k) => typeof r[k] === "string" && (r[k] as string).length > 0 && (r[k] as string).length <= 300);
    if (!ok) continue;
    const row = r as unknown as TransferLike;
    out.push({ ...row, effect: `After approval, ${OWNER_LABEL[row.to] ?? row.to} may write ${row.path} on ${row.address}; ${OWNER_LABEL[row.from] ?? row.from} no longer owns it.` });
  }
  return out;
}

export function ownershipWarnings(proposal: unknown): string[] {
  const raw = (proposal as { broker?: { ownershipWarnings?: unknown } } | undefined)?.broker?.ownershipWarnings;
  return Array.isArray(raw) ? raw.filter((w): w is string => typeof w === "string").slice(0, 20).map((w) => w.slice(0, 500)) : [];
}

/* ---------------------------------- runbook effects ---------------------------------- */

export interface RunbookStepSpec {
  id: string;
  title: string;
  operation: string;
  args: Record<string, unknown>;
  timeoutSec: number;
  onFailure: "abort" | "continue";
}
export type StepDiffKind = "added" | "removed" | "changed" | "unchanged";
export interface StepDiffRow {
  id: string;
  kind: StepDiffKind;
  step: RunbookStepSpec;
  /** field names that differ, for `changed` */
  fields: string[];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * The exact effect an approver is asked to approve, shown against the previous published version.
 * With no previous version every step is "added": the approver is told it is all new, not that
 * nothing changed. Comparison is by canonical JSON of the stored (already parsed) step.
 */
export function diffRunbookSteps(previous: readonly RunbookStepSpec[] | undefined, current: readonly RunbookStepSpec[]): StepDiffRow[] {
  const before = new Map((previous ?? []).map((s) => [s.id, s] as const));
  const rows: StepDiffRow[] = [];
  for (const step of current) {
    const old = before.get(step.id);
    before.delete(step.id);
    if (!old) { rows.push({ id: step.id, kind: "added", step, fields: [] }); continue; }
    const fields = (["title", "operation", "args", "timeoutSec", "onFailure"] as const).filter((f) => stable(old[f]) !== stable(step[f]));
    rows.push({ id: step.id, kind: fields.length ? "changed" : "unchanged", step, fields: [...fields] });
  }
  for (const gone of before.values()) rows.push({ id: gone.id, kind: "removed", step: gone, fields: [] });
  return rows;
}

const DAY_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export interface ScheduleSpecLike {
  cadence: { kind: "interval"; everySec: number; anchor: string } | { kind: "once"; at: string };
  windows: { days: number[]; startMinute: number; endMinute: number }[];
  notBefore?: string;
  notAfter?: string;
  maxRunDurationSec: number;
  maxParallelTargets: number;
}

/** Plain, complete sentences about a schedule's bounds; every bound the binding digest covers is named. */
export function describeSchedule(spec: ScheduleSpecLike): string[] {
  const lines: string[] = [];
  lines.push(spec.cadence.kind === "once" ? `Runs once at ${spec.cadence.at} (UTC).` : `Runs every ${spec.cadence.everySec} seconds from ${spec.cadence.anchor} (UTC).`);
  for (const w of spec.windows) lines.push(`Only inside ${w.days.map((d) => DAY_NAME[d] ?? String(d)).join(", ")} ${hhmm(w.startMinute)} to ${hhmm(w.endMinute)} UTC.`);
  if (spec.notBefore) lines.push(`Not before ${spec.notBefore}.`);
  if (spec.notAfter) lines.push(`Not after ${spec.notAfter}.`);
  lines.push(`Each run is limited to ${spec.maxRunDurationSec} seconds across at most ${spec.maxParallelTargets} target(s) at a time.`);
  return lines;
}

export interface RunbookApprovalEligibility {
  eligible: boolean;
  /** printed beside a disabled approve control */
  reason?: string;
}

/** Mirrors the route's rules for DISPLAY only: admin, a person, not the accountable requester. The route re-checks. */
export function runbookApprovalEligibility(input: { status: string; viewerId: string; viewerRole: string; requester: { id: string; onBehalfOf?: string } }): RunbookApprovalEligibility {
  if (input.status !== "pending_approval") return { eligible: false, reason: "This run is not waiting for approval." };
  if (input.viewerRole !== "admin") return { eligible: false, reason: "Only a workspace admin can approve a runbook run." };
  const accountable = input.requester.onBehalfOf ?? input.requester.id;
  if (accountable === input.viewerId || input.requester.id === input.viewerId) return { eligible: false, reason: "You requested this run, so someone else must approve it." };
  return { eligible: true };
}
