import { describe, expect, it } from "vitest";
import {
  BACKOFF_STEPS_MS,
  DEFAULT_SCHEDULER_CONFIG,
  applyNudge,
  effectiveDueAt,
  eligibility,
  jitterMs,
  priorityOf,
  scheduleAfterRun,
  selectDue,
  type ReconcileSchedule,
  type SchedulableEnvironment,
  type ScheduleOutcome,
} from "@/lib/reconcile";
import { ENV, HOUR, MIN, T0 } from "./_support";

const now = new Date(T0);
const env = (id: string, over: Partial<SchedulableEnvironment> = {}): SchedulableEnvironment => ({ ...ENV, environmentId: id, ...over });
const stable: ScheduleOutcome = { kind: "reconciled", changed: false, openFindings: 0 };
const changed: ScheduleOutcome = { kind: "reconciled", changed: true, openFindings: 0 };

/** Run the ladder: each run happens exactly when the previous schedule said, like a pass would. */
function ladder(environment: SchedulableEnvironment, outcomes: ScheduleOutcome[]): ReconcileSchedule[] {
  const out: ReconcileSchedule[] = [];
  let t = now;
  let prev: ReconcileSchedule | null = null;
  for (const outcome of outcomes) {
    prev = scheduleAfterRun({ environment, previous: prev, outcome, now: t });
    out.push(prev);
    t = new Date(prev.nextRunAt);
  }
  return out;
}

describe("backoff while stable", () => {
  it("climbs 5 → 15 → 60 → 180 minutes and stays at 180", () => {
    const s = ladder(env("e1"), [changed, stable, stable, stable, stable, stable]);
    expect(s.map((x) => x.stepIndex)).toEqual([0, 1, 2, 3, 3, 3]);
    expect(BACKOFF_STEPS_MS).toEqual([5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN]);
    // each gap is the step's interval plus the environment's own jitter (never negative, never more than 20%)
    let t = now.getTime();
    s.forEach((x) => {
      const gap = Date.parse(x.nextRunAt) - t;
      const step = BACKOFF_STEPS_MS[x.stepIndex];
      expect(gap).toBeGreaterThanOrEqual(step);
      expect(gap).toBeLessThan(step * 1.2);
      t = Date.parse(x.nextRunAt);
    });
  });

  it("the very first run of an environment counts as a change (it climbs one step at a time from there)", () => {
    expect(ladder(env("e1"), [changed, stable])[0].stepIndex).toBe(0);
  });

  it("a change resets the ladder to the bottom, however high it had climbed", () => {
    const s = ladder(env("e1"), [changed, stable, stable, stable, changed, stable]);
    expect(s.map((x) => x.stepIndex)).toEqual([0, 1, 2, 3, 0, 1]);
    expect(s[4].lastChangedAt).toBe(s[4].lastRunAt);
    expect(s[5].lastChangedAt).toBe(s[4].lastChangedAt); // a stable run does not move it
  });

  it("open drift never backs off past 60 minutes; an open incident never past 15", () => {
    const drifting: ScheduleOutcome = { kind: "reconciled", changed: false, openFindings: 2 };
    expect(ladder(env("e1"), [changed, drifting, drifting, drifting, drifting]).map((x) => x.stepIndex)).toEqual([0, 1, 2, 2, 2]);
    const incident = env("e1", { openIncidents: 1 });
    expect(ladder(incident, [changed, stable, stable, stable]).map((x) => x.stepIndex)).toEqual([0, 1, 1, 1]);
  });

  it("nothing deployed yet also backs off, and a busy environment is looked at again soon", () => {
    expect(ladder(env("e1"), [{ kind: "nothing_to_reconcile" }, { kind: "nothing_to_reconcile" }, { kind: "nothing_to_reconcile" }]).map((x) => x.stepIndex)).toEqual([1, 2, 3]);
    const s = ladder(env("e1"), [changed, stable, stable, { kind: "busy" }]);
    expect(s[3].stepIndex).toBe(0);
    expect(Date.parse(s[3].nextRunAt) - Date.parse(s[3].lastRunAt ?? "")).toBeLessThan(6 * MIN);
  });

  it("an ineligible environment is parked at the slowest step", () => {
    expect(ladder(env("e1"), [{ kind: "ineligible" }])[0].stepIndex).toBe(3);
  });

  it("failures retry on their own short ladder (5, 10, 20, 40, 60 min) without losing the stable step", () => {
    const climbed = ladder(env("e1"), [changed, stable, stable]);
    const after = (failures: number) => scheduleAfterRun({ environment: env("e1"), previous: { ...climbed[2], consecutiveFailures: failures - 1 }, outcome: { kind: "failed" }, now });
    [5, 10, 20, 40, 60, 60].forEach((minutes, i) => {
      const s = after(i + 1);
      const gap = Date.parse(s.nextRunAt) - now.getTime();
      expect(gap, `failure ${i + 1}`).toBeGreaterThanOrEqual(minutes * MIN);
      expect(gap, `failure ${i + 1}`).toBeLessThan(minutes * MIN * 1.2);
      expect(s.consecutiveFailures).toBe(i + 1);
      expect(s.stepIndex).toBe(climbed[2].stepIndex); // the stable step is untouched
    });
    expect(scheduleAfterRun({ environment: env("e1"), previous: after(3), outcome: stable, now }).consecutiveFailures).toBe(0);
  });
});

