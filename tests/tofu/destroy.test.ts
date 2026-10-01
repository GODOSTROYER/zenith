/** Engine contracts with a scripted port. These are not real tofu executions. */
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planDestroy, planWorkspace, applyVerifiedPlan } from "@/lib/tofu/engine";
import { TofuRunner, type TofuRun, type TofuRunContext, type PlanNormalizeBase, type PlanInspector } from "@/lib/tofu/runner";
import { assertDeletionAllowed, normalizePlan, planView, DEFAULT_STATEFUL_TYPES } from "@/lib/tofu/plan";
import { TofuPlanChangedError, TOFU_VERSION, type TofuWorkspace } from "@/lib/tofu/types";
import { builtinWorkspace, dataFragment, node, tempDir } from "./_helpers";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((fn) => fn()); });

function fake() {
  const temp = tempDir(); cleanup.push(temp.cleanup);
  const ws = builtinWorkspace(path.join(temp.dir, "state.tfstate"), { "resource/test": dataFragment("test", "local") });
  const raw = { format_version: "1.2", terraform_version: TOFU_VERSION, resource_changes: [{ address: "terraform_data.test", type: "terraform_data", mode: "managed", change: { actions: ["delete"], before: { input: "SECRET-CANARY-012345", output: "SECRET-CANARY-012345" }, after: null, before_sensitive: { input: true } } }] };
  const plan = normalizePlan(raw, { configDigest: ws.configDigest, lockDigest: ws.lockDigest, addressMap: ws.addressMap, fingerprintKey: "test-key-01234567890123" });
  const run = {
    init: vi.fn(async () => undefined), plan: vi.fn(async () => undefined),
    normalizedPlan: vi.fn(async (_base?: PlanNormalizeBase, inspect?: PlanInspector) => { await inspect?.(plan, raw); return plan; }),
    readPlanFile: vi.fn(async () => Buffer.from("binary-server-only")),
    apply: vi.fn(async (args: Parameters<TofuRun["apply"]>[0]) => { if (args.expectedPlanDigest !== plan.planDigest) throw new TofuPlanChangedError(args.expectedPlanDigest, plan.planDigest); await args.inspectPlan?.(plan, raw); return { plan, result: { command: "apply", exitCode: 0 } }; }),
    output: vi.fn(async () => ({})),
  };
  class ScriptedRunner extends TofuRunner {
    override async run<T>(_ws: TofuWorkspace, _ctx: TofuRunContext, fn: (r: TofuRun) => Promise<T>): Promise<T> { return fn(run as unknown as TofuRun); }
  }
  return { ws, plan, run, runner: new ScriptedRunner(), temp };
}

describe("digest-bound destroy engine", () => {
  it("plans -destroy without the state lock, masks sensitive echoes and keeps the binary server-side", async () => {
    const f = fake();
    const result = await planDestroy(f.ws, undefined, { runner: f.runner, lock: false, planDir: f.temp.dir });
    expect(f.run.plan).toHaveBeenCalledWith({ destroy: true, lock: false });
    expect(result.planFilePath).toBe(path.join(f.temp.dir, `${f.plan.planDigest}.tfplan`));
    expect(JSON.stringify(planView(result.plan))).not.toContain("SECRET-CANARY");
    expect(result.plan.summary.delete).toBe(1);
  });
  it("re-plans destroy and re-runs the guard on the exact plan used for apply", async () => {
    const f = fake(); const inspectPlan = vi.fn();
    await applyVerifiedPlan(f.ws, { runner: f.runner, destroy: true, approvedDigest: f.plan.planDigest, inspectPlan });
    expect(f.run.plan).toHaveBeenCalledWith({ destroy: true });
    expect(inspectPlan).toHaveBeenCalledTimes(1);
  });
  it("refuses a moved approved digest", async () => {
    const f = fake();
    await expect(applyVerifiedPlan(f.ws, { runner: f.runner, destroy: true, approvedDigest: "a".repeat(64) })).rejects.toMatchObject({ code: "plan_changed" });
    expect(f.run.output).not.toHaveBeenCalled();
  });
  it("does not change the normal planning flags", async () => {
    const f = fake(); await planWorkspace(f.ws, undefined, { runner: f.runner });
    expect(f.run.plan).toHaveBeenCalledWith({ lock: undefined });
  });
});

describe("stateful deletion policy", () => {
  it.each(DEFAULT_STATEFUL_TYPES)("refuses %s unless its managed node explicitly allows deletion", (type) => {
    const plan = fake().plan;
    plan.resourceChanges[0] = { ...plan.resourceChanges[0], type, nodeAddress: "resource/test", destroysData: true };
    for (const deletionPolicy of [undefined, "retain", "snapshot", "deny"]) expect(() => assertDeletionAllowed(plan, [node("resource/test", { spec: { deletionPolicy } })])).toThrow(/explicit deletionPolicy/);
    expect(() => assertDeletionAllowed(plan, [node("resource/test", { spec: { deletionPolicy: "allow" } })])).not.toThrow();
    expect(() => assertDeletionAllowed(plan, [])).toThrow();
    expect(() => assertDeletionAllowed(plan, [node("resource/test", { ownership: "referenced", spec: { deletionPolicy: "allow" } })])).toThrow(/non-managed/);
  });
  it("also protects portable stateful nodes and replacements", () => {
    const plan = fake().plan; plan.resourceChanges[0].action = "replace";
    expect(() => assertDeletionAllowed(plan, [node("resource/test", { kind: "postgres" })])).toThrow();
  });
});
