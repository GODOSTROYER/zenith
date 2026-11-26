/**
 * The customer bootstrap must not hand Zenith (or roles Zenith creates) other workloads' secrets:
 * secret-bearing reads on non-Zenith resources, RDS-managed master passwords and IAM database logins.
 */
import { describe, expect, it } from "vitest";
import { TEMPLATE_PATH } from "../../deploy/aws/tools/generate-tofu-policies";
import { actionCovers, asList, loadTemplate, makeEvaluator, resolveResource, statementsOf, type Statement } from "./cfn";
import { ACCOUNT } from "./helpers";

const template = loadTemplate(TEMPLATE_PATH);
const BASE = { ZenithIssuerHost: "app.tryzenith.cloud/api/oidc", ZenithOidcSubject: "zenith:ws:ws_1:conn:conn_1" };

function statements(logicalId: string, params: Record<string, string> = {}): Statement[] {
  const ev = makeEvaluator(template, { params: { ...BASE, ...params }, pseudo: { partition: "aws", accountId: ACCOUNT, region: "eu-west-1" } });
  return statementsOf(resolveResource(template, ev, logicalId)!.PolicyDocument);
}

/** Allow statements granting `action` on any resource that is not Zenith's (Resource "*" or a non-zenith ARN). */
function unscopedAllows(all: Statement[], action: string): string[] {
  return all
    .filter((s) => s.Effect === "Allow" && asList(s.Action).some((a) => actionCovers(a, action)))
    .filter((s) => asList(s.Resource).some((r) => r === "*" || !/(:|\/)zenith-\*/.test(r)))
    .map((s) => String(s.Sid));
}

const SECRET_BEARING = [
  "lambda:GetFunctionConfiguration", "lambda:ListFunctions", "lambda:ListVersionsByFunction",
  "codebuild:BatchGetProjects", "codebuild:BatchGetBuilds", "codebuild:BatchGetBuildBatches",
];

describe("observe role: secret-bearing reads", () => {
  it("AllowAccountDiscovery is a yes/no parameter that defaults to no", () => {
    const p = template.Parameters.AllowAccountDiscovery;
    expect(p.Default).toBe("no");
    expect(p.AllowedValues).toEqual(["yes", "no"]);
  });

  it.each(SECRET_BEARING)("%s has no unscoped Allow by default", (action) => {
    expect(unscopedAllows(statements("ObservePolicy"), action)).toEqual([]);
  });

  it("allows Lambda and CodeBuild configuration reads only for zenith-* resources by default", () => {
    const all = statements("ObservePolicy");
    for (const action of SECRET_BEARING.filter((a) => a !== "lambda:ListFunctions")) {
      const granting = all.filter((s) => s.Effect === "Allow" && asList(s.Action).some((a) => actionCovers(a, action)));
      for (const s of granting) for (const r of asList(s.Resource)) expect(r, `${action} in ${s.Sid}`).toMatch(/(function:|project\/)zenith-\*/);
    }
    expect(all.some((s) => s.Sid === "AccountDiscovery")).toBe(false);
  });

  it("AllowAccountDiscovery=yes adds exactly one explicit, account-wide statement", () => {
    const all = statements("ObservePolicy", { AllowAccountDiscovery: "yes" });
    const discovery = all.filter((s) => s.Sid === "AccountDiscovery");
    expect(discovery).toHaveLength(1);
    expect(discovery[0].Effect).toBe("Allow");
    expect(asList(discovery[0].Action).sort()).toEqual(["codebuild:BatchGetProjects", "lambda:GetFunctionConfiguration", "lambda:ListFunctions"]);
    expect(unscopedAllows(all, "lambda:ListFunctions")).toEqual(["AccountDiscovery"]);
  });

  it("denies ec2:DescribeInstanceAttribute (user data) on instances Zenith did not tag", () => {
    const all = statements("ObservePolicy");
    const deny = all.find((s) => s.Sid === "DenyInstanceAttributesOfOtherInstances")!;
    expect(deny.Effect).toBe("Deny");
    expect(asList(deny.Action)).toEqual(["ec2:DescribeInstanceAttribute"]);
    expect(deny.Resource).toBe(`arn:aws:ec2:*:${ACCOUNT}:instance/*`);
    expect(deny.Condition).toEqual({ StringNotEquals: { "aws:ResourceTag/zenith:managed": "true" } });
    // The wildcard that includes the action is still there; the deny is what removes it.
    expect(all.some((s) => s.Effect === "Allow" && asList(s.Action).includes("ec2:Describe*"))).toBe(true);
  });

  it("the discovery opt-in does not weaken the instance attribute deny", () => {
    expect(statements("ObservePolicy", { AllowAccountDiscovery: "yes" }).some((s) => s.Sid === "DenyInstanceAttributesOfOtherInstances")).toBe(true);
  });
});

describe("AppBoundary: database credentials", () => {
  const all = statements("AppBoundary");
  const secretGrants = all.filter((s) => s.Effect === "Allow" && asList(s.Action).includes("secretsmanager:GetSecretValue"));

  it("reads RDS-managed master secrets only when the secret belongs to a zenith-* DB instance", () => {
    const rds = secretGrants.filter((s) => asList(s.Resource).some((r) => r.includes("secret:rds!")));
    expect(rds).toHaveLength(1);
    // Needs real-AWS validation: aws:rds:primaryDBInstanceArn is the documented-by-observation system tag on rds!db secrets.
    expect(rds[0].Condition?.ArnLike?.["aws:ResourceTag/aws:rds:primaryDBInstanceArn"]).toBe(`arn:aws:rds:*:${ACCOUNT}:db:zenith-*`);
    expect(rds[0].Condition?.ArnLike?.["aws:PrincipalArn"]).toBeDefined();
  });

  it("no Allow still pairs rds!db-* secrets with an unconditioned statement", () => {
    for (const s of secretGrants) {
      const hasRds = asList(s.Resource).some((r) => r.includes("secret:rds!"));
      if (hasRds) expect(JSON.stringify(s.Condition)).toContain("aws:ResourceTag/aws:rds:primaryDBInstanceArn");
    }
    const generic = secretGrants.filter((s) => !asList(s.Resource).some((r) => r.includes("secret:rds!")));
    expect(generic.flatMap((s) => asList(s.Resource))).toEqual([`arn:aws:secretsmanager:*:${ACCOUNT}:secret:zenith/*`]);
  });

  it("rds-db:connect is limited to databases tagged zenith:managed=true", () => {
    const connect = all.filter((s) => s.Effect === "Allow" && asList(s.Action).includes("rds-db:connect"));
    expect(connect).toHaveLength(1);
    expect(connect[0].Condition?.StringEquals).toEqual({ "aws:ResourceTag/zenith:managed": "true" });
  });
});
