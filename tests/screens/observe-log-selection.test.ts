import { describe, expect, it } from "vitest";
import { ALL_SERVICES, resolveLogSelection } from "../../src/app/(product)/p/[slug]/observe/log-selection";

describe("Observe log selection", () => {
  it("retains the all-services filter through ordinary manifest refreshes", () => {
    expect(resolveLogSelection(ALL_SERVICES, ["api", "worker"], [])).toBe(ALL_SERVICES);
  });
  it("retains a deep link to a service awaiting its first deployment", () => {
    expect(resolveLogSelection("new-worker", ["api"], ["new-worker"])).toBe("new-worker");
  });
  it("resolves removed selections against the new environment", () => {
    expect(resolveLogSelection("old-service", ["new-api"], [])).toBe("new-api");
    expect(resolveLogSelection(ALL_SERVICES, ["api"], [])).toBe("api");
    expect(resolveLogSelection("old-service", [], [])).toBe("");
  });
});
