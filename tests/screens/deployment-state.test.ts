import { describe, expect, it } from "vitest";
import { reconcileDeployment } from "@/components/deploy/deployment-state";
import type { Deployment } from "@/lib/domain/types";

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
