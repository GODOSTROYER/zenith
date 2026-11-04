/** Exact ZIP/source binding through the real offline CLI; zip/unzip are Mac prerequisites. */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ManifestV2 } from "@/lib/resources/manifest-v2";

describe.skipIf(process.env.ZENITH_TEST_MIXED_LAMBDA_PACKAGE !== "1")("mixed Lambda package [real zip and unzip]", () => {
  it("binds actual source/package bytes and refuses changed artifacts or source metadata", () => {
    const scratch = mkdtempSync(join(tmpdir(), "zn-lambda-package-"));
    const run = (script: string, args: string[]) => execFileSync(process.execPath, [`scripts/acceptance/mixed/${script}.mjs`, ...args], { stdio: "pipe" });
    try {
      run("package-lambda", [scratch]);
      const artifact = JSON.parse(readFileSync(join(scratch, "artifact.json"), "utf8")) as { sha256: string; sourceDigest: string };
      const binding = join(scratch, "binding.json"), manifest = join(scratch, "manifest.json");
      writeFileSync(binding, JSON.stringify({ ...artifact, bucket: "fixture-artifacts", key: "functions/enricher.zip", version: "immutable-1", functionArn: "arn:aws:lambda:us-east-1:123456789012:function:fixture-enricher:1" }));
      run("bind-lambda", [scratch, binding, manifest]);
      expect(ManifestV2.parse(JSON.parse(readFileSync(manifest, "utf8"))).functions?.[0].source).toMatchObject(artifact);
      writeFileSync(join(scratch, "artifact.json"), JSON.stringify({ ...artifact, sourceDigest: "b".repeat(64) }));
      expect(() => run("bind-lambda", [scratch, binding, manifest])).toThrow();
      writeFileSync(join(scratch, "artifact.json"), JSON.stringify(artifact));
      writeFileSync(join(scratch, "enricher.zip"), Buffer.from("changed archive"));
      expect(() => run("bind-lambda", [scratch, binding, manifest])).toThrow();
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 30_000);
});
