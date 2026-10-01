/** Guard every ingress, including correctly re-digested workspaces from queues. */
import { describe, expect, it, vi } from "vitest";
import { MAX_WORKSPACE_FILE_BYTES } from "@/lib/tofu/config-digest";
import { TofuRunner } from "@/lib/tofu/runner";
import { stableJson } from "@/lib/tofu/stable";
import type { TofuWorkspace } from "@/lib/tofu/types";
import { assertWorkspaceIntact, configDigestOf, TofuWorkspaceError } from "@/lib/tofu/workspace";
import { builtinWorkspace, dataFragment } from "./_helpers";
import { secVectors } from "./_expression-vectors";

const base = () => builtinWorkspace("terraform.tfstate", { a: dataFragment("a", "safe") });
function altered(main: unknown, file = "main.tf.json"): TofuWorkspace {
  const ws = base();
  const files = ws.files.map((f) => f.path === file ? { ...f, content: stableJson(main) } : f);
  return { ...ws, files, configDigest: configDigestOf(files) };
}
function forbidden(fn: () => unknown): void {
  expect(fn).toThrow(TofuWorkspaceError);
  try { fn(); } catch (error) { expect(error).toMatchObject({ code: "forbidden_construct" }); }
}

describe("workspace expression ingress", () => {
  it.each(secVectors)("refuses the SEC vector in fragment keys and values: %s", (source) => {
    forbidden(() => builtinWorkspace("terraform.tfstate", { a: dataFragment("a", { v: source }) }));
    forbidden(() => builtinWorkspace("terraform.tfstate", { a: dataFragment("a", { [source]: "literal" }) }));
  });

  it("guards tags, default_tags and providerConfig keys and nested values", () => {
    const evil = '${file/**/("versions.tf.json")}';
    const tagCases: Record<string, string>[] = [{ label: evil }, { [evil]: "literal" }];
    for (const tags of tagCases) {
      forbidden(() => builtinWorkspace("terraform.tfstate", {}, { tags }));
    }
    for (const more of [{ region: evil }, { [evil]: "literal" }, { default_tags: { tags: { x: evil } } }]) {
      forbidden(() => builtinWorkspace("terraform.tfstate", {}, { providerSet: "aws", providerConfig: { aws: more } }));
    }
    // Even extras for a provider outside this workspace must be scanned.
    forbidden(() => builtinWorkspace("terraform.tfstate", {}, { providerConfig: { google: { project: evil } } }));
    forbidden(() => builtinWorkspace(evil, {}));
  });

  it.each(secVectors)("rejects a matching-digest forged workspace before the binary or disk: %s", async (source) => {
    const ws = altered({ resource: { terraform_data: { a: { input: source } } } });
    forbidden(() => assertWorkspaceIntact(ws));
    const runner = new TofuRunner();
    const binary = vi.spyOn(runner, "binary");
    await expect(runner.open(ws)).rejects.toMatchObject({ code: "forbidden_construct" });
    expect(binary).not.toHaveBeenCalled();
  });

  it("guards serialized provider files, object keys, nested module configs and override configs", () => {
    const evil = '${nonsensitive/**/("private")}';
    forbidden(() => assertWorkspaceIntact(altered({ provider: { aws: { default_tags: { tags: { x: evil } } } } }, "providers.tf.json")));
    forbidden(() => assertWorkspaceIntact(altered({ resource: { terraform_data: { a: { input: { [evil]: "x" } } } } })));
    for (const filename of ["nested/module/main.tf.json", "override.tf.json", "main.tofu.json", "vars.auto.tfvars.json"]) {
      const ws = base();
      ws.files.push({ path: filename, content: stableJson({ output: { x: { value: evil } } }) });
      ws.configDigest = configDigestOf(ws.files);
      forbidden(() => assertWorkspaceIntact(ws));
    }
    // JSON escapes are decoded before HCL template tokenization; they cannot
    // hide an introducer or a forbidden function from the serialized guard.
    const escaped = altered({ locals: { x: '${file/**/("versions.tf.json")}' } });
    for (const f of escaped.files) {
      if (f.path === "main.tf.json") f.content = f.content.replace(/\$/g, "\\u0024").replace(/file/g, "\\u0066ile");
    }
    escaped.configDigest = configDigestOf(escaped.files);
    forbidden(() => assertWorkspaceIntact(escaped));
  });

  it("accepts cross-file resource roots but rejects unknown roots and native HCL", () => {
    const ws = altered({ output: { x: { value: "${aws_instance.web.id}" } } });
    ws.files.push({ path: "resources.tf.json", content: stableJson({ resource: { aws_instance: { web: {} } } }) });
    ws.configDigest = configDigestOf(ws.files);
    expect(() => assertWorkspaceIntact(ws)).not.toThrow();
    forbidden(() => assertWorkspaceIntact(altered({ output: { x: { value: "${mystery.web.id}" } } })));
    for (const filename of ["override.tf", "main.tofu", "vars.auto.tfvars", "vars.auto.tofuvars", "override.TF"]) {
      const raw = base();
      raw.files.push({ path: filename, content: 'output "evil" { value = file("x") }' });
      raw.configDigest = configDigestOf(raw.files);
      forbidden(() => assertWorkspaceIntact(raw));
    }
  });

  it("refuses malformed JSON and nesting while preserving digest mismatch checks", () => {
    const ws = base();
    ws.files[1].content = "{";
    ws.configDigest = configDigestOf(ws.files);
    forbidden(() => assertWorkspaceIntact(ws));
    let deep: unknown = "x";
    for (let n = 0; n < 150; n++) deep = [deep];
    forbidden(() => assertWorkspaceIntact(altered({ locals: { deep } })));
    const stale = base();
    stale.files[1].content = "{}";
    expect(() => assertWorkspaceIntact(stale)).toThrow(/configDigest/);
  });

  it("never echoes values or hostile key text in a refusal", () => {
    const marker = "SECRET_MARKER_NOT_A_REAL_SECRET";
    for (const input of [`\${file/**/("${marker}")}`, { [`\${file/**/("${marker}")}`]: "x" }, `\${"${marker} ${"${file(\"x\")}"}"}`]) {
      try { builtinWorkspace("terraform.tfstate", { a: dataFragment("a", input) }); throw new Error("accepted"); }
      catch (error) {
        expect(error).toBeInstanceOf(TofuWorkspaceError);
        expect((error as Error).message).not.toContain(marker);
        expect((error as Error).message).toMatch(/fragment.*function file/);
      }
    }
    const hostileLabel = `\${file/**/("${marker}")}`;
    try {
      builtinWorkspace("terraform.tfstate", { a: { resource: { terraform_data: { [hostileLabel]: { input: "x" } } }, addresses: [] } });
      throw new Error("accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "forbidden_construct" });
      expect((error as Error).message).not.toContain(marker);
    }
  });

  it("checks an almost 8 MiB file without tokenizing its literal payload", () => {
    const ws = altered({ locals: { payload: "x".repeat(MAX_WORKSPACE_FILE_BYTES - 100) } });
    const start = performance.now();
    expect(() => assertWorkspaceIntact(ws)).not.toThrow();
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
