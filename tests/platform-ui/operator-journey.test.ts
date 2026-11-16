/** Pure projection contract for the operator journey: one vocabulary for platform, legacy and runbook records. */
import { describe, expect, it } from "vitest";
import type { OperationStatus } from "@/lib/controlplane/types";
import type { DeploymentStatus } from "@/lib/domain/types";
import {
  CANCELLABLE_OPERATION_STATUSES,
  describeSchedule,
  diffRunbookSteps,
  nextStepsFor,
  ownershipTransferRows,
  ownershipWarnings,
  projectLegacyDeployment,
  projectPlatformOperation,
  projectRunbookRun,
  reapprovalState,
  runbookApprovalEligibility,
  type RunbookStepSpec,
} from "@/lib/platform/operator-journey";
import { currentHref, PLATFORM_LINKS } from "@/app/(product)/platform/_components/platform-nav";

const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const ALL_OPERATION: OperationStatus[] = ["proposed", "awaiting_approval", "approved", "rejected", "denied", "queued", "running", "succeeded", "failed", "uncertain", "cancelled", "expired"];

describe("platform operation projection", () => {
  it("projects every operation status without throwing and keeps uncertain distinct", () => {
    for (const status of ALL_OPERATION) {
      const v = projectPlatformOperation({ id: "op_1", status });
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.sentence.length).toBeGreaterThan(0);
    }
    const u = projectPlatformOperation({ id: "op_1", status: "uncertain" });
    expect(u.stage).toBe("uncertain");
    expect(u.outcomeKnown).toBe(false);
    expect(u.terminal).toBe(true);
    expect(u.nextSteps.join(" ")).toMatch(/Do not retry/);
    expect(u.steps.find((s) => s.id === "outcome")?.state).toBe("uncertain");
    expect(projectPlatformOperation({ id: "op_1", status: "failed" }).outcomeKnown).toBe(true);
  });
  it("offers cancellation only before execution starts and says why otherwise", () => {
    for (const status of ALL_OPERATION) {
      const v = projectPlatformOperation({ id: "op_1", status });
      expect(v.cancel.available).toBe(CANCELLABLE_OPERATION_STATUSES.includes(status));
    }
    expect(projectPlatformOperation({ id: "op_1", status: "running" }).cancel.reason).toMatch(/cannot be cancelled/);
  });
  it("never calls a succeeded run verified", () => {
    const v = projectPlatformOperation({ id: "op_1", status: "succeeded" });
    expect(`${v.sentence} ${v.steps.map((s) => s.detail ?? "").join(" ")}`.toLowerCase()).not.toContain("verified");
  });
  it("binds review to the plan digest, falling back to the proposal digest", () => {
    expect(projectPlatformOperation({ id: "o", status: "awaiting_approval", planDigest: D1, proposalDigest: D2 }).reviewDigest).toBe(D1);
    expect(projectPlatformOperation({ id: "o", status: "awaiting_approval", proposalDigest: D2 }).reviewDigest).toBe(D2);
  });
});

