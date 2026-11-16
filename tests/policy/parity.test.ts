/**
 * Wasm/interpreter parity. The Rego unit tests run on the OPA interpreter; the
 * product runs the compiled wasm. This evaluates the same inputs both ways and
 * requires identical decisions, so a divergence between OPA's interpreter and
 * its wasm target (or a stale bundle) cannot hide.
 *
 * Needs the pinned `opa` on PATH; skipped (not failed) when it is absent, since
 * `node policy/build.mjs --check` runs the Rego suite wherever opa exists.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractPlanFacts, loadPolicyEngine, type PolicyInput } from "@/lib/policy";
import { OPA_VERSION, readSources } from "../../policy/build.mjs";
import { loadPlanFixture } from "./plan-fixtures";
import { SCENARIOS } from "./scenarios";
import { policyInput, production } from "./support";

const opaProbe = spawnSync(process.env.ZENITH_OPA_BIN || "opa", ["version"], { encoding: "utf8" });
const opaAvailable = opaProbe.status === 0 && new RegExp(`^Version:\\s*${OPA_VERSION.replace(/\./g, "\\.")}$`, "m").test(opaProbe.stdout);

const FIXTURES = ["web-stack-create", "risky-changes", "stateful-destroy", "unknown-values", "regions-mixed", "no-changes"];

function allInputs(): { name: string; input: PolicyInput }[] {
  const cases = SCENARIOS.map((s) => ({ name: s.name, input: policyInput(s.capability, s.patch, s.workspace) }));
  for (const fixture of FIXTURES) {
    const plan = extractPlanFacts(loadPlanFixture(fixture));
    for (const [label, env] of [["development", { environment: { autonomyLevel: 5 } }], ["production", production]] as const) {
      cases.push({ name: `${fixture} in ${label}`, input: policyInput("infrastructure.apply", { ...env, plan }) });
      cases.push({ name: `${fixture} in ${label} (reconciler)`, input: policyInput("drift.repair", { ...env, plan, principal: { kind: "system", role: "none" }, context: { origin: "reconciler" } }) });
    }
  }
  return cases;
}

describe.skipIf(!opaAvailable)("the wasm agrees with the OPA interpreter", () => {
  it("returns the same decision for every scenario and plan fixture", async () => {
    const cases = allInputs();
    expect(cases.length).toBeGreaterThan(80);

    const dir = mkdtempSync(path.join(tmpdir(), "zenith-parity-"));
    try {
      // Stage the sources beside the data and run from there: opa mangles
      // absolute Windows paths given to `-d`, so relative paths are used.
      for (const source of readSources()) writeFileSync(path.join(dir, source.name), source.text);
      writeFileSync(path.join(dir, "cases.json"), JSON.stringify({ cases: cases.map((c) => c.input) }));
      const out = execFileSync(
        process.env.ZENITH_OPA_BIN || "opa",
        ["eval", "-d", ".", "--format", "json", "[r | some c in data.cases; r := data.zenith.decision.result with input as c]"],
        { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
      );
      const interpreted = (JSON.parse(out) as { result: { expressions: { value: unknown[] }[] }[] }).result[0].expressions[0].value;
      expect(interpreted).toHaveLength(cases.length);

      const engine = await loadPolicyEngine();
      for (const [index, { name, input }] of cases.entries()) {
        const { decision } = await engine.evaluate(input);
        expect(decision, name).toEqual(interpreted[index]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
