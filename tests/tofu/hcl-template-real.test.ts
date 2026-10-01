/**
 * Differential oracle: one local, built-in-provider plan for the whole corpus.
 * Gated on a runnable tofu binary; neither cloud credentials nor network needed.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanHclTemplate } from "@/lib/tofu/hcl-template";
import { TofuRunner } from "@/lib/tofu/runner";
import { stableJson } from "@/lib/tofu/stable";
import { assertWorkspaceIntact, configDigestOf } from "@/lib/tofu/workspace";
import { builtinWorkspace, dataFragment, tempDir, tofuOnPath } from "./_helpers";
import { secVectors, upperCorpus } from "./_expression-vectors";

describe.skipIf(!tofuOnPath())("HCL scanner versus real OpenTofu 1.12.5 (no network)", () => {
  it("finds upper whenever tofu evaluates it, and pure literals stay unchanged (one plan)", async () => {
    const sandbox = tempDir("zenith-hcl-oracle-");
    try {
      const fragments = Object.fromEntries(upperCorpus.map((input, i) => [`case${i}`, dataFragment(`case${i}`, input, {
        output: { [`case${i}`]: { value: input } },
      })]));
      const ws = builtinWorkspace(path.join(sandbox.dir, "state.tfstate"), fragments);
      await new TofuRunner({ limits: { timeoutMs: 120_000 } }).run(ws, {}, async (run) => {
        await run.init();
        await run.plan();
        const { json } = await run.showJson();
        const outputs = json.output_changes!;
        expect(Object.keys(outputs)).toHaveLength(upperCorpus.length);
        for (const [i, source] of upperCorpus.entries()) {
          const scan = scanHclTemplate(source);
          const value = outputs[`case${i}`].after;
          if (JSON.stringify(value).includes("ZZ")) expect(scan.calls.has("upper"), `case${i}`).toBe(true);
          if (scan.pureLiteral) expect(value, `literal case${i}`).toBe(source);
        }
      });
    } finally { sandbox.cleanup(); }
  }, 120_000);

  it("refuses every harmless file/path exploit before real tofu can evaluate the version marker", async () => {
    const sandbox = tempDir("zenith-hcl-exploit-");
    try {
      const ws = builtinWorkspace(path.join(sandbox.dir, "state.tfstate"), { a: dataFragment("a", "safe") });
      expect(ws.files.find((f) => f.path === "versions.tf.json")!.content).toContain("required_version");
      const runner = new TofuRunner({ workRoot: sandbox.dir });
      await runner.binary(); // verify this lane really has the pinned executable
      for (const source of secVectors) {
        expect(() => builtinWorkspace("state.tfstate", { a: dataFragment("a", source) })).toThrow();
        const files = ws.files.map((f) => f.path === "main.tf.json"
          ? { ...f, content: stableJson({ resource: { terraform_data: { a: { input: source } } } }) } : f);
        const forged = { ...ws, files, configDigest: configDigestOf(files) };
        expect(() => assertWorkspaceIntact(forged)).toThrow();
        await expect(runner.open(forged)).rejects.toMatchObject({ code: "forbidden_construct" });
      }
    } finally { sandbox.cleanup(); }
  }, 120_000);
});