describe("deterministic jitter", () => {
  it("is a pure function of the environment id: same id, same offset, every call", () => {
    for (const id of ["env-a", "env-b", "env-c"]) expect(jitterMs(id, 5 * MIN)).toBe(jitterMs(id, 5 * MIN));
    expect(jitterMs("env-a", 5 * MIN)).not.toBe(jitterMs("env-b", 5 * MIN));
  });

  it("stays inside [0, 20% of the interval) and spreads a fleet across it", () => {
    const interval = 15 * MIN;
    const jitters = Array.from({ length: 500 }, (_, i) => jitterMs(`env-${i}`, interval));
    for (const j of jitters) {
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(interval * DEFAULT_SCHEDULER_CONFIG.jitterFraction);
    }
    const buckets = new Set(jitters.map((j) => Math.floor(j / (interval * 0.02))));
    expect(buckets.size).toBeGreaterThanOrEqual(8); // not clumped into a couple of buckets
    expect(Math.max(...jitters)).toBeGreaterThan(interval * 0.15);
  });

  it("two schedules for the same state are identical (no clock, no randomness inside)", () => {
    const a = scheduleAfterRun({ environment: env("e9"), previous: null, outcome: changed, now });
    const b = scheduleAfterRun({ environment: env("e9"), previous: null, outcome: changed, now });
    expect(a).toEqual(b);
  });
});

describe("deploy signals", () => {
  const base = (over: Partial<ReconcileSchedule> = {}): ReconcileSchedule => ({
    workspaceId: "ws-1",
    environmentId: "e1",
    stepIndex: 3,
    nextRunAt: new Date(now.getTime() + 150 * MIN).toISOString(),
    priority: 0,
    lastRunAt: now.toISOString(),
    consecutiveFailures: 0,
    ...over,
  });

  it("a deploy after the last run resets the ladder and pulls the next run forward to one step-0 interval after it", () => {
    const at = new Date(now.getTime() + 20 * MIN).toISOString();
    const n = applyNudge(base(), { at });
    expect(n?.stepIndex).toBe(0);
    const due = Date.parse(n?.nextRunAt ?? "");
    expect(due).toBeGreaterThanOrEqual(Date.parse(at) + 5 * MIN);
    expect(due).toBeLessThan(Date.parse(at) + 6 * MIN + 1);
  });

  it("is idempotent: a deploy the last run already saw, or one that would not bring the run forward, changes nothing", () => {
    const s = base({ lastRunAt: new Date(now.getTime() + 30 * MIN).toISOString() });
    expect(applyNudge(s, { at: new Date(now.getTime() + 20 * MIN).toISOString() })).toBe(s);
    const at = new Date(now.getTime() + 40 * MIN).toISOString();
    const once = applyNudge(s, { at });
    expect(applyNudge(once, { at })).toEqual(once);
    expect(applyNudge({ ...s, stepIndex: 0, nextRunAt: new Date(now.getTime() + 31 * MIN).toISOString() }, { at: new Date(now.getTime() + 30.5 * MIN).toISOString() })?.nextRunAt).toBe(new Date(now.getTime() + 31 * MIN).toISOString());
  });

  it("an environment that has never been scheduled is already due, and garbage timestamps are ignored", () => {
    expect(applyNudge(null, { at: T0 })).toBeNull();
    const s = base();
    expect(applyNudge(s, { at: "not a date" })).toBe(s);
  });
});

