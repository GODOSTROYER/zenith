/**
 * Typed dependency inputs and producer output capture against REAL OpenTofu (built-in terraform_data, local backend; no cloud,
 * no network). Skipped, with the reason in the suite name, only when no tofu binary is on PATH / ZENITH_TOFU_BIN. Proves:
 *  - a non-secret input declared as a variable default reaches the resource and a producer's output is captured with its value;
 *  - a sensitive input reaches tofu only through the dedicated environment channel, never through a file, a plan view, the apply
 *    result or the redacted command output;
 *  - sensitive OUTPUT values are returned for sealing only when asked for, and never inside `outputs`;
 *  - the channel refuses names outside the zenith_in_ namespace.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyVerifiedPlan, planWorkspace } from "@/lib/tofu/engine";
import { TofuRunner } from "@/lib/tofu/runner";
import { builtinWorkspace, dataFragment, tempDir, tofuOnPath } from "./_helpers";

const hasTofu = tofuOnPath();
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function sandbox() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return { dir: t.dir, state: path.join(t.dir, "state", "terraform.tfstate") };
}

describe.skipIf(!hasTofu)("typed inputs and output capture (real tofu 1.12.5, local backend)", () => {
  const runner = new TofuRunner({ limits: { timeoutMs: 120_000 } });
  // Built at run time: nothing here looks like a real credential.
  const secret = ["s3cr3t", "value", String(Date.now())].join("-");
  const fragments = {
    "resource/a": dataFragment("a", "${var.zenith_in_endpoint_db}", {
      output: {
        a_endpoint: { value: "${terraform_data.a.input}" },
        a_token: { value: "${terraform_data.a.id}-${var.zenith_in_db_password}", sensitive: true },
      },
    }),
  };
  const inputs = [
    { name: "endpoint_db", type: "string" as const, sensitive: false, value: "db.internal.example" },
    { name: "db_password", type: "string" as const, sensitive: true },
  ];
  const session = { inputEnv: () => ({ TF_VAR_zenith_in_db_password: secret }) };

  it("delivers a non-secret input by default and a secret through the input channel only, and captures outputs", async () => {
    const { state } = sandbox();
    const ws = builtinWorkspace(state, fragments, { inputs });
    expect(ws.files.map((f) => f.content).join("\n")).not.toContain(secret);

    const planned = await planWorkspace(ws, session, { runner });
    expect(JSON.stringify(planned.plan)).not.toContain(secret);
    const applied = await applyVerifiedPlan(ws, { approvedDigest: planned.plan.planDigest, runner, session, captureSensitiveOutputs: true });
    // the non-secret input reached the resource and is captured as an output with its value
    expect(applied.outputs.a_endpoint).toMatchObject({ sensitive: false, value: "db.internal.example" });
    // the sensitive output has no value in `outputs`; its value is returned separately, only because it was asked for
    expect(applied.outputs.a_token).toEqual({ sensitive: true, type: "string" });
    expect(applied.sensitiveOutputs?.a_token).toEqual(expect.stringContaining(secret));
    // nothing else that leaves the engine carries the secret: plan, command output and outputs are clean
    const visible = JSON.stringify({ ...applied, sensitiveOutputs: undefined });
    expect(visible).not.toContain(secret);
    expect(applied.apply.output).not.toContain(secret);
  }, 240_000);

  it("returns no sensitive values unless asked for", async () => {
    const { state } = sandbox();
    const ws = builtinWorkspace(state, fragments, { inputs });
    const planned = await planWorkspace(ws, session, { runner });
    const applied = await applyVerifiedPlan(ws, { approvedDigest: planned.plan.planDigest, runner, session });
    expect(applied.sensitiveOutputs).toBeUndefined();
    expect(applied.outputs.a_token).toEqual({ sensitive: true, type: "string" });
  }, 240_000);

  it("refuses to plan a consumer whose secret input was not supplied (nothing is guessed or defaulted)", async () => {
    const { state } = sandbox();
    const ws = builtinWorkspace(state, fragments, { inputs });
    await expect(planWorkspace(ws, undefined, { runner })).rejects.toThrow();
  }, 120_000);

  it("refuses an input channel entry outside the zenith_in_ variable namespace", async () => {
    const { state } = sandbox();
    const ws = builtinWorkspace(state, fragments, { inputs });
    for (const name of ["TF_VAR_other", "TF_CLI_ARGS", "AWS_SECRET_ACCESS_KEY", "TF_VAR_zenith_in_Upper"]) {
      await expect(planWorkspace(ws, { inputEnv: () => ({ [name]: "x" }) }, { runner })).rejects.toThrow(/zenith_in_/);
    }
  }, 120_000);
});
