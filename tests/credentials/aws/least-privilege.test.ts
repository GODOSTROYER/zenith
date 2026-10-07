/**
 * Least-privilege diff: compiled bootstrap policy versus the actions the compiler
 * uses. Static and offline. The diff never widens a policy; known gaps are pinned
 * in deploy/aws/tools/least-privilege-baseline.json so any NEW gap or NEW unused
 * sensitive grant fails here and needs review.
 */
import { describe, expect, it } from "vitest";
import { actionMatches, allowedActionsOf, diffAgainstCompilerActions, isReadAction } from "@/lib/credentials/aws/least-privilege";
import { COMPILER_RESOURCE_ACTIONS, COMPILER_RUNTIME_ACTIONS, usedActionsForResourceTypes, usedRuntimeActions } from "@/lib/credentials/aws/compiler-actions";
import {
  BASELINE_PATH, buildBaseline, compareToBaseline, computeLeastPrivilegeReport, grantedDeployActions, readBaseline, runCli, scanDriverResourceTypes,
} from "../../../deploy/aws/tools/least-privilege-diff";
import { compiled } from "../../providers/aws/drivers/_integration";
import fs from "node:fs";

describe("actionMatches", () => {
  it.each([
    ["ec2:Describe*", "ec2:DescribeVpcs", true], ["ec2:Describe*", "ec2:CreateVpc", false], ["EC2:createvpc", "ec2:CreateVpc", true],
    ["s3:Get?bject", "s3:GetObject", true], ["s3:*", "s3:PutObject", true], ["s3:*", "iam:PassRole", false], ["iam:PassRole", "iam:PassRoleX", false],
    ["ec2:Create.Vpc", "ec2:CreateXVpc", false],
  ])("%s vs %s", (pattern, action, expected) => expect(actionMatches(pattern, action)).toBe(expected));
  it("never matches oversized input", () => expect(actionMatches("a:".padEnd(300, "*"), "a:b")).toBe(false));
});

describe("diffAgainstCompilerActions", () => {
  const used = [{ action: "ec2:CreateVpc", via: ["aws_vpc"] }, { action: "ec2:CreateTags", via: ["aws_vpc", "aws_subnet"] }, { action: "iam:PassRole", via: ["aws_instance"] }];

  it("reports needed-but-ungranted actions with the resource types that need them", () => {
    const report = diffAgainstCompilerActions(["ec2:CreateVpc", "ec2:CreateTags"], used);
    expect(report.missing).toEqual([{ action: "iam:PassRole", via: ["aws_instance"] }]);
    expect(report.unused).toEqual([]);
  });
  it("treats wildcard grants as covering and does not flag a wildcard that matches a needed action", () => {
    const report = diffAgainstCompilerActions(["ec2:Create*", "iam:PassRole"], used);
    expect(report.missing).toEqual([]);
    expect(report.unused).toEqual([]);
  });
  it("reports unused write grants, separates sensitive ones, and ignores read verbs", () => {
    const report = diffAgainstCompilerActions(["ec2:CreateVpc", "ec2:CreateTags", "iam:PassRole", "ec2:DeleteVpc", "iam:CreatePolicy", "kms:CreateGrant", "ec2:Describe*", "s3:GetObject"], used);
    expect(report.missing).toEqual([]);
    expect(report.unused).toEqual(["ec2:DeleteVpc", "iam:CreatePolicy", "kms:CreateGrant"].sort());
    expect(report.unusedSensitive).toEqual(["iam:CreatePolicy", "kms:CreateGrant"]);
  });
  it("is deterministic regardless of input order and merges duplicate needs", () => {
    const a = diffAgainstCompilerActions(["b:Put", "a:Put"], [{ action: "c:Put", via: ["x"] }, { action: "c:Put", via: ["y"] }]);
    const b = diffAgainstCompilerActions(["a:Put", "b:Put"], [{ action: "c:Put", via: ["y", "x"] }]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.missing).toEqual([{ action: "c:Put", via: ["x", "y"] }]);
  });
  it.each(["*", "ec2", "ec2:", ":Create", "ec2:Create Vpc", "ec2:Create/Vpc"])("refuses the malformed granted action %j", (action) => {
    expect(() => diffAgainstCompilerActions([action], used)).toThrow(/invalid action/);
  });
  it("classifies read verbs", () => {
    expect(isReadAction("ec2:DescribeVpcs")).toBe(true);
    expect(isReadAction("s3:GetObject")).toBe(true);
    expect(isReadAction("s3:PutObject")).toBe(false);
  });
});

