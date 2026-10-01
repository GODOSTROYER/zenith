/**
 * Real OpenTofu 1.12.5/random 3.9.1 checks; gated downloads, no cloud account.
 * Ephemeral values are allowed in a lifecycle condition, never in its message:
 * https://opentofu.org/docs/v1.12/language/expressions/custom-conditions/#ephemeral-values-usage
 * The real-binary path must be rerun outside sandboxes that cannot launch tofu.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { applyVerifiedPlan, planWorkspace } from "@/lib/tofu/engine";
import { planView } from "@/lib/tofu/plan";
import { TofuCommandError, TofuRunner } from "@/lib/tofu/runner";
import type { NormalizedPlan } from "@/lib/tofu/types";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { graphOf, node, tempDir, tofuOnPath } from "./_helpers";

function workspace(f: TofuFragment, state: string) {
  return assembleWorkspace({ graph: graphOf([node("resource/check")]), fragments: new Map([["resource/check", f]]), providerSet: "random",
    region: "ap-south-1", backend: { kind: "local", path: state }, tags: {} });
}
const password = { random_password: { bootstrap: { length: 32, min_upper: 1, min_lower: 1, min_numeric: 1, min_special: 1 } } };

// Test-only alphabet: the real provider must generate 32 tildes. No password
// literal is fed into the workspace, and no provider/runner is mocked.
// https://github.com/hashicorp/terraform-provider-random/blob/v3.9.1/docs/ephemeral-resources/password.md
const generatedCanary = "~".repeat(32);
function conditionFragment(expectedLength = 32): TofuFragment {
  return {
    ephemeral: { random_password: { bootstrap: {
      length: 32, upper: false, lower: false, numeric: false, special: true, min_special: 32, override_special: "~",
    } } },
    resource: { terraform_data: { check: { input: "checked", lifecycle: { precondition: [{
      condition: `\${length(ephemeral.random_password.bootstrap.result) == ${expectedLength}}`,
      error_message: "The generated password must have the configured length.",
    }] } } } },
    addresses: ["terraform_data.check"],
  };
}
function expectNoCanary(surface: string, value: unknown): void {
  // Report only a boolean on failure, so leaking output is never printed.
  expect(JSON.stringify(value).includes(generatedCanary), `${surface} leaked the generated canary`).toBe(false);
}
function expectSafePlan(plan: NormalizedPlan, ws: ReturnType<typeof workspace>, stage: "plan" | "final_plan", approvedDigest?: string): void {
  expectNoCanary("normalized plan", plan);
  expectNoCanary("plan view", planView(plan));
  // Exercise the production evidence projection, without claiming a ledger write.
  expectNoCanary("plan evidence", planEvidence({
    plan, facts: extractPlanFacts(plan), cost: {}, graphDigest: graphOf([node("resource/check")]).graphDigest, stage, approvedDigest,
  }));
  expect(plan.configDigest).toBe(ws.configDigest);
}

describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK !== "1" || !tofuOnPath())("real ephemeral resources (network)", () => {
  it("validates the supported random_password ephemeral schema", async () => {
    const ws = workspace({ ephemeral: password, addresses: [] }, "ephemeral.tfstate");
    await new TofuRunner({ limits: { timeoutMs: 600_000 } }).run(ws, {}, async (run) => {
      await run.init({ backend: false });
      const validation = await run.validate();
      expect(validation.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(validation.valid).toBe(true);
    });
  }, 900_000);

  it.each(["output", "resource"])("rejects persisting a sensitive ephemeral password via %s", async (sink) => {
    const ref = "${ephemeral.random_password.bootstrap.result}";
    const f: TofuFragment = { ephemeral: password, addresses: [], ...(sink === "output"
      ? { output: { password: { value: ref, sensitive: true } } }
      : { resource: { terraform_data: { leak: { input: ref } } }, addresses: ["terraform_data.leak"] }) };
    await new TofuRunner({ limits: { timeoutMs: 600_000 } }).run(workspace(f, "ephemeral.tfstate"), {}, async (run) => {
      await run.init({ backend: false });
      const validation = await run.validate();
      expect(validation.valid).toBe(false);
      expect(validation.diagnostics.some((d) => d.severity === "error" && /ephemeral/i.test(`${d.summary} ${d.detail ?? ""}`))).toBe(true);
    });
  }, 900_000);

  it("evaluates a password-dependent condition and keeps generated values out of plan views and state", async () => {
    const t = tempDir("zenith-ephemeral-");
    try {
      const state = path.join(t.dir, "terraform.tfstate");
      const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
      const ws = workspace(conditionFragment(), state);
      expectNoCanary("workspace configuration", ws);
      const inspectPlan = (_plan: NormalizedPlan, raw: unknown) => expectNoCanary("raw show JSON", raw);
      const planned = await planWorkspace(ws, undefined, { runner, inspectPlan });
      expect(planned.plan.resourceChanges.map((r) => r.address)).toEqual(["terraform_data.check"]);
      expect(planned.plan.summary.create).toBe(1);
      expectSafePlan(planned.plan, ws, "plan");
      const changes = JSON.stringify(planned.plan.resourceChanges);
      expect(changes).not.toMatch(/random_password|bcrypt_hash/);
      const applied = await applyVerifiedPlan(ws, { approvedDigest: planned.plan.planDigest, runner, inspectPlan });
      expect(applied.apply.exitCode).toBe(0);
      expect(applied.plan.planDigest).toBe(planned.plan.planDigest);
      expectSafePlan(applied.plan, ws, "final_plan", planned.plan.planDigest);
      expectNoCanary("apply result and outputs", applied);
      const saved = JSON.parse(readFileSync(state, "utf8"));
      expect(saved.resources.map((r: { type: string }) => r.type)).toEqual(["terraform_data"]);
      // Raw .tfstate uses cty's dynamic type/value wrapper, unlike show -json.
      // OpenTofu v1.12.5 pins cty v1.18.0 in go.mod; marshalDynamic encodes this:
      // https://github.com/zclconf/go-cty/blob/v1.18.0/cty/json/marshal.go#L173-L188
      expect(saved.resources[0].instances[0].attributes).toMatchObject({
        input: { type: "string", value: "checked" }, output: { type: "string", value: "checked" },
      });
      expectNoCanary("raw state", saved);
      // State records the ephemeral dependency's address (never a value); nothing else may name it.
      expect(saved.resources[0].instances[0].dependencies).toEqual(["ephemeral.random_password.bootstrap"]);
      const withoutDependencies = { ...saved, resources: saved.resources.map((r: { instances: Record<string, unknown>[] }) => ({ ...r, instances: r.instances.map(({ dependencies: _, ...rest }) => rest) })) };
      expect(JSON.stringify(withoutDependencies)).not.toMatch(/random_password|bcrypt_hash|ephemeral/);
      const replanned = await planWorkspace(ws, undefined, { runner, inspectPlan });
      expect(replanned.plan.empty).toBe(true);
      expectSafePlan(replanned.plan, ws, "plan");
    } finally { t.cleanup(); }
  }, 900_000);

  it("fails a password-dependent condition without disclosing the generated value", async () => {
    const t = tempDir("zenith-ephemeral-refusal-");
    try {
      const ws = workspace(conditionFragment(31), path.join(t.dir, "terraform.tfstate"));
      await new TofuRunner({ limits: { timeoutMs: 600_000 } }).run(ws, {}, async (run) => {
        await run.init();
        const error: unknown = await run.plan().then(() => undefined, (failure: unknown) => failure);
        expect(error).toBeInstanceOf(TofuCommandError);
        if (!(error instanceof TofuCommandError)) throw new Error("Expected a failed real OpenTofu precondition.");
        expectNoCanary("failed plan result", error.result);
        expect(error).toMatchObject({ code: "tofu_command_failed", result: { command: "plan", exitCode: 1 } });
        expect(error.result.output).toMatch(/Resource precondition failed/i);
        expect(error.result.output).toContain("The generated password must have the configured length.");
      });
    } finally { t.cleanup(); }
  }, 900_000);
});
