import { describe, expect, it } from "vitest";
import type { NavigatorRun, NavigatorStep, NavigatorVerification } from "@/lib/domain/types";
import { GIMBAL_STATE, GIMBAL_STATES } from "@/components/navigator/gimbal-contract";
import { gimbalPresentationFor, gimbalStateFor, gimbalStateForRun } from "@/components/navigator/gimbal-state";

const step = (overrides: Partial<NavigatorStep> = {}): NavigatorStep => ({
  id: "step-1",
  seq: 1,
  actionId: "deploy.apply",
  title: "Deploy to staging",
  rationale: "Requested by the user",
  input: { environmentId: "staging" },
  risk: "medium",
  needsApproval: true,
  status: "done",
  ...overrides,
});

const evidence = (overrides: Partial<NavigatorVerification> = {}): NavigatorVerification => ({
  scope: "run",
  source: "provider",
  status: "passed",
  simulated: false,
  checkedAt: "2026-09-01T12:01:00.000Z",
  evidenceRef: "provider-check-1",
  ...overrides,
});

const run = (status: NavigatorRun["status"], overrides: Partial<NavigatorRun> = {}): NavigatorRun => ({
  id: "run-1",
  projectId: "project-1",
  goal: "deploy to staging",
  createdAt: "2026-09-01T12:00:00.000Z",
  status,
  steps: [step()],
  ...overrides,
});

