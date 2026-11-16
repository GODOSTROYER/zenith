import { describe, expect, it, vi } from "vitest";
import { MemorySemanticsStore } from "@/lib/execution/semantics/store";
import { createIsolationSemanticsGuard, isolationExecutableSemantics, type TenantIsolationPlan, type TenantIsolationRequest } from "@/lib/providers/zenith/onboarding";
import { FULL_ENV, substrate } from "./support";

function fixture() {
  const request: TenantIsolationRequest = { tenant: { workspaceId: "ws-j14", environmentId: "env-j14", workspaceSlug: "j14", environmentSlug: "prod", planTier: "starter" }, substrate: substrate({ ...FULL_ENV, ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "vault:zenith-managed/operators", ZENITH_MANAGED_RUNTIME_CLASS: "zenith-gvisor" }), operationId: "op-j14", lease: { scope: "env:env-j14", fenceToken: 1 } };
  const plan: TenantIsolationPlan = { planDigest: "a".repeat(64), bundleDigest: "b".repeat(64), namespace: "zt-j14", objects: [], notes: [] };
  const broker = { approvalStatus: vi.fn(async () => ({ approved: true, rejected: false, approvalId: "approval-j14", dispatchApproval: { planDigest: plan.planDigest, approvalIds: ["approval-j14"], requiredApprovalCount: 1, approvalRound: 1, proposalDigest: "c".repeat(64) } })) };
  const store = new MemorySemanticsStore();
  return { request, plan, broker, store, guard: createIsolationSemanticsGuard(store, broker) };
}

describe("onboarding DUR-B seam (contract only, caller join pending)", () => {
  it("records the existing canonical semantics format write-once, then requires current human approval", async () => {
    const f = fixture();
    const semantics = await f.guard.recordReviewed(f.request, f.plan);
    expect(semantics.format).toBe("zenith.executable-semantics.v1");
    expect((await f.store.get("ws-j14", "op-j14", f.plan.planDigest))?.semantics.digest).toBe(semantics.digest);
    await f.guard.assertReviewed(f.request, f.plan);
    expect(f.broker.approvalStatus).toHaveBeenCalledWith("op-j14");
  });
  it("refuses a missing store or an unrecorded review", async () => {
    const f = fixture();
    await expect(createIsolationSemanticsGuard(undefined, f.broker).assertReviewed(f.request, f.plan)).rejects.toMatchObject({ code: "not_configured" });
    await expect(f.guard.assertReviewed(f.request, f.plan)).rejects.toMatchObject({ code: "plan_changed" });
    expect(f.broker.approvalStatus).not.toHaveBeenCalled();
  });
  it.each(["bundle", "cluster", "credential", "runtime", "audiences", "lifetime", "tenant"])("refuses moved %s semantics before checking authority", async (part) => {
    const f = fixture();
    await f.guard.recordReviewed(f.request, f.plan);
    if (part === "bundle") f.plan.bundleDigest = "d".repeat(64);
    if (part === "cluster") f.request.substrate.cluster.server = "https://different.invalid";
    if (part === "credential") f.request.substrate.isolation!.operatorCredentialPrefix = "vault:different/operators";
    if (part === "runtime") f.request.substrate.isolation!.runtimeClass = "different-runtime";
    if (part === "audiences") f.request.audiences = ["different-audience"];
    if (part === "lifetime") f.request.tokenTtlSec = 1800;
    if (part === "tenant") f.request.tenant.environmentId = "env-other";
    await expect(f.guard.assertReviewed(f.request, f.plan)).rejects.toMatchObject({ code: "plan_changed" });
    expect(f.broker.approvalStatus).not.toHaveBeenCalled();
  });
  it("cannot move the recorded semantics of an already reviewed plan", async () => {
    const f = fixture();
    await f.guard.recordReviewed(f.request, f.plan);
    f.request.audiences = ["different-audience"];
    await expect(f.guard.recordReviewed(f.request, f.plan)).rejects.toMatchObject({ code: "conflict" });
  });
  it.each(["revoked", "rejected", "unbound", "different-plan", "no-human"])("keeps %s approval refused even when semantics match", async (part) => {
    const f = fixture();
    await f.guard.recordReviewed(f.request, f.plan);
    const authority = await f.broker.approvalStatus();
    if (part === "revoked") authority.approved = false;
    if (part === "rejected") authority.rejected = true;
    if (part === "unbound") authority.dispatchApproval.planDigest = "";
    if (part === "different-plan") authority.dispatchApproval.planDigest = "d".repeat(64);
    if (part === "no-human") authority.approvalId = "";
    f.broker.approvalStatus.mockResolvedValue(authority);
    await expect(f.guard.assertReviewed(f.request, f.plan)).rejects.toMatchObject({ code: "approval_required" });
  });
  it("normalizes audience order and TTL clamping, while lease renewal changes no executable effect", () => {
    const f = fixture();
    const a = isolationExecutableSemantics({ ...f.request, audiences: ["b", "a", "a"], tokenTtlSec: 5000 }, f.plan);
    const b = isolationExecutableSemantics({ ...f.request, audiences: ["a", "b"], tokenTtlSec: 3600, lease: { scope: "renewed", fenceToken: 2 } }, f.plan);
    expect(a).toEqual(b);
  });
});
