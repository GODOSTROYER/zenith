/** Mac-only genuine engine checks. Disabled profiles are skipped with explicit prerequisites. */
import path from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import { describe, it, expect } from "vitest";
import { runLocalScenario } from "../../scripts/release/local-target-runner";
import { validateLocalReceipt } from "../../scripts/release/local-targets";
import { execFileSync } from "node:child_process";

const enabled = process.env.ZENITH_LOCAL_TARGETS === "1";
const profile = process.env.ZENITH_LOCAL_PROFILE;
for (const [needed, scenario] of [["mixed", "stateful-traffic"], ["mixed", "mixed-recovery"], ["acme", "dns-tls"], ["billing", "billing"]]) {
  describe.skipIf(!enabled || profile !== needed)(`local rehearsal ${scenario}: needs ZENITH_LOCAL_TARGETS=1, ZENITH_LOCAL_PROFILE=${needed}, local-target-runner up`, () => {
    it("executes the real engine and accepts only the exact run/source checks", async () => {
      const file = path.join(mkdtempSync(path.join(os.tmpdir(), "j15-engine-")), "receipt.json");
      expect(await runLocalScenario(scenario!, file, process.env)).toBe(0);
      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const receipt = validateLocalReceipt(JSON.parse(readFileSync(file, "utf8")), { scenarioId: scenario!, runId: process.env.ZENITH_LOCAL_RUN_ID!, sourceCommit });
      expect(receipt.checks.every(c => c.status === "passed")).toBe(true);
      expect(receipt.evidenceLabel).toBe("local_rehearsal");
    }, 240_000);
  });
}
