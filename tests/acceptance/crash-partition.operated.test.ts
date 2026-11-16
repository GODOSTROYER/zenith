import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crashPartitionDriver } from "../../scripts/release/drivers/crash-partition";
import { OperatedReceiptSchema, DRIVER_CHECKS } from "../../scripts/release/drivers/operated-contract";

describe.skipIf(process.env.ZENITH_TEST_DRV2_OPERATED !== "1")("DRV-2 owned operated scenarios", () => {
  it("crash-partition produces complete local_operated_rehearsal evidence and owned cleanup", async () => {
    const file = path.join(process.env.ZENITH_LOCAL_ROOT!, "crash-partition.json");
    expect(await crashPartitionDriver(file)).toBe(0);
    const receipt = OperatedReceiptSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    expect(receipt.evidenceLabel).toBe("local_operated_rehearsal");
    expect(receipt.checks).toEqual(DRIVER_CHECKS["crash-partition"].map(id => ({ id, status: "passed" })));
    expect(receipt.readbacks).toHaveLength(7);
  }, 1_800_000);
});
