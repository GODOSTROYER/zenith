import { describe, expect, it } from "vitest";
import { compareUsd, computePeriodUsd, decimalFromNumber } from "@/lib/compute-catalog/money";

describe("exact compute quote arithmetic", () => {
  it("preserves decimal rates through fractional hours and multiple instances", () => {
    expect(computePeriodUsd("0.1", 0.2, 3)).toBe("0.06");
    expect(computePeriodUsd("0.101234567891", 730, 3)).toBe("221.70370368129");
    expect(computePeriodUsd("0", 730, 100)).toBe("0");
  });

  it("compares exact decimals beyond floating point precision", () => {
    expect(compareUsd("0.100000000000000001", "0.1")).toBe(1);
    expect(compareUsd("0.06000", "0.06")).toBe(0);
    expect(compareUsd("0.059999999999999999", "0.06")).toBe(-1);
  });

  it("expands scientific notation for validated quantity inputs", () => {
    expect(decimalFromNumber(1e-7)).toBe("0.0000001");
    expect(decimalFromNumber(1.2345e21)).toBe("1234500000000000000000");
    expect(computePeriodUsd("0.02", 1e-7, 2)).toBe("0.000000004");
  });

  it.each(["-0.1", "NaN", "Infinity", "1e-3", "", "01.5", "0x10"])("rejects the non-decimal rate %j", (rate) => {
    expect(() => computePeriodUsd(rate, 730, 1)).toThrow(/decimal/);
  });

  it("does not quote invalid quantities", () => {
    expect(() => computePeriodUsd("0.1", NaN, 1)).toThrow();
    expect(() => computePeriodUsd("0.1", -1, 1)).toThrow();
    expect(() => computePeriodUsd("0.1", 730, 1.5)).toThrow();
  });
});