describe("legacy and platform views agree", () => {
  const LEGACY: [DeploymentStatus, OperationStatus][] = [
    ["awaiting_approval", "awaiting_approval"],
    ["applying", "running"],
    ["succeeded", "succeeded"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ];
  it.each(LEGACY)("legacy %s and platform %s project the same stage", (legacy, platform) => {
    const l = projectLegacyDeployment({ id: "dep_1", status: legacy, steps: [] });
    const p = projectPlatformOperation({ id: "op_1", status: platform });
    expect(l.stage).toBe(p.stage);
    expect(l.label).toBe(p.label);
    expect(l.sentence).toBe(p.sentence);
    expect(l.tone).toBe(p.tone);
  });
  it("lets the control plane win for a workflow deployment, carrying uncertainty instead of a failure", () => {
    const v = projectLegacyDeployment(
      { id: "dep_1", status: "failed", executor: "workflow", operationId: "op_1", steps: [{ id: "s1", seq: 1, title: "Apply", status: "running" }] },
      { id: "op_1", status: "uncertain", planDigest: D1 }
    );
    expect(v.stage).toBe("uncertain");
    expect(v.steps[0]?.state).toBe("uncertain");
    expect(v.reviewDigest).toBe(D1);
    expect(v.cancel.available).toBe(false);
  });
  it("keeps the in-process engine record when no operation is linked and offers legacy engine cancellation", () => {
    const v = projectLegacyDeployment({ id: "dep_1", status: "rolling_back", steps: [{ id: "b", seq: 2, title: "Second", status: "pending" }, { id: "a", seq: 1, title: "First", status: "done" }] });
    expect(v.stage).toBe("rolling_back");
    expect(v.steps.map((s) => s.title)).toEqual(["First", "Second"]);
    expect(v.cancel.available).toBe(true);
    expect(v.cancel.reason).toBeUndefined();
  });
});

describe("runbook run projection", () => {
  it("shows an uncertain step as uncertain and blocks re-running advice", () => {
    const v = projectRunbookRun({ id: "run_1", status: "uncertain", bindingDigest: D1 }, [
      { targetIndex: 0, stepId: "restart", status: "succeeded" },
      { targetIndex: 0, stepId: "verify", status: "uncertain" },
    ], { restart: "Restart service" });
    expect(v.stage).toBe("uncertain");
    expect(v.steps.map((s) => s.state)).toEqual(["done", "uncertain"]);
    expect(v.nextSteps.join(" ")).toMatch(/Do not re-run/);
    expect(v.steps.find((s) => s.title.includes("Restart service"))).toBeTruthy();
  });
  it("treats a failed run with an uncertain step as uncertain, never failed", () => {
    expect(projectRunbookRun({ id: "r", status: "failed", bindingDigest: D1 }, [{ targetIndex: 0, stepId: "x", status: "uncertain" }]).stage).toBe("uncertain");
  });
  it("cancellation states", () => {
    expect(projectRunbookRun({ id: "r", status: "pending_approval", bindingDigest: D1 }, []).cancel.available).toBe(true);
    expect(projectRunbookRun({ id: "r", status: "running", bindingDigest: D1 }, []).cancel.available).toBe(true);
    const requested = projectRunbookRun({ id: "r", status: "running", cancelRequestedAt: "2026-01-01T00:00:00Z", bindingDigest: D1 }, []);
    expect(requested.cancel.available).toBe(false);
    expect(requested.cancel.reason).toMatch(/Cancellation was requested/);
    expect(projectRunbookRun({ id: "r", status: "succeeded", bindingDigest: D1 }, []).cancel.available).toBe(false);
    expect(projectRunbookRun({ id: "r", status: "pending_approval", bindingDigest: D1 }, []).reviewDigest).toBe(D1);
  });
});

describe("replan and reapproval", () => {
  it("requires reapproval exactly when the reviewed digest changed", () => {
    expect(reapprovalState(D1, D1).required).toBe(false);
    expect(reapprovalState(undefined, D1).required).toBe(false);
    expect(reapprovalState(D1, undefined).required).toBe(false);
    const s = reapprovalState(D1, D2);
    expect(s.required).toBe(true);
    expect(s.message).toMatch(/do not apply/);
  });
});

describe("ownership transfer review", () => {
  const transfer = { address: "aws_ecs_service.web", resourceType: "aws:ecs_service", path: "desired_count", from: "autoscaler", to: "native-op", digest: D1 };
  it("reads the digest-covered transfers and names the exact effect", () => {
    const rows = ownershipTransferRows({ broker: { ownershipTransfers: [transfer] } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.effect).toContain("desired_count");
    expect(rows[0]?.effect).toContain("native operations");
    expect(rows[0]?.effect).toContain("the autoscaler");
  });
  it("drops malformed entries instead of guessing", () => {
    expect(ownershipTransferRows({ broker: { ownershipTransfers: [{ address: "x" }, null, "s", { ...transfer, digest: "" }] } })).toEqual([]);
    expect(ownershipTransferRows(undefined)).toEqual([]);
    expect(ownershipTransferRows({ broker: { ownershipTransfers: "nope" } })).toEqual([]);
  });
  it("bounds warnings", () => {
    const warnings = ownershipWarnings({ broker: { ownershipWarnings: ["a".repeat(900), 3, "ok"] } });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.length).toBe(500);
  });
});

describe("runbook effect diff and approval eligibility", () => {
  const step = (over: Partial<RunbookStepSpec> = {}): RunbookStepSpec => ({ id: "restart", title: "Restart", operation: "service.restart", args: { unit: "web" }, timeoutSec: 60, onFailure: "abort", ...over });
  it("reports a first version as entirely added", () => {
    expect(diffRunbookSteps(undefined, [step()]).map((r) => r.kind)).toEqual(["added"]);
  });
  it("detects added, removed, changed (with the changed fields) and unchanged steps", () => {
    const rows = diffRunbookSteps([step(), step({ id: "gone" }), step({ id: "same" })], [step({ args: { unit: "api" } }), step({ id: "same" }), step({ id: "fresh" })]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.restart?.kind).toBe("changed");
    expect(byId.restart?.fields).toEqual(["args"]);
    expect(byId.same?.kind).toBe("unchanged");
    expect(byId.fresh?.kind).toBe("added");
    expect(byId.gone?.kind).toBe("removed");
  });
  it("is insensitive to argument key order", () => {
    expect(diffRunbookSteps([step({ args: { a: 1, b: 2 } })], [step({ args: { b: 2, a: 1 } })])[0]?.kind).toBe("unchanged");
  });
  it("mirrors the approval rules for display", () => {
    const requester = { id: "u1" };
    expect(runbookApprovalEligibility({ status: "pending_approval", viewerId: "u2", viewerRole: "admin", requester }).eligible).toBe(true);
    expect(runbookApprovalEligibility({ status: "pending_approval", viewerId: "u1", viewerRole: "admin", requester }).reason).toMatch(/requested this run/);
    expect(runbookApprovalEligibility({ status: "pending_approval", viewerId: "u2", viewerRole: "editor", requester }).reason).toMatch(/admin/);
    expect(runbookApprovalEligibility({ status: "running", viewerId: "u2", viewerRole: "admin", requester }).eligible).toBe(false);
    expect(runbookApprovalEligibility({ status: "pending_approval", viewerId: "owner", viewerRole: "admin", requester: { id: "agent", onBehalfOf: "owner" } }).eligible).toBe(false);
  });
  it("describes every schedule bound", () => {
    const lines = describeSchedule({ cadence: { kind: "interval", everySec: 3600, anchor: "2026-10-01T00:00:00Z" }, windows: [{ days: [1, 3], startMinute: 60, endMinute: 120 }], notAfter: "2026-12-01T00:00:00Z", maxRunDurationSec: 600, maxParallelTargets: 2 });
    expect(lines.join("\n")).toContain("every 3600 seconds");
    expect(lines.join("\n")).toContain("Mon, Wed 01:00 to 02:00 UTC");
    expect(lines.join("\n")).toContain("Not after");
    expect(lines.join("\n")).toContain("600 seconds");
  });
});

describe("platform navigation current page", () => {
  it("marks exactly one link and keeps related pages under their section", () => {
    expect(currentHref("/platform")).toBe("/platform");
    expect(currentHref("/platform/operations/op_1")).toBe("/platform");
    expect(currentHref("/platform/deployments/dep_1")).toBe("/platform");
    expect(currentHref("/platform/runbooks/runs/run_1")).toBe("/platform/runbooks");
    expect(currentHref("/platform/connections/aws")).toBe("/platform/connections/aws");
    expect(currentHref("/platform/readiness")).toBe("/platform/readiness");
    expect(currentHref("/overview")).toBeUndefined();
    expect(PLATFORM_LINKS.map((l) => l.href)).toEqual(expect.arrayContaining(["/platform/runbooks", "/platform/readiness", "/platform/connections"]));
  });
  it("explains next steps for every stage a person can land on", () => {
    expect(nextStepsFor("failed", "platform_operation").length).toBeGreaterThan(0);
    expect(nextStepsFor("awaiting_approval", "platform_operation").length).toBeGreaterThan(0);
    expect(nextStepsFor("running", "platform_operation")).toEqual([]);
  });
});