describe("priority, eligibility and budget", () => {
  it("recent deploys and open incidents are high priority, and the two add up", () => {
    const fresh = (over: Partial<SchedulableEnvironment>) => priorityOf(env("e1", over), now);
    expect(fresh({})).toBe(0);
    expect(fresh({ lastDeployAt: new Date(now.getTime() - 10 * MIN).toISOString() })).toBe(2);
    expect(fresh({ lastDeployAt: new Date(now.getTime() - 2 * HOUR).toISOString() })).toBe(0);
    expect(fresh({ openIncidents: 1 })).toBe(2);
    expect(fresh({ openIncidents: 1, lastDeployAt: new Date(now.getTime() - MIN).toISOString() })).toBe(4);
  });

  it("skips sandbox environments unless configured, and environments without a VERIFIED connection always", () => {
    expect(eligibility(env("e1"))).toEqual({ ok: true });
    expect(eligibility(env("e1", { class: "sandbox" }))).toEqual({ ok: false, reason: "sandbox" });
    expect(eligibility(env("e1", { provider: "sandbox", connection: undefined }))).toEqual({ ok: false, reason: "sandbox" });
    expect(eligibility(env("e1", { provider: "localstack" }))).toEqual({ ok: false, reason: "sandbox" });
    expect(eligibility(env("e1", { class: "sandbox", connection: undefined }), { ...DEFAULT_SCHEDULER_CONFIG, includeSandbox: true })).toEqual({ ok: true });
    expect(eligibility(env("e1", { connection: undefined }))).toEqual({ ok: false, reason: "no_connection" });
    for (const status of ["pending_verification", "failed", "revoked"] as const)
      expect(eligibility(env("e1", { connection: { id: "c", status } })), status).toEqual({ ok: false, reason: "connection_not_verified" });
    // including sandbox never makes an unverified REAL connection acceptable
    expect(eligibility(env("e1", { connection: undefined }), { ...DEFAULT_SCHEDULER_CONFIG, includeSandbox: true })).toEqual({ ok: false, reason: "no_connection" });
  });

  const item = (id: string, nextInMin: number, priority = 0) => ({ schedule: { environmentId: id, nextRunAt: new Date(now.getTime() + nextInMin * MIN).toISOString(), priority } });

  it("selectDue returns only what is due, best first, at most `limit`, with ties broken by id", () => {
    const items = [item("e-c", -10), item("e-a", -10), item("e-b", -30), item("e-future", 5), item("e-d", -1)];
    expect(selectDue(items, now, 10).map((i) => i.schedule.environmentId)).toEqual(["e-b", "e-a", "e-c", "e-d"]);
    expect(selectDue(items, now, 2).map((i) => i.schedule.environmentId)).toEqual(["e-b", "e-a"]);
    expect(selectDue(items, now, 0)).toEqual([]);
  });

  it("priority jumps the queue, but only by a bounded amount of overdue-ness (no starvation)", () => {
    const boost = DEFAULT_SCHEDULER_CONFIG.priorityBoostMs / MIN; // 10 min per point
    // a deploy-fresh environment due 5 minutes ago beats one due 15 minutes ago…
    expect(selectDue([item("slow", -15), item("fast", -5, 2)], now, 1)[0].schedule.environmentId).toBe("fast");
    // …but one that has waited longer than the boost is worth is served first
    expect(selectDue([item("slow", -(2 * boost + 10)), item("fast", -5, 2)], now, 1)[0].schedule.environmentId).toBe("slow");
    expect(effectiveDueAt(item("x", 0, 2).schedule)).toBe(now.getTime() - 2 * DEFAULT_SCHEDULER_CONFIG.priorityBoostMs);
  });

  it("selection is stable: the same state gives the same order however the input is shuffled", () => {
    const items = Array.from({ length: 40 }, (_, i) => item(`e-${i}`, -(i % 7), i % 3));
    const a = selectDue(items, now, 15).map((i) => i.schedule.environmentId);
    const b = selectDue([...items].reverse(), now, 15).map((i) => i.schedule.environmentId);
    expect(a).toEqual(b);
  });
});
