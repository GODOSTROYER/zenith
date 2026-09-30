import { describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { DEFAULT_WORKSPACE_POLICY, PolicyConfigError, resolveWorkspacePolicy, WorkspacePolicyParamsSchema } from "@/lib/policy";
import { DEFAULT_WORKSPACE_POLICY as CONTRACT_DEFAULTS } from "@/lib/policy/types";

describe("resolveWorkspacePolicy", () => {
  it("re-exports the contract's defaults", () => {
    expect(DEFAULT_WORKSPACE_POLICY).toBe(CONTRACT_DEFAULTS);
  });

  it("returns the defaults for nothing, undefined or null", () => {
    for (const empty of [undefined, null, {}]) {
      expect(resolveWorkspacePolicy(empty)).toEqual(DEFAULT_WORKSPACE_POLICY);
    }
  });

  it("returns a fresh object, so callers cannot mutate the shared defaults", () => {
    const resolved = resolveWorkspacePolicy();
    resolved.deniedCapabilities.push("service.restart");
    resolved.autoRemediation.production = "any";
    expect(DEFAULT_WORKSPACE_POLICY.deniedCapabilities).toEqual([]);
    expect(DEFAULT_WORKSPACE_POLICY.autoRemediation.production).toBe("none");
  });

  it("merges overrides over the defaults", () => {
    const resolved = resolveWorkspacePolicy({
      costApprovalThresholdUsd: 200,
      twoPersonProduction: true,
      approvedRegions: ["eu-west-1", "us-east-1"],
      budgetUsdMonthly: 5000,
      autoRemediation: { production: "safe" },
      deniedCapabilities: ["machine.exec"],
    });
    expect(resolved).toEqual({
      costApprovalThresholdUsd: 200,
      allowEscapeHatchInProduction: false,
      twoPersonProduction: true,
      approvedRegions: ["eu-west-1", "us-east-1"],
      budgetUsdMonthly: 5000,
      autoRemediation: { sandbox: "any", development: "any", staging: "safe", production: "safe" },
      deniedCapabilities: ["machine.exec"],
    });
  });

  it("merges autoRemediation per class rather than replacing the record", () => {
    expect(resolveWorkspacePolicy({ autoRemediation: { development: "none" } }).autoRemediation).toEqual({
      sandbox: "any",
      development: "none",
      staging: "safe",
      production: "none",
    });
  });

  it("canonicalises lists so equal policies have equal digests", () => {
    const a = resolveWorkspacePolicy({ approvedRegions: ["us-east-1", "eu-west-1", "us-east-1"], deniedCapabilities: ["provider.native", "machine.exec", "machine.exec"] });
    const b = resolveWorkspacePolicy({ approvedRegions: ["eu-west-1", "us-east-1"], deniedCapabilities: ["machine.exec", "provider.native"] });
    expect(a).toEqual(b);
    expect(digest(a)).toBe(digest(b));
    expect(a.approvedRegions).toEqual(["eu-west-1", "us-east-1"]);
  });

  it("treats null as clearing an optional field", () => {
    const resolved = resolveWorkspacePolicy({ approvedRegions: null, budgetUsdMonthly: null });
    expect(resolved).not.toHaveProperty("approvedRegions");
    expect(resolved).not.toHaveProperty("budgetUsdMonthly");
  });

  it("produces parameters the engine's schema accepts", () => {
    expect(WorkspacePolicyParamsSchema.safeParse(resolveWorkspacePolicy({ approvedRegions: ["us-east-1"], budgetUsdMonthly: 1 })).success).toBe(true);
  });

  describe("invalid configuration is refused, not corrected", () => {
    const cases: [string, unknown, RegExp][] = [
      ["an unknown key", { costApprovalThreshold: 10 }, /costApprovalThreshold|Unrecognized/i],
      ["a negative threshold", { costApprovalThresholdUsd: -1 }, /costApprovalThresholdUsd/],
      ["a non-finite threshold", { costApprovalThresholdUsd: Number.NaN }, /costApprovalThresholdUsd/],
      ["a threshold as a string", { costApprovalThresholdUsd: "50" }, /costApprovalThresholdUsd/],
      ["a zero budget", { budgetUsdMonthly: 0 }, /budgetUsdMonthly/],
      ["an empty approved-region list", { approvedRegions: [] }, /approvedRegions.*at least one region/],
      ["a region with bad characters", { approvedRegions: ["us east 1"] }, /approvedRegions/],
      ["an upper-case region", { approvedRegions: ["US-EAST-1"] }, /approvedRegions/],
      ["an unknown auto-remediation mode", { autoRemediation: { production: "yolo" } }, /autoRemediation/],
      ["an unknown environment class", { autoRemediation: { qa: "any" } }, /autoRemediation/],
      ["a non-boolean flag", { twoPersonProduction: "yes" }, /twoPersonProduction/],
      ["an unknown denied capability (a typo would deny nothing)", { deniedCapabilities: ["machine.exce"] }, /unknown capability name.*machine\.exce/],
      ["a wildcard denied capability", { deniedCapabilities: ["machine.*"] }, /unknown capability/],
    ];

    it.each(cases)("%s", (_name, overrides, message) => {
      expect(() => resolveWorkspacePolicy(overrides as never)).toThrow(PolicyConfigError);
      expect(() => resolveWorkspacePolicy(overrides as never)).toThrow(message);
    });

    it("reports every issue at once", () => {
      try {
        resolveWorkspacePolicy({ costApprovalThresholdUsd: -1, budgetUsdMonthly: 0 } as never);
        expect.unreachable();
      } catch (error) {
        expect((error as PolicyConfigError).issues).toHaveLength(2);
        expect((error as PolicyConfigError).code).toBe("policy_config_invalid");
      }
    });
  });
});
