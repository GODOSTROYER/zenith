/** Real operated lane. No configuration/credentials/browser access during collection or when gated off. */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run } from "../../scripts/release/drivers/private-source";
import { requiredChecks, validateLocalReceipt } from "../../scripts/release/local-targets";
describe.skipIf(process.env.ZENITH_LOCAL_DRV1 !== "1")("DRV-1 private-source operated", () => {
  it("admits an exact private snapshot through browser approval and refuses revoked execution with owned cleanup", async () => {
    const file = path.resolve(process.env.ZENITH_LOCAL_ROOT!, "private-source-operated.json");
    expect(existsSync(file)).toBe(false);
    expect(await run(file)).toBe(0);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const receipt = validateLocalReceipt(raw, { scenarioId: "private-source", runId: process.env.ZENITH_LOCAL_RUN_ID!, sourceCommit: raw.sourceCommit });
    expect(receipt.evidenceLabel).toBe("local_operated_rehearsal");
    expect(receipt.checks).toEqual(requiredChecks("private-source").map(id => ({ id, status: "passed" })));
  }, 1_800_000);
});
