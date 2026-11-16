import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localTargetCli } from "../../scripts/release/local-target-runner";
import { OPERATED_CHECKS } from "../../scripts/release/drivers/contracts";

describe.skipIf(process.env.ZENITH_LOCAL_OPERATED !== "1")("DRV-3 operated restore", () => {
  it("operates restore with independent readback and owned cleanup", async () => {
    const file = path.join(process.env.ZENITH_LOCAL_ROOT!, "restore-engine-receipt.json");
    expect(await localTargetCli(["run", "--scenario", "restore", "--receipt", file])).toBe(0);
    const receipt = JSON.parse(readFileSync(file, "utf8"));
    expect(receipt.evidenceLabel).toBe("local_operated_rehearsal");
    expect(receipt.checks).toEqual(expect.arrayContaining(OPERATED_CHECKS.restore.map(id => ({ id, status: "passed" }))));
    expect(receipt.checks.every((check: { status: string }) => check.status === "passed")).toBe(true);
  }, 3_660_000);
});
