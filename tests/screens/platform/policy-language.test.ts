import { describe, expect, it } from "vitest";
import { describeApprovalRequirement, describeConstraints, OUTCOME_PRESENTATION } from "@/components/platform/policy-language";

describe("describeApprovalRequirement", () => {
  it("reads as a sentence for one approver", () => {
    expect(describeApprovalRequirement({ count: 1, minRole: "editor", separationOfDuties: false })).toBe(
      "1 person with the editor role or higher must approve it."
    );
  });
  it("covers the count, the role and the two-person rule", () => {
    const s = describeApprovalRequirement({ count: 2, minRole: "admin", separationOfDuties: true });
    expect(s).toContain("2 different people");
    expect(s).toContain("admin role or higher");
    expect(s).toContain("cannot be one of them");
  });
});

describe("describeConstraints", () => {
  it("turns the known limits into plain sentences", () => {
    const lines = describeConstraints({ maxLines: 1000, maxWindowHours: 24, timeoutSec: 300, maxOutputBytes: 1048576, grantDurationSec: 900 });
    const by = Object.fromEntries(lines.map((l) => [l.key, l.sentence]));
    expect(by.maxLines).toBe("At most 1000 log lines can be read per request.");
    expect(by.maxWindowHours).toBe("Logs can only be read from the last 24 hours.");
    expect(by.timeoutSec).toBe("Each command is stopped after 5 minutes.");
    expect(by.maxOutputBytes).toBe("Command output is capped at 1 MB.");
    expect(by.grantDurationSec).toBe("Access for this operation lasts at most 15 minutes.");
  });

  it("gives an unknown limit a readable line, not a bare key", () => {
    const [line] = describeConstraints({ maxParallelDeploys: 2 });
    expect(line.sentence).toBe("Limit on max parallel deploys: 2.");
    expect(line.value).toBe("2");
  });

  it("falls back for a known key with a non-numeric value rather than crashing", () => {
    const [line] = describeConstraints({ maxLines: "all" });
    expect(line.sentence).toBe("Limit on max lines: all.");
  });

  it("is empty without constraints and is ordered deterministically", () => {
    expect(describeConstraints(undefined)).toEqual([]);
    expect(describeConstraints({})).toEqual([]);
    expect(describeConstraints({ b: 1, a: 2 }).map((l) => l.key)).toEqual(["a", "b"]);
  });

  it("does not treat inherited object keys as known limits", () => {
    const [line] = describeConstraints({ constructor: 5 });
    expect(line.sentence).toBe("Limit on constructor: 5.");
  });
});

describe("OUTCOME_PRESENTATION", () => {
  it("has a label, tone and sentence for every outcome", () => {
    for (const k of ["allow", "deny", "require_approval"] as const) {
      expect(OUTCOME_PRESENTATION[k].label).not.toContain("_");
      expect(OUTCOME_PRESENTATION[k].sentence.endsWith(".")).toBe(true);
    }
    expect(OUTCOME_PRESENTATION.deny.tone).toBe("err");
  });
});
