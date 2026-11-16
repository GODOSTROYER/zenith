/**
 * The live AWS CLI runs through tsx, which compiles it to CommonJS: a module with top-level await anywhere in its import
 * graph makes it fail before it prints anything (vitest, which runs ESM, does not notice). Load it the way the dispatcher does.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("live AWS CLI", () => {
  it("loads under tsx and prints its usage", () => {
    const run = spawnSync(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "scripts/acceptance/aws-live.ts", "--help"], { encoding: "utf8", timeout: 120_000 });
    expect(run.stderr).not.toMatch(/Top-level await|TransformError/);
    expect(run.stdout).toContain("Production AWS acceptance");
  }, 150_000);
});
