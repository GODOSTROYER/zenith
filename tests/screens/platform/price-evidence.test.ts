import { describe, expect, it } from "vitest";
import {
  evidenceFor,
  fmtUnitUsd,
  isWeakLine,
  NO_SOURCE,
  PRICE_EVIDENCE,
  summarizeWeakEvidence,
  unitLabel,
  type PriceVerification,
} from "@/components/platform/price-evidence";
import { estimate, plainEstimate } from "./fixtures";

describe("weak price evidence", () => {
  it.each<[PriceVerification, boolean]>([
    ["official_api", false],
    ["official_page", false],
    ["third_party_mirror", false],
    ["derived", true],
    ["model_knowledge", true],
    ["internal_assumption", true],
  ])("%s weak=%s", (v, weak) => {
    expect(isWeakLine({ priceVerification: v })).toBe(weak);
    expect(PRICE_EVIDENCE[v].sentence.length).toBeGreaterThan(20);
  });

  it("does not call a line with no recorded source weak, and says the source is unknown", () => {
    expect(isWeakLine({})).toBe(false);
    expect(evidenceFor({})).toBe(NO_SOURCE);
    expect(NO_SOURCE.label).toBe("Source not recorded");
  });

  it("summarises the count, the classes and the share of the total", () => {
    const s = summarizeWeakEvidence(estimate());
    expect(s.total).toBe(4);
    expect(s.weak).toBe(3);
    expect(s.classes.sort()).toEqual(["derived", "internal_assumption", "model_knowledge"]);
    // (49.64 + 2.3 + 38.51) / 120 = 75%
    expect(s.weakSharePercent).toBe(75);
  });

  it("has no share for a zero total and tolerates a contract estimate without the field", () => {
    expect(summarizeWeakEvidence({ lines: [], monthlyUsd: 0 }).weakSharePercent).toBeUndefined();
    const s = summarizeWeakEvidence(plainEstimate());
    expect(s.weak).toBe(0);
  });
});

describe("unit formatting", () => {
  it("keeps fractions of a cent visible", () => {
    expect(fmtUnitUsd(0.04048)).toBe("$0.04048");
    expect(fmtUnitUsd(0.1)).toBe("$0.10");
    expect(fmtUnitUsd(2)).toBe("$2.00");
    expect(fmtUnitUsd(0)).toBe("$0.00");
    expect(fmtUnitUsd(Number.NaN)).toBe("$0.00");
  });
  it("labels units and falls back for one it does not know", () => {
    expect(unitLabel("gb_month")).toBe("per GB-month");
    expect(unitLabel("ratio")).toBe("multiplier");
    expect(unitLabel("vcpu_second")).toBe("vcpu second");
  });
});
