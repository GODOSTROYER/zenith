/** Static IAM contracts: these checks do not exercise AWS authorization. */
import { describe, expect, it } from "vitest";
import { sessionPolicyFor, validateSessionPolicy } from "@/lib/credentials/aws";
import { generate, TEMPLATE_PATH } from "../../../../../deploy/aws/tools/generate-tofu-policies";
import { actionCovers, asList, iamGlob, loadTemplate, makeEvaluator, resolveResource, statementsOf, type Statement } from "../../../../credentials/cfn";

const ACCOUNT = "123456789012";
const ACTIONS = ["eks:DescribeCluster", "eks:ListNodegroups", "eks:DescribeNodegroup", "eks:ListTagsForResource"];
const template = loadTemplate(TEMPLATE_PATH);
const allows = (statements: Statement[], action: string, arn: string) => statements.some((s) => s.Effect === "Allow"
  && asList(s.Action).some((a) => actionCovers(a, action)) && asList(s.Resource).some((resource) => iamGlob(resource, arn)));

describe("EKS read IAM scopes", () => {
  it.each(["aws", "aws-cn", "aws-us-gov"] as const)("keeps %s EKS reads within this account's Zenith resources", (partition) => {
    const policy = sessionPolicyFor("infrastructure.observe", { accountId: ACCOUNT, region: "ap-south-1", partition })!;
    expect(validateSessionPolicy(policy).length).toBeLessThanOrEqual(2048);
    const evaluator = makeEvaluator(template, { pseudo: { accountId: ACCOUNT, partition, region: "ap-south-1" } });
    const bootstrap = statementsOf(resolveResource(template, evaluator, "ObservePolicy")!.PolicyDocument);
    for (const statements of [statementsOf(policy), bootstrap]) {
      for (const action of ACTIONS) {
        const kind = action === "eks:DescribeNodegroup" ? "nodegroup/zenith-test/apps-nodes/abc-123" : "cluster/zenith-test";
        const arn = `arn:${partition}:eks:ap-south-1:${ACCOUNT}:${kind}`;
        expect(allows(statements, action, arn), `${action} on ${arn}`).toBe(true);
        expect(allows(statements, action, arn.replace(ACCOUNT, "999999999999"))).toBe(false);
        expect(allows(statements, action, arn.replace("zenith-test", "unrelated"))).toBe(false);
        expect(statements.some((s) => asList(s.Action).includes(action))).toBe(true);
      }
      const arn = `arn:${partition}:eks:ap-south-1:${ACCOUNT}:cluster/zenith-test`;
      for (const action of ["eks:UpdateClusterConfig", "eks:DeleteCluster", "eks:UpdateNodegroupConfig", "eks:TagResource"]) expect(allows(statements, action, arn)).toBe(false);
    }
  });
  it("generates the same read actions in the OpenTofu observe policy", () => {
    const statements = statementsOf(JSON.parse(generate()["observe.json.tftpl"]));
    for (const action of ACTIONS) expect(statements.some((s) => asList(s.Action).includes(action))).toBe(true);
    const scoped = statements.filter((s) => asList(s.Action).some((a) => ACTIONS.includes(a)));
    expect(scoped.every((s) => !asList(s.Resource).includes("*"))).toBe(true);
  });
});
