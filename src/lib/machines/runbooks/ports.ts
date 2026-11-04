/**
 * Runbook persistence port. Two implementations: the Postgres repository
 * (`controlplane/db/repos/machine-runbooks.ts`) and `MemoryRunbookStore` for
 * development and unit tests. Every method that touches tenant data takes the
 * workspace id and filters on it; a foreign id is indistinguishable from a
 * missing one.
 */
import type { Principal } from "@/lib/controlplane/types";
import type { RunbookDefinition, RunbookTarget } from "./definition";
import type { ScheduleSpec } from "./schedule";

export type RunStatus = "pending_approval" | "approved" | "running" | "succeeded" | "failed" | "cancelled" | "expired" | "uncertain";
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["succeeded", "failed", "cancelled", "expired", "uncertain"]);
export type ScheduleStatus = "pending_approval" | "active" | "paused" | "cancelled" | "completed";
export type StepStatus = "started" | "succeeded" | "failed" | "uncertain" | "skipped";

export interface RunbookVersionRecord {
  workspaceId: string;
  runbookId: string;
  version: number;
  name: string;
  definition: RunbookDefinition;
  definitionDigest: string;
  /** compact JWS over (workspace, runbook, version, digest) */
  signature: string;
  signingKid: string;
  publishedBy: string;
  createdAt: string;
}

export interface RunbookApprovalRecord {
  id: string;
  workspaceId: string;
  /** exact immutable effect the approver saw: see `bindingDigestOf` */
  bindingDigest: string;
  requestedBy: string;
  approverId: string;
  expiresAt: string;
  createdAt: string;
}

export interface RunbookScheduleRecord {
  id: string;
  workspaceId: string;
  runbookId: string;
  version: number;
  spec: ScheduleSpec;
  targets: RunbookTarget[];
  bindingDigest: string;
  status: ScheduleStatus;
  /** the next slot not yet decided; null when the schedule has no further slots */
  nextDueAt: string | null;
  createdBy: string;
  /** the principal (an agent keeps its own kind) whose role and policy origin apply to every step */
  creator: Principal;
  createdAt: string;
}

export interface RunbookRunRecord {
  id: string;
  workspaceId: string;
  runbookId: string;
  version: number;
  definitionDigest: string;
  bindingDigest: string;
  scheduleId?: string;
  dueAt?: string;
  targets: RunbookTarget[];
  maxParallelTargets: number;
  status: RunStatus;
  cancelRequestedAt?: string;
  cancelReason?: string;
  requestedBy: string;
  requester: Principal;
  deadlineAt: string;
  leaseUntil?: string;
  failureCode?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface RunbookStepRecord {
  workspaceId: string;
  runId: string;
  targetIndex: number;
  stepId: string;
  operationId: string;
  status: StepStatus;
  errorCode?: string;
  evidenceId?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface RunbookAuditRecord {
  workspaceId: string;
  /** `runbook:<id>`, `schedule:<id>` or `run:<id>`: one hash chain per subject */
  subject: string;
  seq: number;
  event: string;
  actor: string;
  detail: Record<string, unknown>;
  prevDigest: string;
  entryDigest: string;
  createdAt: string;
}

export interface RunbookStore {
  insertVersion(rec: RunbookVersionRecord): Promise<void>;
  getVersion(ws: string, runbookId: string, version: number): Promise<RunbookVersionRecord | null>;
  latestVersion(ws: string, runbookId: string): Promise<RunbookVersionRecord | null>;

  /** latest version of every runbook in the workspace, newest first */
  listRunbooks(ws: string, limit: number): Promise<RunbookVersionRecord[]>;
  listRuns(ws: string, limit: number, status?: RunStatus): Promise<RunbookRunRecord[]>;
  listSchedules(ws: string, limit: number): Promise<RunbookScheduleRecord[]>;
  /** system executor: approved runs, and running runs whose lease expired, across tenants, oldest first */
  listClaimableRuns(now: Date, limit: number): Promise<RunbookRunRecord[]>;

  insertApproval(rec: RunbookApprovalRecord): Promise<void>;
  /** newest approval for exactly this binding that has not expired at `now` */
  findValidApproval(ws: string, bindingDigest: string, now: Date): Promise<RunbookApprovalRecord | null>;

  insertSchedule(rec: RunbookScheduleRecord): Promise<void>;
  getSchedule(ws: string, id: string): Promise<RunbookScheduleRecord | null>;
  /** conditional: only from one of `from`; returns whether it moved */
  setScheduleStatus(ws: string, id: string, from: readonly ScheduleStatus[], to: ScheduleStatus): Promise<boolean>;
  /** pending_approval|paused -> active with a freshly computed cursor (never replays slots missed while inactive) */
  activateSchedule(ws: string, id: string, from: readonly ScheduleStatus[], nextDueAt: string | null): Promise<boolean>;
  /** active schedules with `nextDueAt <= now`, across tenants (system tick), oldest first */
  listDueSchedules(now: Date, limit: number): Promise<RunbookScheduleRecord[]>;
  /** compare-and-set of the slot cursor, so two ticks never decide the same slot */
  advanceSchedule(ws: string, id: string, expectedDueAt: string, nextDueAt: string | null): Promise<boolean>;

  /** unique on (scheduleId, dueAt): a repeated slot returns the existing run with `created: false` */
  insertRun(rec: RunbookRunRecord): Promise<{ run: RunbookRunRecord; created: boolean }>;
  getRun(ws: string, id: string): Promise<RunbookRunRecord | null>;
  approveRun(ws: string, id: string): Promise<boolean>;
  /** cancel a run that has not started, or flag a running one; false when already terminal */
  requestCancel(ws: string, id: string, reason: string, now: Date): Promise<RunbookRunRecord | null>;
  /** approved (or running with an expired lease) -> running with a fresh lease; undefined when not claimable */
  claimRun(ws: string, id: string, now: Date, leaseMs: number): Promise<RunbookRunRecord | undefined>;
  touchLease(ws: string, id: string, now: Date, leaseMs: number): Promise<boolean>;
  finishRun(ws: string, id: string, status: Exclude<RunStatus, "pending_approval" | "approved" | "running">, failureCode: string | undefined, now: Date): Promise<boolean>;

  /** at-most-once step custody: the first caller inserts and dispatches; any other sees `existing` */
  beginStep(rec: RunbookStepRecord): Promise<{ step: RunbookStepRecord; inserted: boolean }>;
  finishStep(ws: string, runId: string, targetIndex: number, stepId: string, patch: { status: Exclude<StepStatus, "started">; errorCode?: string; evidenceId?: string; finishedAt: string }): Promise<void>;
  listSteps(ws: string, runId: string): Promise<RunbookStepRecord[]>;

  appendAudit(ws: string, subject: string, event: string, actor: string, detail: Record<string, unknown>, now: Date): Promise<RunbookAuditRecord>;
  listAudit(ws: string, subject: string): Promise<RunbookAuditRecord[]>;
}
