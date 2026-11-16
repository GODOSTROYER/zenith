/**
 * Server-only durable schedule for the critical maintenance jobs (PROD-OBS-04).
 *
 * Mirrors the reconcile sweep schedule's custody rules without its extra machinery: a fixed
 * namespace-local identity, a one-attempt action, `SKIP` overlap, a five minute catch-up window
 * (one immediate pass after a restart or outage; older missed actions are dropped), and `pauseOnFailure=false` so a
 * transient failure never silently stops the schedule. An existing schedule is adopted only
 * if it matches exactly; an operator pause is never reversed by startup. The execution worker
 * calls `ensureCriticalMaintenanceSchedule` only in explicit provision mode.
 */
import { createHash } from "node:crypto";
import { ScheduleAlreadyRunning, ScheduleNotFoundError, ScheduleOverlapPolicy, type Client, type ScheduleDescription, type ScheduleHandle, type ScheduleOptions } from "@temporalio/client";
import { TASK_QUEUE } from "./types";

export const CRITICAL_SCHEDULE_ID = "zenith-critical-maintenance-v1";
export const CRITICAL_MAINTENANCE_TYPE = "criticalMaintenanceWorkflow";
export const CRITICAL_MAINTENANCE_CONTRACT = "zenith.critical-maintenance.v1";
export const CRITICAL_CADENCE_MS = 60_000;
/** Catch up exactly one missed interval; older missed actions are dropped (the pass is level-triggered). */
export const CRITICAL_CATCHUP_MS = 5 * 60_000;
const RPC_MS = 10_000;
const INPUT = Object.freeze({ contract: CRITICAL_MAINTENANCE_CONTRACT } as const);

export class CriticalScheduleError extends Error {
  constructor(readonly code: "incompatible_schedule" | "transport_unconfirmed") {
    super(code === "incompatible_schedule" ? "The existing critical maintenance schedule is incompatible; operator review is required." : "The critical maintenance schedule response is unconfirmed; inspect its fixed identity before retrying.");
    this.name = "CriticalScheduleError";
  }
}

const digest = (): string => createHash("sha256").update(JSON.stringify([CRITICAL_MAINTENANCE_CONTRACT, CRITICAL_CADENCE_MS, CRITICAL_CATCHUP_MS])).digest("hex");
const memo = (): Record<string, unknown> => ({ zenithOwner: "zenith", zenithContract: CRITICAL_MAINTENANCE_CONTRACT, zenithConfigSha256: digest() });

export function criticalScheduleOptions(): ScheduleOptions {
  return {
    scheduleId: CRITICAL_SCHEDULE_ID,
    spec: { intervals: [{ every: CRITICAL_CADENCE_MS, offset: 0 }], timezone: "UTC" },
    action: { type: "startWorkflow", workflowType: CRITICAL_MAINTENANCE_TYPE, workflowId: CRITICAL_SCHEDULE_ID, taskQueue: TASK_QUEUE, args: [INPUT], workflowExecutionTimeout: 180_000, workflowRunTimeout: 180_000, workflowTaskTimeout: 10_000, retry: { maximumAttempts: 1 } },
    policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: CRITICAL_CATCHUP_MS, pauseOnFailure: false },
    memo: memo(),
    state: { paused: false, note: "Zenith durable critical maintenance." },
  };
}

/** Operator pause/note are state, not configuration, and are never reconciled away. */
export function assertCompatibleCriticalSchedule(actual: ScheduleDescription): void {
  const bad = (): never => { throw new CriticalScheduleError("incompatible_schedule"); };
  const { action, policies, spec } = actual;
  const m = actual.memo ?? {};
  const expected = memo();
  if (actual.scheduleId !== CRITICAL_SCHEDULE_ID || Object.keys(m).sort().join(",") !== Object.keys(expected).sort().join(",") || Object.keys(expected).some((k) => m[k] !== expected[k])) bad();
  if (action.type !== "startWorkflow" || action.workflowType !== CRITICAL_MAINTENANCE_TYPE || action.workflowId !== CRITICAL_SCHEDULE_ID || action.taskQueue !== TASK_QUEUE) bad();
  const args = action.args as unknown[] | undefined;
  if (!Array.isArray(args) || args.length !== 1 || JSON.stringify(args[0]) !== JSON.stringify(INPUT)) bad();
  if (action.retry?.maximumAttempts !== 1 || action.workflowExecutionTimeout !== 180_000 || action.workflowRunTimeout !== 180_000) bad();
  if (policies.overlap !== ScheduleOverlapPolicy.SKIP || policies.catchupWindow !== CRITICAL_CATCHUP_MS || policies.pauseOnFailure !== false) bad();
  if (spec.intervals?.length !== 1 || spec.intervals[0].every !== CRITICAL_CADENCE_MS || (spec.intervals[0].offset ?? 0) !== 0 || (spec.calendars?.length ?? 0) !== 0 || (spec.skip?.length ?? 0) !== 0 || spec.startAt !== undefined || spec.endAt !== undefined || (spec.jitter ?? 0) !== 0) bad();
}

async function rpc<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  try { return await client.schedule.withDeadline(Date.now() + RPC_MS, fn); }
  catch (error) { if (error instanceof CriticalScheduleError || error instanceof ScheduleAlreadyRunning || error instanceof ScheduleNotFoundError) throw error; throw new CriticalScheduleError("transport_unconfirmed"); }
}

/** Create (unpaused) or adopt the fixed schedule. Never mutates an existing schedule. */
export async function ensureCriticalMaintenanceSchedule(client: Client): Promise<{ created: boolean; paused: boolean; handle: ScheduleHandle }> {
  const handle = client.schedule.getHandle(CRITICAL_SCHEDULE_ID);
  try {
    const existing = await rpc(client, () => handle.describe());
    assertCompatibleCriticalSchedule(existing);
    return { created: false, paused: existing.state.paused, handle };
  } catch (error) { if (!(error instanceof ScheduleNotFoundError)) throw error; }
  let created = true;
  try { await rpc(client, () => client.schedule.create(criticalScheduleOptions())); }
  catch (error) { if (!(error instanceof ScheduleAlreadyRunning)) throw error; created = false; }
  const described = await rpc(client, () => handle.describe());
  assertCompatibleCriticalSchedule(described);
  return { created, paused: described.state.paused, handle };
}

export interface CriticalScheduleObservation { present: boolean; compatible: boolean; paused: boolean; running: number; actions: number; skippedOverlap: number; missedCatchup: number }

/** Log-safe projection of the schedule itself; job-level success lives in `platform.scheduled_job_runs`. */
export async function inspectCriticalMaintenanceSchedule(client: Client): Promise<CriticalScheduleObservation> {
  const none = { present: false, compatible: false, paused: false, running: 0, actions: 0, skippedOverlap: 0, missedCatchup: 0 };
  let current: ScheduleDescription;
  try { current = await rpc(client, () => client.schedule.getHandle(CRITICAL_SCHEDULE_ID).describe()); }
  catch (error) { if (error instanceof ScheduleNotFoundError) return none; return { ...none, present: true }; }
  let compatible = true;
  try { assertCompatibleCriticalSchedule(current); } catch { compatible = false; }
  return { present: true, compatible, paused: current.state.paused, running: current.info.runningActions.length, actions: current.info.numActionsTaken, skippedOverlap: current.info.numActionsSkippedOverlap, missedCatchup: current.info.numActionsMissedCatchupWindow };
}