describe("allowedActionsOf", () => {
  it("collects Allow actions only, from lists and scalars, ignoring Deny and NotAction", () => {
    expect(allowedActionsOf({ Version: "2012-10-17", Statement: [
      { Effect: "Allow", Action: ["b:X", "a:Y"], Resource: "*" }, { Effect: "Allow", Action: "c:Z", Resource: "*" },
      { Effect: "Deny", Action: "d:Q", Resource: "*" }, { Effect: "Allow", NotAction: "e:R", Resource: "*" },
    ] })).toEqual(["a:Y", "b:X", "c:Z"]);
    expect(allowedActionsOf(JSON.stringify({ Statement: { Effect: "Allow", Action: "x:Y", Resource: "*" } }))).toEqual(["x:Y"]);
  });
});

describe("compiler action catalogue", () => {
  it("covers exactly the aws resource types the AWS drivers emit (no missing, no stale entries)", () => {
    expect(Object.keys(COMPILER_RESOURCE_ACTIONS).sort()).toEqual(scanDriverResourceTypes());
  });
  it("covers every resource type of the compiled production and staging fixtures", () => {
    for (const envClass of ["production", "staging"] as const) {
      const { fragments } = compiled(envClass);
      const types = [...fragments.values()].flatMap((fragment) => Object.keys(fragment.resource ?? {}));
      expect(types.length).toBeGreaterThan(10);
      expect(usedActionsForResourceTypes(types).uncatalogued, envClass).toEqual([]);
    }
  });
  it("lists only well-formed actions and keeps runtime labels distinct from resource types", () => {
    for (const actions of [...Object.values(COMPILER_RESOURCE_ACTIONS), ...Object.values(COMPILER_RUNTIME_ACTIONS)]) {
      for (const action of actions) expect(action).toMatch(/^[a-z0-9-]+:[A-Za-z0-9]+$/);
    }
    for (const label of Object.keys(COMPILER_RUNTIME_ACTIONS)) expect(label.startsWith("runtime:")).toBe(true);
    expect(usedRuntimeActions().length).toBeGreaterThan(5);
  });
  it("reports an unknown aws resource type instead of silently ignoring it, and skips non-aws types", () => {
    expect(usedActionsForResourceTypes(["aws_brand_new_thing", "random_id", "terraform_data"]).uncatalogued).toEqual(["aws_brand_new_thing"]);
  });
});

describe("compiled deploy policy versus compiler actions", () => {
  const result = computeLeastPrivilegeReport();
  const baseline = readBaseline();

  it("evaluates a substantial granted set from the CloudFormation template without any wildcard-only grant", () => {
    const granted = grantedDeployActions();
    expect(granted.length).toBeGreaterThan(200);
    expect(granted).not.toContain("*");
    expect(granted.some((action) => action.endsWith(":*"))).toBe(false);
    expect(granted).toContain("route53:ChangeResourceRecordSets");
  });

  it("introduces no new needed-but-ungranted action beyond the reviewed baseline, and the baseline has no stale entries", () => {
    const comparison = compareToBaseline(result.report, baseline);
    expect(comparison.newMissing, "new gaps: fix the driver or review a bootstrap change; do not just widen").toEqual([]);
    expect(comparison.staleMissing, "remove from the baseline").toEqual([]);
  });

  it("grants no sensitive-service write action that the compiler never uses, beyond the reviewed baseline", () => {
    expect(compareToBaseline(result.report, baseline).newUnusedSensitive).toEqual([]);
  });

  it("never reports an action the compiler needs as unused (consistency of the diff itself)", () => {
    const needed = new Set([...usedActionsForResourceTypes(result.resourceTypes).used, ...usedRuntimeActions()].map((item) => item.action));
    for (const action of result.report.unused) expect(needed.has(action)).toBe(false);
  });

  it("records an owner note and status for every known gap", () => {
    for (const [action, entry] of Object.entries(baseline.knownMissing)) {
      expect(["gap_to_triage", "denied_by_design"], action).toContain(entry.status);
      expect(entry.note.length, action).toBeGreaterThan(20);
      expect(entry.via.length, action).toBeGreaterThan(0);
    }
  });

  it("rebuilding the baseline from the report preserves reviewed status and notes", () => {
    const rebuilt = buildBaseline(result.report, baseline);
    expect(Object.keys(rebuilt.knownMissing).sort()).toEqual(Object.keys(baseline.knownMissing).sort());
    for (const [action, entry] of Object.entries(rebuilt.knownMissing)) expect(entry.note).toBe(baseline.knownMissing[action].note);
  });

  it("the --check command exits zero when nothing drifted", () => {
    const original = console.log;
    console.log = () => undefined;
    try { expect(runCli(["--check"])).toBe(0); } finally { console.log = original; }
  });

  it("the committed baseline is valid JSON in the expected shape", () => {
    const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as { version: number; knownMissing: object; allowedUnusedSensitive: string[] };
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.allowedUnusedSensitive)).toBe(true);
  });
});
