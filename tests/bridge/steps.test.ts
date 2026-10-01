/** Text comparisons avoid loading Temporal's workflow sandbox into Node. */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEPLOY_WORKFLOW_STEPS, plannedWorkflowSteps, STEP_ORDER, STEP_TABLE } from "@/lib/bridge/steps";
const text = (path: string) => readFileSync(path, "utf8");
const literals = (value: string) => [...value.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
it("has every workflow step, matching the declared sequence", () => {
  const declared = text("src/lib/workflows/definitions/deploy.ts").match(/const DEPLOY_STEPS = \[([\s\S]*?)\]/)![1];
  expect(DEPLOY_WORKFLOW_STEPS).toEqual(literals(declared));
  const rows = plannedWorkflowSteps();
  expect(rows.map((r) => r.id)).toEqual(DEPLOY_WORKFLOW_STEPS.map((s) => `step-${s}`));
  rows.forEach((r, i) => expect(r).toMatchObject({ ...STEP_TABLE[DEPLOY_WORKFLOW_STEPS[i]], seq: STEP_ORDER.indexOf(DEPLOY_WORKFLOW_STEPS[i]), targetId: "", status: "pending" }));
  rows[0].status = "done"; expect(plannedWorkflowSteps()[0].status).toBe("pending");
});
it("covers the StepName union exactly (the product port owns display order)", () => {
  const union = text("src/lib/workflows/types.ts").match(/export type StepName =([\s\S]*?);/)![1];
  expect([...STEP_ORDER].sort()).toEqual(literals(union).sort());
});
const port = "Z:/Projects/Spawned.ai/zenith-wt/ws-act/src/lib/execution/product-port.ts";
describe.skipIf(!existsSync(port))("worker projection compatibility", () => {
  it("matches its title/phase table and row order", () => {
    const table = text(port).match(/const STEPS:[\s\S]*?= \{([\s\S]*?)\n\};/)![1];
    const entries = [...table.matchAll(/(\w+): \{ phase: "(\w+)", title: "([^"]+)" \}/g)];
    expect(entries.map((m) => m[1])).toEqual(STEP_ORDER);
    expect(Object.fromEntries(entries.map((m) => [m[1], { phase: m[2], title: m[3] }]))).toEqual(STEP_TABLE);
  });
});
