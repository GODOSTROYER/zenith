import { describe, expect, it } from "vitest";
import { normalizePlan, type ShowJson } from "@/lib/tofu/plan";
import { TOFU_VERSION } from "@/lib/tofu/types";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared/errors";
import { assertPlanTrustPolicies, assertTrustPolicy, TrustPolicyRefusedError, validateTrustPolicy, ALLOWED_TRUST_SERVICE_PRINCIPALS, type TrustPlanChange } from "@/lib/providers/aws/trust-guard";

const doc = (...Statement: unknown[]) => ({ Version: "2012-10-17", Statement });
const svc = (Service: unknown, Action: unknown = "sts:AssumeRole", extra: object = {}) => ({ Effect: "Allow", Principal: { Service }, Action, ...extra });
const OIDC = "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABCDEF0123456789ABCDEF0123456789";
const TF_REF = "${local.x_oidc_provider_arn}";

describe("validateTrustPolicy", () => {
  it("allows every approved service, as string or array, object or JSON text", () => {
    for (const s of ALLOWED_TRUST_SERVICE_PRINCIPALS) {
      expect(validateTrustPolicy(doc(svc(s)))).toEqual([]);
      expect(validateTrustPolicy(JSON.stringify(doc(svc([s]))))).toEqual([]);
    }
    expect(ALLOWED_TRUST_SERVICE_PRINCIPALS.has("ec2.amazonaws.com.cn")).toBe(true);
    expect(validateTrustPolicy({ Version: "2012-10-17", Statement: svc("lambda.amazonaws.com") })).toEqual([]);
    expect(validateTrustPolicy(doc(svc("lambda.amazonaws.com", ["sts:AssumeRole"], { Condition: { StringEquals: { "aws:SourceAccount": "1" } } })))).toEqual([]);
  });
  it("refuses outside principals", () => {
    const bad: unknown[] = [
      { Effect: "Allow", Principal: "*", Action: "sts:AssumeRole" },
      { Effect: "Allow", Principal: { AWS: "*" }, Action: "sts:AssumeRole" },
      { Effect: "Allow", Principal: { AWS: "arn:aws:iam::999999999999:root" }, Action: "sts:AssumeRole" },
      { Effect: "Allow", Principal: { AWS: ["arn:aws:iam::999999999999:role/x"] }, Action: "sts:AssumeRole" },
      { Effect: "Allow", Principal: { AWS: "999999999999" }, Action: "sts:AssumeRole" },
      { Effect: "Allow", Principal: { Federated: "accounts.google.com" }, Action: "sts:AssumeRoleWithWebIdentity" },
      { Effect: "Allow", Principal: { Federated: "arn:aws:iam::999999999999:oidc-provider/evil.example.com" }, Action: "sts:AssumeRoleWithWebIdentity" },
      { Effect: "Allow", NotPrincipal: { AWS: "arn:aws:iam::1:root" }, Action: "sts:AssumeRole" },
      svc("evil.example.com"),
      svc("amazonaws.com"),
      svc("lambda.amazonaws.com.evil.com"),
      svc(["lambda.amazonaws.com", "sns.amazonaws.com"]),
      { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com", AWS: "*" }, Action: "sts:AssumeRole" },
      { Effect: "Allow", Principal: {}, Action: "sts:AssumeRole" },
      { Effect: "Allow", Action: "sts:AssumeRole" },
      svc("lambda.amazonaws.com", "sts:*"),
      svc("lambda.amazonaws.com", "sts:AssumeRoleWithWebIdentity"),
      { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, NotAction: "sts:Foo" },
    ];
    for (const st of bad) expect(validateTrustPolicy(doc(st)), JSON.stringify(st)).not.toEqual([]);
  });
  it("checks every statement and treats Deny-only or empty documents as unsafe", () => {
    const outsider = { Effect: "Allow", Principal: { AWS: "arn:aws:iam::9:root" }, Action: "sts:AssumeRole" };
    const denyAll = { Effect: "Deny", Principal: { AWS: "*" }, Action: "sts:AssumeRole" };
    expect(validateTrustPolicy(doc(svc("lambda.amazonaws.com"), outsider))).not.toEqual([]);
    expect(validateTrustPolicy(doc(denyAll))).not.toEqual([]);
    expect(validateTrustPolicy(doc(svc("lambda.amazonaws.com"), denyAll))).toEqual([]);
    expect(validateTrustPolicy(doc({ Effect: "Deny", NotPrincipal: { AWS: "x" }, Action: "sts:AssumeRole" }))).not.toEqual([]);
    expect(validateTrustPolicy(doc())).not.toEqual([]);
    expect(validateTrustPolicy({ Version: "2012-10-17" })).not.toEqual([]);
    expect(validateTrustPolicy("{not json")).not.toEqual([]);
    expect(validateTrustPolicy(null)).not.toEqual([]);
    expect(validateTrustPolicy([])).not.toEqual([]);
    expect(validateTrustPolicy(doc({ Effect: "Maybe", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }))).not.toEqual([]);
  });
  it("allows only the EKS IRSA federated pattern with web-identity", () => {
    const irsa = (Federated: unknown, Action: unknown = "sts:AssumeRoleWithWebIdentity") => ({ Effect: "Allow", Principal: { Federated }, Action });
    expect(validateTrustPolicy(doc(irsa(OIDC)))).toEqual([]);
    expect(validateTrustPolicy(doc(irsa(OIDC, "sts:AssumeRole")))).not.toEqual([]);
    expect(validateTrustPolicy(doc(irsa(TF_REF)))).not.toEqual([]);
    expect(validateTrustPolicy(doc(irsa(TF_REF)), { allowTerraformReferences: true })).toEqual([]);
    expect(validateTrustPolicy(doc(irsa("${aws_iam_role.x.arn}")), { allowTerraformReferences: true })).not.toEqual([]);
  });
  it("throws DriverCompileError at compile time", () => {
    expect(() => assertTrustPolicy(doc(svc("lambda.amazonaws.com")), "a.b")).not.toThrow();
    expect(() => assertTrustPolicy(doc(svc("evil.example.com")), "a.b")).toThrow(DriverCompileError);
  });
});

const change = (over: Partial<TrustPlanChange> = {}): TrustPlanChange => ({
  address: "aws_iam_role.r", type: "aws_iam_role", action: "create",
  changes: [{ path: "name", after: "zenith-r" }, { path: "assume_role_policy", after: JSON.stringify(doc(svc("ecs-tasks.amazonaws.com"))) }],
  ...over,
});
const withPolicy = (action: string, after: unknown): TrustPlanChange => change({ action, changes: [{ path: "assume_role_policy", after }] });

describe("assertPlanTrustPolicies", () => {
  it("accepts a Zenith role and ignores other resources and deletes", () => {
    expect(() => assertPlanTrustPolicies({ resourceChanges: [change()] })).not.toThrow();
    expect(() => assertPlanTrustPolicies({ resourceChanges: [change({ action: "delete", changes: [] }), change({ type: "aws_s3_bucket", changes: [] })] })).not.toThrow();
    expect(() => assertPlanTrustPolicies({ resourceChanges: [change({ action: "update", changes: [{ path: "tags.x", after: "y" }] })] })).not.toThrow();
  });
  it("refuses a planted foreign trust on create, update and replace", () => {
    const evil = JSON.stringify(doc({ Effect: "Allow", Principal: { AWS: "arn:aws:iam::999999999999:root" }, Action: "sts:AssumeRole" }));
    for (const action of ["create", "update", "replace"]) {
      expect(() => assertPlanTrustPolicies({ resourceChanges: [withPolicy(action, evil)] })).toThrow(TrustPolicyRefusedError);
    }
  });
  it("refuses unknown, masked, missing and malformed policies", () => {
    for (const after of ["(known after apply)", "(sensitive)", null, "", "{"]) {
      expect(() => assertPlanTrustPolicies({ resourceChanges: [withPolicy("create", after)] }), String(after)).toThrow(TrustPolicyRefusedError);
    }
    expect(() => assertPlanTrustPolicies({ resourceChanges: [change({ changes: [{ path: "name", after: "x" }] })] })).toThrow(TrustPolicyRefusedError);
  });
});

describe("assertPlanTrustPolicies on a normalized tofu plan", () => {
  const plan = (rcs: unknown[]) => normalizePlan({ format_version: "1.2", terraform_version: TOFU_VERSION, resource_changes: rcs } as ShowJson, {
    configDigest: "c".repeat(64), lockDigest: "l".repeat(64), addressMap: {}, fingerprintKey: "k",
  });
  const role = (after: Record<string, unknown>, after_unknown: Record<string, unknown> = {}) => ({
    address: "aws_iam_role.r", type: "aws_iam_role", name: "r", provider_name: "registry.opentofu.org/hashicorp/aws",
    change: { actions: ["create"], before: null, after, after_unknown, before_sensitive: false, after_sensitive: {} },
  });
  it("passes a Zenith plan and refuses planted or computed trust", () => {
    const ok = JSON.stringify(doc(svc("lambda.amazonaws.com")));
    const evil = JSON.stringify(doc({ Effect: "Allow", Principal: { AWS: "arn:aws:iam::999999999999:root" }, Action: "sts:AssumeRole" }));
    expect(() => assertPlanTrustPolicies(plan([role({ name: "z", assume_role_policy: ok })]))).not.toThrow();
    expect(() => assertPlanTrustPolicies(plan([role({ name: "z", assume_role_policy: evil })]))).toThrow(TrustPolicyRefusedError);
    expect(() => assertPlanTrustPolicies(plan([role({ name: "z" }, { assume_role_policy: true })]))).toThrow(/not known until apply/);
  });
});
