import { describe, expect, it } from "vitest";
import { INVESTIGATION_NOTE, resolveEvidence, sortHypotheses, tallyEvidence } from "@/components/platform/investigation-model";
import { investigation } from "./fixtures";

const h = (id: string, confidence: number, title = id) => ({
  id,
  code: id,
  title,
  confidence,
  category: "unknown" as const,
  supportingEvidence: [],
  contradictingEvidence: [],
  remediations: [],
});

describe("sortHypotheses", () => {
  it("orders by the confidence in the data, highest first", () => {
    expect(sortHypotheses([h("a", 0.2), h("b", 0.9), h("c", 0.5)]).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
  it("breaks ties by title then id so output is stable", () => {
    expect(sortHypotheses([h("z", 0.5, "Beta"), h("y", 0.5, "Alpha"), h("x", 0.5, "Alpha")]).map((x) => x.id)).toEqual(["x", "y", "z"]);
  });
  it("puts an unusable confidence last, and does not mutate its input", () => {
    const input = [h("nan", Number.NaN), h("ok", 0.1)];
    expect(sortHypotheses(input).map((x) => x.id)).toEqual(["ok", "nan"]);
    expect(input.map((x) => x.id)).toEqual(["nan", "ok"]);
  });
});

describe("resolveEvidence", () => {
  it("resolves ids and reports one that is not in the investigation instead of dropping it", () => {
    const r = resolveEvidence(investigation(), ["ev_1", "ev_missing"]);
    expect(r[0].evidence?.id).toBe("ev_1");
    expect(r[1]).toEqual({ id: "ev_missing", evidence: undefined });
  });
});

describe("tallyEvidence", () => {
  it("counts outcomes", () => {
    expect(tallyEvidence(investigation().evidence)).toEqual({ pass: 1, fail: 1, unknown: 1 });
  });
});

describe("the reading note", () => {
  it("says evidence is data and hypotheses are rules", () => {
    expect(INVESTIGATION_NOTE).toBe("Evidence is observed data; hypotheses are rule-based.");
  });
});