describe("Gimbal's authoritative workflow contract", () => {
  it("explains the current step, approval, blocker and cancellation", () => {
    expect(gimbalPresentationFor({ run: run("executing", { steps: [step({ status: "running" })] }) }).description).toContain("Applying step 1 of 1: Deploy to staging");
    expect(gimbalPresentationFor({ run: run("awaiting_approval", { steps: [step({ status: "proposed" })] }) }).description).toContain("Waiting for your approval: Deploy to staging");
    expect(gimbalPresentationFor({ run: run("failed", { steps: [step({ status: "failed", error: "Bucket access denied" })] }) }).description).toContain("Bucket access denied");
    expect(gimbalPresentationFor({ cancelling: true, run: run("executing") }).description).toContain("Stopping after the current step");
    expect(gimbalPresentationFor({ run: run("executing", { verificationPending: true }) }).description).toContain("Checking the completed deployment");
  });
  it("has exactly five states with the required labels and distinct non-color cues", () => {
    expect(GIMBAL_STATES).toEqual(["planning", "awaiting_approval", "applying", "verified", "blocked"]);
    expect(GIMBAL_STATES.map((state) => GIMBAL_STATE[state].label)).toEqual([
      "Planning", "Awaiting approval", "Applying", "Verified", "Blocked",
    ]);
    expect(new Set(GIMBAL_STATES.map((state) => GIMBAL_STATE[state].icon)).size).toBe(5);
  });

  it("separates no run from a workflow state", () => {
    expect(gimbalStateFor({})).toBeNull();
    expect(gimbalPresentationFor({})).toMatchObject({ state: null, label: "Ready", tone: "neutral" });
  });

  it("follows planning, approval and execution signals", () => {
    expect(gimbalStateFor({ planning: true })).toBe("planning");
    expect(gimbalStateForRun(run("planning"))).toBe("planning");
    expect(gimbalStateForRun(run("awaiting_approval"))).toBe("awaiting_approval");
    expect(gimbalStateForRun(run("executing"))).toBe("applying");
    expect(gimbalStateFor({ running: true })).toBe("applying");
  });

  it("shows a new planning request while the previous run is still in view", () => {
    expect(gimbalStateFor({ planning: true, run: run("failed") })).toBe("planning");
  });

  it.each(["deploy.plan", "ops.investigate"])("does not animate %s as provider application", (actionId) => {
    expect(gimbalStateForRun(run("executing", { steps: [step({ actionId, status: "running" })] }))).toBe("planning");
    expect(gimbalStateFor({ running: true, run: run("awaiting_approval", { steps: [step({ actionId, status: "proposed" })] }) })).toBe("planning");
    expect(gimbalStateForRun(run("executing", { steps: [step({ actionId, status: "done" })] }))).toBe("planning");
  });

  it("uses typed execution state for rollback and ignores wording", () => {
    for (const goal of ["roll back production", "everything is verified", "we are blocked"])
      expect(gimbalStateForRun(run("executing", { goal, summary: "Verified" }))).toBe("applying");
    expect(gimbalStateFor({ cancelling: true, run: run("executing", { goal: "roll back production" }) })).toBe("applying");
  });

  it("shows failures and operation errors explicitly", () => {
    expect(gimbalStateForRun(run("failed"))).toBe("blocked");
    expect(gimbalStateFor({ error: "provider failed" })).toBe("blocked");
    expect(gimbalStateFor({ running: true, run: run("failed") })).toBe("blocked");
  });

  it.each(["_blocked", "_clarify"])("does not ask for approval or celebrate unresolved %s steps", (actionId) => {
    const steps = [step(), step({ id: "step-2", seq: 2, actionId, status: "proposed" })];
    expect(gimbalStateForRun(run("awaiting_approval", { steps }))).toBe("blocked");
    expect(gimbalStateForRun(run("done", { steps, verification: evidence() }))).toBe("blocked");
  });

  it("does not celebrate an empty, completed or preview-only plan", () => {
    expect(gimbalStateForRun(run("done", { steps: [] }))).toBeNull();
    expect(gimbalStateForRun(run("done"))).toBeNull();
    const plan = run("done", { steps: [step({ actionId: "deploy.plan" })] });
    expect(gimbalStateForRun(plan)).toBeNull();
    expect(gimbalStateForRun({ ...plan, verification: evidence() })).toBeNull();
    expect(gimbalPresentationFor({ run: plan })).toMatchObject({ state: null, label: "Plan complete" });
    expect(gimbalPresentationFor({ run: run("done") })).toMatchObject({
      state: null,
      label: "Completed",
      tone: "neutral",
      description: expect.stringContaining("Provider verification is not available"),
    });
  });

  it("requires successful, real, referenced provider evidence for the entire completed run", () => {
    expect(gimbalStateForRun(run("done", { verification: evidence() }))).toBe("verified");
    expect(gimbalPresentationFor({ run: run("done", { verification: evidence() }) })).toMatchObject({
      state: "verified", label: "Verified", icon: "check", tone: "ok",
    });
  });

  it.each([
    { simulated: true },
    { evidenceRef: "" },
    { evidenceRef: "   " },
    { checkedAt: "invalid" },
    { checkedAt: "2026-08-01T12:00:00.000Z" },
  ])("rejects unsupported verification evidence %j", (invalid) => {
    expect(gimbalStateForRun(run("done", { verification: evidence(invalid) }))).toBeNull();
  });

  it("labels a completed simulation without implying provider verification", () => {
    expect(gimbalPresentationFor({ run: run("done", { verification: evidence({ simulated: true }) }) })).toMatchObject({
      state: null, label: "Simulation complete", tone: "neutral",
    });
  });

  it.each(["failed", "skipped", "proposed", "running"] as const)("cannot verify a run containing a %s step", (status) => {
    expect(gimbalStateForRun(run("done", { steps: [step({ status })], verification: evidence() }))).toBe("blocked");
  });

  it("shows failed verification as blocked", () => {
    expect(gimbalStateForRun(run("done", { verification: evidence({ status: "failed" }) }))).toBe("blocked");
  });

  it("keeps cancellation neutral even if old evidence or a stale running flag exists", () => {
    const cancelled = run("cancelled", { verification: evidence(), steps: [step({ status: "skipped" })] });
    expect(gimbalStateFor({ run: cancelled, running: true })).toBeNull();
    expect(gimbalPresentationFor({ run: cancelled })).toMatchObject({ state: null, label: "Cancelled", tone: "neutral" });
  });
});
