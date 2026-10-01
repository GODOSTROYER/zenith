/**
 * Local IAM boundary checks only; no AWS authorization claim. Unsupported
 * condition operators throw rather than silently ignoring a Deny; explicit
 * Deny wins over any Allow. Context values are scalar in these fixtures.
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
        const values = asList(expected).map(String);
        if (operator === "StringEquals" || operator === "ArnEquals") return actual !== undefined && values.includes(actual);
        if (operator === "StringLike" || operator === "ArnLike") return actual !== undefined && values.some((pattern) => iamGlob(pattern, actual));
        // IAM negation matches missing keys too; IfExists in a negated Deny
        // does not turn a missing PassedToService into a PassRole exemption.
        if (operator === "StringNotEqualsIfExists") return actual === undefined || !values.includes(actual);
        if (operator === "ArnNotLike") return actual === undefined || !values.some((pattern) => iamGlob(pattern, actual));
        throw new Error(`Unsupported boundary condition operator: ${operator}`);
      })
    );
  return !statements.some((s) => s.Effect === "Deny" && matches(s)) && statements.some((s) => s.Effect === "Allow" && matches(s));
}
