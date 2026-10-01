/**
 * Local IAM boundary checks only; no AWS authorization claim. Unsupported
 * condition operators fail closed, and explicit Deny wins over any Allow.
 */
import { asList, iamGlob, loadTemplate, makeEvaluator, resolveResource, statementsOf, type Statement } from "./cfn";
import { TEMPLATE_PATH } from "../../deploy/aws/tools/generate-tofu-policies";

export function workloadBoundary(partition = "aws", accountId = "123456789012"): Statement[] {
  const template = loadTemplate(TEMPLATE_PATH);
  const evaluator = makeEvaluator(template, { pseudo: { partition, accountId, region: "eu-west-1" } });
  return statementsOf(resolveResource(template, evaluator, "WorkloadBoundary")!.PolicyDocument);
}

export function boundaryAllows(statements: Statement[], action: string, resource: string, context: Record<string, string> = {}): boolean {
  const matches = (statement: Statement) =>
    asList(statement.Action).some((pattern) => iamGlob(pattern.toLowerCase(), action.toLowerCase())) &&
    asList(statement.Resource).some((pattern) => iamGlob(pattern, resource)) &&
    Object.entries(statement.Condition ?? {}).every(([operator, entries]) =>
      Object.entries(entries).every(([key, expected]) => {
        const actual = context[key];
        if (actual === undefined) return false;
        const values = asList(expected).map(String);
        if (operator === "StringEquals" || operator === "ArnEquals") return values.includes(actual);
        if (operator === "StringLike" || operator === "ArnLike") return values.some((pattern) => iamGlob(pattern, actual));
        return false;
      })
    );
  return !statements.some((s) => s.Effect === "Deny" && matches(s)) && statements.some((s) => s.Effect === "Allow" && matches(s));
}
