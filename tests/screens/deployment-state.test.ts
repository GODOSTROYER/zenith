import { describe, expect, it } from "vitest";
import { applyStreamEvent, EMPTY_DEPLOYMENT_PATCH, reconcileDeployment } from "@/components/deploy/deployment-state";
import { followsStatus } from "@/lib/domain/deployment-status";
import type { Deployment, DeploymentEvent, DeploymentStatus } from "@/lib/domain/types";

const base: Deployment = { id: "dep", projectId: "project", environmentId: "env", revisionId: "rev", status: "applying", steps: [{ id: "step", seq: 1, phase: "provision", title: "Provision", targetId: "db", status: "pending" }], outputs: [], changeSummary: "Add database", estCostDeltaUsd: 12, actor: { id: "user", type: "user", name: "Operator" }, createdAt: "2026-09-07T00:00:00Z" };

describe("deployment poll and stream reconciliation", () => {
  it("applies actual streamed phase and resource state", () => {
    expect(reconcileDeployment(base, { status: "verifying", steps: { step: { status: "running" } }, outputs: [] })).toMatchObject({ status: "verifying", steps: [{ targetId: "db", status: "running" }] });
  });
  it("does not rewind a completed provider record with an earlier stream patch", () => {
    const completed = { ...base, status: "succeeded" as const, steps: [{ ...base.steps[0], status: "done" as const }] };
    expect(reconcileDeployment(completed, { status: "applying", steps: { step: { status: "running" } }, outputs: [] })).toMatchObject({ status: "succeeded", steps: [{ status: "done" }] });
  });
  it("does not rewind a later polled phase while a stream is reconnecting", () => {
    expect(reconcileDeployment({ ...base, status: "verifying" }, { status: "applying", steps: {}, outputs: [] }).status).toBe("verifying");
  });
  it("retains provider output values and their simulation flags", () => {
    const output = { key: "db", kind: "text" as const, label: "Database", value: "authoritative", simulated: true };
    expect(reconcileDeployment({ ...base, outputs: [output] }, { steps: {}, outputs: [{ ...output, value: "old" }] }).outputs).toEqual([output]);
  });
});

describe("Deploys detail: a stale event after a terminal one", () => {
  const status = (seq: number, value: DeploymentStatus): DeploymentEvent => ({ ts: "", deploymentId: "dep", seq, type: "status", status: value });
  const step = (seq: number, value: "running" | "done"): DeploymentEvent => ({ ts: "", deploymentId: "dep", seq, type: "step", stepId: "step", status: value });
  // The log a losing instance leaves behind: its "verifying" lands after the winner's "succeeded".
  const log = [status(0, "planning"), status(1, "applying"), step(2, "running"), step(3, "done"), status(4, "verifying"), status(5, "succeeded"), status(6, "verifying"), step(7, "running")];
  const replay = (events: DeploymentEvent[]) => events.reduce(applyStreamEvent, EMPTY_DEPLOYMENT_PATCH);

  it("keeps the list's Succeeded when the replayed log ends on Verifying", () => {
    const row = { ...base, status: "succeeded" as const, steps: [{ ...base.steps[0], status: "done" as const }] };
    expect(reconcileDeployment(row, replay(log))).toMatchObject({ status: "succeeded", steps: [{ status: "done" }] });
  });
  it("reaches Succeeded from a live snapshot and does not fall back", () => {
    const patch = replay(log);
    expect(patch.status).toBe("succeeded");
    expect(patch.steps.step.status).toBe("done");
    expect(reconcileDeployment(base, patch).status).toBe("succeeded");
  });
  it("still follows a rollback of a finished deployment", () => {
    const patch = replay([...log, status(8, "rolling_back"), status(9, "rolled_back")]);
    expect(patch.status).toBe("rolled_back");
    expect(reconcileDeployment({ ...base, status: "rolling_back" }, replay([status(0, "succeeded")])).status).toBe("rolling_back");
  });
  it("defines which status can follow which", () => {
    expect(followsStatus("applying", "verifying")).toBe(true);
    expect(followsStatus("succeeded", "verifying")).toBe(false);
    expect(followsStatus("succeeded", "rolling_back")).toBe(true);
    expect(followsStatus("rolling_back", "rolled_back")).toBe(true);
    expect(followsStatus("rolling_back", "applying")).toBe(false);
    expect(followsStatus("cancelled", "applying")).toBe(false);
  });
});
