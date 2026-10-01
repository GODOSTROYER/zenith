/** Real OpenTofu 1.12/random 3.9.1 checks; gated downloads, no cloud account. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { applyVerifiedPlan, planWorkspace } from "@/lib/tofu/engine";
import { TofuRunner } from "@/lib/tofu/runner";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { graphOf, node, tempDir, tofuOnPath } from "./_helpers";

function workspace(f: TofuFragment, state: string) {
  return assembleWorkspace({ graph: graphOf([node("resource/check")]), fragments: new Map([["resource/check", f]]), providerSet: "random",
    region: "ap-south-1", backend: { kind: "local", path: state }, tags: {} });
}
const password = { random_password: { bootstrap: { length: 32, min_upper: 1, min_lower: 1, min_numeric: 1, min_special: 1 } } };

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
      const f: TofuFragment = {
        ephemeral: password,
        resource: { terraform_data: { check: { input: "checked", lifecycle: { precondition: [{ condition: "${length(ephemeral.random_password.bootstrap.result) == 32}", error_message: "The generated password must have the configured length." }] } } } },
        addresses: ["terraform_data.check"],
      };
      const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
      const ws = workspace(f, state);
      const planned = await planWorkspace(ws, undefined, { runner });
      expect(planned.plan.resourceChanges.map((r) => r.address)).toEqual(["terraform_data.check"]);
      const changes = JSON.stringify(planned.plan.resourceChanges);
      expect(changes).not.toMatch(/random_password|bcrypt_hash/);
      await applyVerifiedPlan(ws, { approvedDigest: planned.plan.planDigest, runner });
      const saved = JSON.parse(readFileSync(state, "utf8"));
      expect(saved.resources.map((r: { type: string }) => r.type)).toEqual(["terraform_data"]);
      expect(saved.resources[0].instances[0].attributes).toMatchObject({ input: "checked", output: "checked" });
      expect(JSON.stringify(saved)).not.toMatch(/random_password|bcrypt_hash|ephemeral/);
      expect((await planWorkspace(ws, undefined, { runner })).plan.empty).toBe(true);
    } finally { t.cleanup(); }
  }, 900_000);
});
