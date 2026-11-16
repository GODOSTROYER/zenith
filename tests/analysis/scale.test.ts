import { describe, expect, it } from "vitest";
import { analyzeRepository, proposeArchitecture, snapshotFromFiles } from "@/lib/analysis";

const line = (i: number): string => `const v${i} = process.env.VAR_${i % 50} || "d${i % 7}"; app.get("/r${i}", (req, res) => res.send(os.environ.get("X_${i % 9}")));`;

describe("scale", () => {
  it("a repository near the intake limits analyses in a few seconds", () => {
    const files: Record<string, string> = { "package.json": JSON.stringify({ dependencies: { express: "4", pg: "8" } }) };
    const body = Array.from({ length: 60 }, (_, i) => line(i)).join("\n");
    for (let i = 0; i < 4000; i++) files[`src/mod${i % 40}/file${i}.ts`] = `${body}\n`;
    const started = performance.now();
    const snap = snapshotFromFiles(files);
    const req = analyzeRepository(snap);
    const proposal = proposeArchitecture(req, { environmentClass: "production", availability: "high" });
    const ms = performance.now() - started;
    expect(snap.files.length).toBe(4001);
    expect(req.envVars.length).toBe(50);
    expect(proposal.manifest.services.length).toBe(1);
    expect(ms, `took ${Math.round(ms)} ms`).toBeLessThan(8000);
  }, 30_000);

  it("stops scanning source at the byte budget and says so", () => {
    const files: Record<string, string> = { "package.json": JSON.stringify({ dependencies: { express: "4" } }) };
    const big = `${"x".repeat(990_000)}\n`;
    for (let i = 0; i < 30; i++) files[`src/big${String(i).padStart(2, "0")}.js`] = big;
    const req = analyzeRepository(snapshotFromFiles(files));
    expect(req.unknowns.some((u) => u.startsWith("Source scanning stopped after"))).toBe(true);
  });
});
