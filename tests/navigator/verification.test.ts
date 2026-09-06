import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigatorRun } from "@/lib/domain/types";
import { gimbalPresentationFor } from "@/components/navigator/gimbal-state";

const fake = vi.hoisted(() => ({
  deployment: { id: "d1", projectId: "p1", environmentId: "e1", revisionId: "r1", status: "succeeded", previousRevisionId: undefined as string | undefined },
  environment: { id: "e1", projectId: "p1", connectionId: "c1", deployedRevisionId: "r1" },
  provider: { id: "localstack", displayName: "LocalStack", verify: vi.fn() },
}));
vi.mock("@/lib/db/store", () => ({ q: {
  deployment: (id: string) => id === "d1" ? fake.deployment : undefined,
  environment: () => fake.environment,
  revision: () => ({ id: "r1", manifest: { version: 1, services: [], resources: [], bindings: [], routes: [] } }),
  revisionManifest: () => undefined,
  connection: () => ({ provider: fake.provider.id }),
} }));
vi.mock("@/lib/providers/types", () => ({ getProvider: () => fake.provider }));
const { verifyRun } = await import("@/lib/navigator/verification");
const run = (): NavigatorRun => ({ id: "n1", projectId: "p1", status: "done", goal: "deploy staging",
  createdAt: "2026-01-01T00:00:00Z", steps: [{ id: "s1", seq: 1, actionId: "deploy.apply", title: "Deploy staging",
    rationale: "Requested", input: {}, status: "done", risk: "high", needsApproval: true, deploymentId: "d1" }] });
const report = () => ({ status: "passed", simulated: false, checkedAt: new Date().toISOString(), detail: "Matched",
  checks: [{ detail: "bucket present", passed: true }] });
beforeEach(() => {
  fake.deployment.status = "succeeded"; fake.deployment.previousRevisionId = undefined;
  fake.environment.deployedRevisionId = "r1"; fake.provider.id = "localstack";
  fake.environment.connectionId = "c1";
  fake.provider.verify.mockReset().mockImplementation(async () => report());
});
describe("whole-run provider evidence", () => {
  it("records fresh referenced checks and makes Verified reachable", async () => {
    const value = run(), result = await verifyRun(value);
    expect(result.verification).toMatchObject({ status: "passed", simulated: false, checks: [{ deploymentId: "d1", revisionId: "r1", provider: "localstack", passed: true }] });
    expect(result.verification?.evidenceRef).toContain("navigator:n1:verification:");
    expect(gimbalPresentationFor({ run: { ...value, verification: result.verification } }).state).toBe("verified");
  });
  it("records failed checks as blocked", async () => {
    fake.provider.verify.mockImplementation(async () => ({ ...report(), status: "failed", checks: [{ detail: "bucket missing", passed: false }] }));
    const result = await verifyRun(run());
    expect(result.verification?.status).toBe("failed");
    expect(gimbalPresentationFor({ run: { ...run(), verification: result.verification } }).state).toBe("blocked");
  });
  it("keeps simulated results neutral", async () => {
    fake.provider.id = "sandbox";
    const result = await verifyRun(run());
    expect(result.verification?.simulated).toBe(true);
    expect(fake.provider.verify).not.toHaveBeenCalled();
    expect(gimbalPresentationFor({ run: { ...run(), verification: result.verification } }).label).toBe("Simulation complete");
  });
  it.each(["system.addResource", "env.setBudget", "ops.restartService"])("does not extend deployment evidence to %s", async (actionId) => {
    const value = run(); value.steps.push({ ...value.steps[0], id: "other", actionId });
    expect((await verifyRun(value)).verification).toBeUndefined();
    expect(fake.provider.verify).not.toHaveBeenCalled();
  });
  it.each(["awaiting_approval", "applying", "failed"])("refuses a deployment still %s", async (status) => {
    fake.deployment.status = status;
    expect((await verifyRun(run())).verification).toBeUndefined();
  });
  it("rejects incomplete and stale observations", async () => {
    for (const change of [{ checks: [] }, { checkedAt: "2020-01-01" }, { status: "unavailable" }, { status: "failed" }]) {
      fake.provider.verify.mockImplementation(async () => ({ ...report(), ...change }));
      expect((await verifyRun(run())).verification).toBeUndefined();
    }
  });
  it("rejects superseded revisions even when the provider check passes", async () => {
    fake.provider.verify.mockImplementation(async () => { fake.environment.deployedRevisionId = "r2"; return report(); });
    expect((await verifyRun(run())).verification).toBeUndefined();
  });
  it("cannot ignore missing previous revisions when verifying removals", async () => {
    fake.deployment.previousRevisionId = "missing";
    expect((await verifyRun(run())).verification).toBeUndefined();
    expect(fake.provider.verify).not.toHaveBeenCalled();
  });
  it("rejects a connection changed during provider read-back", async () => {
    fake.provider.verify.mockImplementation(async () => { fake.environment.connectionId = "c2"; return report(); });
    expect((await verifyRun(run())).verification).toBeUndefined();
  });
});
