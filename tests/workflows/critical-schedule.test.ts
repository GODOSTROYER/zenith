/** PROD-OBS-04: the durable critical maintenance schedule definition and its custody rules (no Temporal server needed). */
import { describe, expect, it, vi } from "vitest";
import { ScheduleAlreadyRunning, ScheduleNotFoundError, ScheduleOverlapPolicy, type Client, type ScheduleDescription } from "@temporalio/client";
import {
  CRITICAL_CADENCE_MS, CRITICAL_CATCHUP_MS, CRITICAL_MAINTENANCE_CONTRACT, CRITICAL_SCHEDULE_ID, CriticalScheduleError,
  assertCompatibleCriticalSchedule, criticalScheduleOptions, ensureCriticalMaintenanceSchedule, inspectCriticalMaintenanceSchedule,
} from "@/lib/workflows/critical-schedule";
import { TASK_QUEUE } from "@/lib/workflows/types";

const described = (over: Record<string, unknown> = {}, paused = false): ScheduleDescription => {
  const o = criticalScheduleOptions();
  return { scheduleId: o.scheduleId, spec: o.spec, action: o.action, policies: o.policies, memo: o.memo, state: { paused, note: "x" }, info: { runningActions: [], numActionsTaken: 3, numActionsSkippedOverlap: 1, numActionsMissedCatchupWindow: 0, recentActions: [], nextActionTimes: [], createdAt: new Date() }, ...over } as unknown as ScheduleDescription;
};
const fake = (describe: () => Promise<ScheduleDescription>, create: (...args: unknown[]) => Promise<unknown> = vi.fn(async () => undefined)) =>
  ({ schedule: { getHandle: () => ({ describe }), create, withDeadline: (_d: number, fn: () => Promise<unknown>) => fn() } }) as unknown as Client;
const notFound = () => new ScheduleNotFoundError("none", CRITICAL_SCHEDULE_ID);

describe("critical maintenance schedule definition", () => {
  it("is a one-attempt, SKIP-overlap, bounded catch-up schedule on the execution queue", () => {
    const o = criticalScheduleOptions();
    expect(o.scheduleId).toBe(CRITICAL_SCHEDULE_ID);
    expect(o.policies).toMatchObject({ overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: CRITICAL_CATCHUP_MS, pauseOnFailure: false });
    expect(o.spec.intervals).toEqual([{ every: CRITICAL_CADENCE_MS, offset: 0 }]);
    expect(o.action).toMatchObject({ type: "startWorkflow", workflowType: "criticalMaintenanceWorkflow", taskQueue: TASK_QUEUE, args: [{ contract: CRITICAL_MAINTENANCE_CONTRACT }], retry: { maximumAttempts: 1 } });
    expect(o.state?.paused).toBe(false);
  });

  it("accepts its own description and refuses any drift in an authority-bearing field", () => {
    expect(() => assertCompatibleCriticalSchedule(described())).not.toThrow();
    const o = criticalScheduleOptions();
    const cases: Record<string, unknown>[] = [
      { policies: { ...o.policies, overlap: ScheduleOverlapPolicy.ALLOW_ALL } },
      { policies: { ...o.policies, pauseOnFailure: true } },
      { policies: { ...o.policies, catchupWindow: 1 } },
      { action: { ...o.action, taskQueue: "other" } },
      { action: { ...o.action, workflowType: "other" } },
      { action: { ...o.action, args: [{ contract: "other" }] } },
      { action: { ...o.action, retry: { maximumAttempts: 5 } } },
      { spec: { ...o.spec, intervals: [{ every: 1000 }] } },
      { memo: { zenithOwner: "someone-else" } },
    ];
    for (const over of cases) expect(() => assertCompatibleCriticalSchedule(described(over))).toThrow(CriticalScheduleError);
  });
});

describe("ensureCriticalMaintenanceSchedule", () => {
  it("creates the schedule when absent", async () => {
    let created = false;
    const create = vi.fn(async () => { created = true; });
    const describe = vi.fn(async () => { if (!created) throw notFound(); return described(); });
    const result = await ensureCriticalMaintenanceSchedule(fake(describe, create));
    expect(result).toMatchObject({ created: true, paused: false });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("adopts a compatible existing schedule and keeps an operator pause", async () => {
    const create = vi.fn();
    const result = await ensureCriticalMaintenanceSchedule(fake(async () => described({}, true), create));
    expect(result).toMatchObject({ created: false, paused: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an incompatible existing schedule and never overwrites it", async () => {
    const create = vi.fn();
    await expect(ensureCriticalMaintenanceSchedule(fake(async () => described({ policies: { overlap: ScheduleOverlapPolicy.ALLOW_ALL } }), create))).rejects.toMatchObject({ code: "incompatible_schedule" });
    expect(create).not.toHaveBeenCalled();
  });

  it("tolerates a concurrent creator and verifies what is there", async () => {
    let calls = 0;
    const describe = vi.fn(async () => { if (calls++ === 0) throw notFound(); return described(); });
    const create = vi.fn(async () => { throw new ScheduleAlreadyRunning("exists", CRITICAL_SCHEDULE_ID); });
    expect(await ensureCriticalMaintenanceSchedule(fake(describe, create))).toMatchObject({ created: false });
  });

  it("reports an unconfirmed transport rather than guessing", async () => {
    await expect(ensureCriticalMaintenanceSchedule(fake(async () => { throw new Error("socket closed"); }))).rejects.toMatchObject({ code: "transport_unconfirmed" });
  });
});

describe("inspectCriticalMaintenanceSchedule", () => {
  it("projects counts only and flags absence, drift and pause", async () => {
    expect(await inspectCriticalMaintenanceSchedule(fake(async () => { throw notFound(); }))).toMatchObject({ present: false });
    expect(await inspectCriticalMaintenanceSchedule(fake(async () => described({}, true)))).toEqual({ present: true, compatible: true, paused: true, running: 0, actions: 3, skippedOverlap: 1, missedCatchup: 0 });
    expect(await inspectCriticalMaintenanceSchedule(fake(async () => described({ memo: {} })))).toMatchObject({ present: true, compatible: false });
  });
});
