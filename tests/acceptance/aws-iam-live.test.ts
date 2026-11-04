/**
 * Live commercial IAM permission acceptance (scripts/acceptance/aws-iam-permissions.ts).
 *
 * Two kinds of test live here and are labeled so nobody mistakes one for the other:
 *   - CONTRACT-LEVEL: the harness logic driven by a MODELED IAM port. No cloud call.
 *   - LIVE: runs only with ZENITH_LIVE_AWS_IAM=1 plus a credentials FILE reference, against
 *     the account its owner names. Without that gate the live test is reported as SKIPPED
 *     with an explicit reason and is never counted as passed.
 */
import { describe, expect, it } from "vitest";
import {
  IAM_EXIT, buildIamProbes, checkLiveReadback, evaluateProbe, maximumRoleName, readIamAcceptanceConfig, runIamAcceptance, runIamAcceptanceCli,
  type IamAcceptanceConfig, type IamPort, type SimulatedDecision,
} from "../../scripts/acceptance/aws-iam-permissions";
import { BASELINE_PATH, readBaseline, scanDriverResourceTypes } from "../../deploy/aws/tools/least-privilege-diff";
import { AWS_ROLE_BOUNDARIES } from "@/lib/credentials/aws/naming";

const ACCOUNT = "123456789012";
const baseEnv = {
  ZENITH_LIVE_AWS_IAM: "1", ZENITH_LIVE_AWS_ACCOUNT_ID: ACCOUNT, ZENITH_LIVE_REGION: "us-east-1",
  ZENITH_LIVE_AWS_DEPLOY_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/ZenithDeployRole-team-a`, ZENITH_LIVE_AWS_NAME_SUFFIX: "-team-a",
  ZENITH_LIVE_AWS_CREDENTIALS_FILE: "/modeled/credentials-file",
};
const exists = () => true;
const config: IamAcceptanceConfig = (() => {
  const outcome = readIamAcceptanceConfig(baseEnv, exists);
  if (outcome.kind !== "ready") throw new Error("fixture");
  return outcome.config;
})();

describe("CONTRACT-LEVEL: gating", () => {
  it("is skipped with an explicit reason, and a distinct exit code, when the flag is not set", async () => {
    const lines: string[] = [];
    const code = await runIamAcceptanceCli([], {}, { out: (t) => lines.push(t), err: (t) => lines.push(t) }, {
      createPort: () => { throw new Error("must not build a port"); }, resourceTypes: () => [], baseline: () => ({ knownMissing: {}, allowedUnusedSensitive: [] }),
    });
    expect(code).toBe(IAM_EXIT.skipped);
    expect(code).not.toBe(IAM_EXIT.passed);
    expect(lines.join("\n")).toMatch(/ZENITH_LIVE_AWS_IAM=1 is not set/);
  });

  it.each([
    [{ ZENITH_LIVE_AWS_ACCOUNT_ID: undefined }, /missing: ZENITH_LIVE_AWS_ACCOUNT_ID/],
    [{ ZENITH_LIVE_AWS_CREDENTIALS_FILE: undefined }, /missing: ZENITH_LIVE_AWS_CREDENTIALS_FILE/],
    [{ ZENITH_LIVE_REGION: "cn-north-1" }, /commercial region/],
    [{ ZENITH_LIVE_REGION: "us-gov-west-1" }, /commercial region/],
    [{ ZENITH_LIVE_AWS_DEPLOY_ROLE_ARN: `arn:aws-cn:iam::${ACCOUNT}:role/ZenithDeployRole` }, /commercial aws partition/],
    [{ ZENITH_LIVE_AWS_DEPLOY_ROLE_ARN: `arn:aws-us-gov:iam::${ACCOUNT}:role/ZenithDeployRole` }, /commercial aws partition/],
    [{ ZENITH_LIVE_AWS_DEPLOY_ROLE_ARN: "arn:aws:iam::210987654321:role/ZenithDeployRole" }, /not in ZENITH_LIVE_AWS_ACCOUNT_ID/],
    [{ ZENITH_LIVE_AWS_NAME_SUFFIX: "BAD" }, /not a valid bootstrap suffix/],
    [{ ZENITH_LIVE_AWS_CREDENTIALS_FILE: "relative/path" }, /absolute path/],
    [{ AWS_ACCESS_KEY_ID: "present" }, /only credential source/],
    [{ AWS_SESSION_TOKEN: "present" }, /only credential source/],
    [{ ZENITH_LIVE_AWS_PROFILE: "bad profile!" }, /valid profile/],
  ])("refuses %j", (over, message) => {
    const outcome = readIamAcceptanceConfig({ ...baseEnv, ...over }, exists);
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(JSON.stringify(outcome)).toMatch(message);
  });

  it("refuses a credentials file that does not exist without reading it", () => {
    expect(readIamAcceptanceConfig(baseEnv, () => false)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/existing file/) });
  });

  it("never echoes the credentials file path in a ready config's refusal text or evidence summary", () => {
    const outcome = readIamAcceptanceConfig({ ...baseEnv, ZENITH_LIVE_REGION: "cn-north-1" }, exists);
    expect(JSON.stringify(outcome)).not.toContain("/modeled/credentials-file");
  });
});

describe("CONTRACT-LEVEL: probe table", () => {
  const probes = buildIamProbes(config);

  it("builds a maximum-length role-name probe for every reserved suffix of every family, each with its own suffixed boundary", () => {
    const creates = probes.filter((p) => p.id.startsWith("create-role-") && p.id.endsWith("maximum-name-with-saved-suffix"));
    const expected = Object.values(AWS_ROLE_BOUNDARIES).reduce((n, family) => n + family.suffixes.length, 0);
    expect(creates).toHaveLength(expected);
    for (const probe of creates) {
      const name = probe.resourceArn.slice(probe.resourceArn.lastIndexOf("/") + 1);
      expect(name).toHaveLength(64);
      expect(probe.expect).toBe("allowed");
      expect(probe.context["iam:PermissionsBoundary"]).toMatch(new RegExp(`^arn:aws:iam::${ACCOUNT}:policy/Zenith\\w+Boundary-team-a$`));
    }
  });

  it("covers the negative probes that pin 'no widening'", () => {
    const ids = new Set(probes.map((p) => p.id));
    for (const id of ["create-role-foreign-suffix-boundary", "create-role-legacy-boundary", "create-role-without-boundary", "create-role-without-managed-tag", "pass-role-foreign-role", "create-user", "create-access-key", "create-oidc-provider", "modify-deploy-role-policy", "attach-unlisted-managed-policy", "read-secret-value", "delete-state-bucket"]) expect(ids.has(id), id).toBe(true);
    for (const probe of probes.filter((p) => ["create-user", "read-secret-value", "delete-state-bucket"].includes(p.id))) expect(probe.expect).toBe("not_allowed");
  });

  it("only uses commercial partition ARNs", () => {
    for (const probe of probes) expect(probe.resourceArn).toMatch(/^arn:aws:/);
  });

  it("maximumRoleName is exactly the IAM maximum and keeps the reserved suffix", () => {
    expect(maximumRoleName("-nodes")).toHaveLength(64);
    expect(maximumRoleName("-nodes").endsWith("-nodes")).toBe(true);
    expect(maximumRoleName("-role").startsWith("zenith-")).toBe(true);
  });

  it("evaluates allow and deny expectations", () => {
    const allow = probes.find((p) => p.expect === "allowed")!;
    const deny = probes.find((p) => p.expect === "not_allowed")!;
    expect(evaluateProbe(allow, "allowed").ok).toBe(true);
    expect(evaluateProbe(allow, "implicitDeny").ok).toBe(false);
    expect(evaluateProbe(deny, "explicitDeny").ok).toBe(true);
    expect(evaluateProbe(deny, "implicitDeny").ok).toBe(true);
    expect(evaluateProbe(deny, "allowed").ok).toBe(false);
  });
});

describe("CONTRACT-LEVEL: orchestration against a MODELED IAM port (not live)", () => {
  const baseline = readBaseline(BASELINE_PATH);
  const types = scanDriverResourceTypes();
  const modeled = (over: Partial<IamPort> = {}): IamPort => ({
    callerAccountId: async () => ACCOUNT,
    attachedPolicyDocuments: async () => [{ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["ec2:CreateVpc"], Resource: "*" }] }],
    simulate: async ({ action }) => (probeExpectations.get(action) ?? "implicitDeny"),
    ...over,
  });
  const probeExpectations = new Map<string, SimulatedDecision>(buildIamProbes(config).filter((p) => p.expect === "allowed").map((p) => [p.action, "allowed"]));

  it("refuses when the credentials belong to another account, before any readback", async () => {
    let read = false;
    const report = await runIamAcceptance(config, modeled({ callerAccountId: async () => "210987654321", attachedPolicyDocuments: async () => { read = true; return []; } }), types, baseline);
    expect(report.status).toBe("refused");
    expect(read).toBe(false);
  });

  it("fails when the modeled live policy is missing needed actions beyond the reviewed baseline", async () => {
    const report = await runIamAcceptance(config, modeled(), types, baseline);
    expect(report.status).toBe("failed");
    expect(report.readback?.newMissing.length).toBeGreaterThan(0);
  });

  it("checkLiveReadback reports a new sensitive grant", () => {
    const docs = [{ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["iam:CreateAccessKey", "iam:CreateRole"], Resource: "*" }] }];
    const check = checkLiveReadback(docs, [], baseline);
    expect(check.newUnusedSensitive).toEqual(["iam:CreateAccessKey", "iam:CreateRole"]);
  });

  it("fails when IAM allows a probe that must be denied (widened privilege)", async () => {
    const report = await runIamAcceptance(config, modeled({ simulate: async () => "allowed" }), [], baseline);
    expect(report.status).toBe("failed");
    expect(report.probes.filter((p) => !p.ok).map((p) => p.id)).toContain("create-user");
  });
});

const live = process.env.ZENITH_LIVE_AWS_IAM === "1";
// Without the gate this whole block is SKIPPED (deferred): it is never reported as passed.
describe.skipIf(!live)("LIVE commercial IAM acceptance (skipped unless ZENITH_LIVE_AWS_IAM=1; deferred, not counted as passed)", () => {
  it("passes every readback and policy-simulator probe against the named sandbox account", async () => {
    const { main } = await import("../../scripts/acceptance/aws-iam-permissions-cli");
    expect(await main([])).toBe(IAM_EXIT.passed);
  }, 300_000);
});
