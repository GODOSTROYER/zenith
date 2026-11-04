/** Real operated lane. Requires owned lean J1/J2/kind and actual Chromium; skips remain unverified. */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run } from "../../scripts/release/drivers/update-rollback";
import { requiredChecks, validateLocalReceipt } from "../../scripts/release/local-targets";
describe.skipIf(process.env.ZENITH_LOCAL_DRV1 !== "1")("DRV-1 update-rollback operated", () => {
  it("updates a compatible image, observes a real failed rollout and browser-approved rollback with owned cleanup", async () => {
    const file = path.resolve(process.env.ZENITH_LOCAL_ROOT!, "update-rollback-operated.json");
    expect(existsSync(file)).toBe(false);
    expect(await run(file)).toBe(0);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const receipt = validateLocalReceipt(raw, { scenarioId: "update-rollback", runId: process.env.ZENITH_LOCAL_RUN_ID!, sourceCommit: raw.sourceCommit });
    expect(receipt.evidenceLabel).toBe("local_operated_rehearsal");
    expect(receipt.checks).toEqual(requiredChecks("update-rollback").map(id => ({ id, status: "passed" })));
  }, 1_800_000);
});
