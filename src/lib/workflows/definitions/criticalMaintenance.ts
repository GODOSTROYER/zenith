/** New workflow type (PROD-OBS-04): durable reaping/housekeeping/runbook pass. No existing workflow changes. */
import { ActivityCancellationType, ApplicationFailure, proxyActivities, workflowInfo } from "@temporalio/workflow";

export interface CriticalMaintenanceInput { contract: "zenith.critical-maintenance.v1" }
export interface CriticalMaintenanceActivityInput extends CriticalMaintenanceInput { passId: string }
export type CriticalMaintenanceOutcome = "ok" | "busy" | "skipped" | "failed";
/** Statuses only: no counts, rows or errors enter workflow history. */
export interface CriticalMaintenanceResult {
  engine: CriticalMaintenanceOutcome;
  alerts: CriticalMaintenanceOutcome;
  outbox: CriticalMaintenanceOutcome;
  housekeeping: CriticalMaintenanceOutcome;
  "runner-reaper": CriticalMaintenanceOutcome;
  runbooks: CriticalMaintenanceOutcome;
  /** Optional for replay of pre-billing histories; current activities always return it. */
  billing?: CriticalMaintenanceOutcome;
}
export interface CriticalMaintenanceActivities {
  runCriticalMaintenance(input: CriticalMaintenanceActivityInput): Promise<CriticalMaintenanceResult>;
}

const maintenance = proxyActivities<CriticalMaintenanceActivities>({
  startToCloseTimeout: "100s",
  scheduleToCloseTimeout: "150s",
  heartbeatTimeout: "20s",
  // A runbook step may have dispatched; a timeout is uncertain, so no automatic replay. The next tick re-derives due work.
  retry: { maximumAttempts: 1 },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

/** One finite maintenance pass. Cancellation starts no compensation. */
export async function criticalMaintenanceWorkflow(input: CriticalMaintenanceInput): Promise<CriticalMaintenanceResult> {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).join(",") !== "contract" || input.contract !== "zenith.critical-maintenance.v1")
    throw ApplicationFailure.nonRetryable("Critical maintenance input is invalid.", "CriticalMaintenanceContractInvalid");
  const result = await maintenance.runCriticalMaintenance({ contract: input.contract, passId: workflowInfo().runId });
  if (!result || !["engine", "alerts", "outbox", "housekeeping", "runner-reaper", "runbooks"].every((k) => ["ok", "busy", "skipped", "failed"].includes((result as unknown as Record<string, string>)[k])))
    throw ApplicationFailure.nonRetryable("Critical maintenance result is invalid.", "CriticalMaintenanceContractInvalid");
  if (result.billing !== undefined && !["ok", "busy", "skipped", "failed"].includes(result.billing))
    throw ApplicationFailure.nonRetryable("Critical billing result is invalid.", "CriticalMaintenanceContractInvalid");
  return result;
}
