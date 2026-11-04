/** Resolve only the fixture's known OpenTofu expressions for local IAM checks. */
import type { TofuFragment } from "@/lib/drivers/types";
import { asList, statementsOf } from "../../../../credentials/cfn";

export const BOUNDARY_ACCOUNT = "123456789012";
export const BOUNDARY_PREFIX = "zenith-env-1";

export function policyRequests(fragment: TofuFragment, refs: Record<string, string> = {}, partition = "aws"): { action: string; resource: string; context: Record<string, string> }[] {
  const resolve = (value: string): string => value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    if (expr in refs) return refs[expr];
    const trim = /^trimsuffix\(([^,]+), ":\*"\)$/.exec(expr);
    if (trim) return resolve(`\${${trim[1]}}`).replace(/:\*$/, "");
    if (/^data\.aws_partition\.[\w]+\.partition$/.test(expr)) return partition;
    if (/^data\.aws_caller_identity\.[\w]+\.account_id$/.test(expr)) return BOUNDARY_ACCOUNT;
    if (/^data\.aws_region\.[\w]+\.(name|region)$/.test(expr)) return "eu-west-1";
    if (/^random_id\.[\w]+\.hex$/.test(expr)) return "abcdef12";
    const [type, label, attr] = expr.split(".");
    const body = fragment.resource?.[type]?.[label];
    if (type === "aws_cloudwatch_log_group" && body) {
      if (attr === "name") return resolve(String(body.name));
      if (attr === "arn") return `arn:${partition}:logs:eu-west-1:${BOUNDARY_ACCOUNT}:log-group:${resolve(String(body.name))}`;
    }
    if (type === "aws_s3_bucket" && body && (attr === "arn" || attr === "bucket")) {
      const bucket = resolve(String(body.bucket));
      return attr === "arn" ? `arn:${partition}:s3:::${bucket}` : bucket;
    }
    if (type === "aws_iam_role" && body) {
      if (attr === "name" || attr === "id") return resolve(String(body.name));
      if (attr === "arn") return `arn:${partition}:iam::${BOUNDARY_ACCOUNT}:role/${resolve(String(body.name))}`;
    }
    if (type === "aws_ecs_cluster" && body && attr === "arn") return `arn:${partition}:ecs:eu-west-1:${BOUNDARY_ACCOUNT}:cluster/${resolve(String(body.name))}`;
    if (type === "aws_ecs_task_definition" && body && attr === "arn") return `arn:${partition}:ecs:eu-west-1:${BOUNDARY_ACCOUNT}:task-definition/${resolve(String(body.family))}:1`;
    throw new Error(`Unresolved fixture expression: ${expr}`);
  });
  return Object.values(fragment.resource?.aws_iam_role_policy ?? {}).flatMap((body) => {
    const principal = `arn:${partition}:iam::${BOUNDARY_ACCOUNT}:role/${resolve(String(body.role))}`;
    const dataPolicy = /^\$\{data\.aws_iam_policy_document\.([\w]+)\.json\}$/.exec(String(body.policy));
    const policy = dataPolicy ? { Statement: (fragment.data!.aws_iam_policy_document[dataPolicy[1]].statement as { effect: string; actions: string[]; resources: string[] }[]).map((statement) => ({ Effect: statement.effect, Action: statement.actions, Resource: statement.resources })) } : body.policy;
    return statementsOf(policy).flatMap((statement) => {
      const context = { "aws:PrincipalArn": principal, ...Object.fromEntries(
        Object.values(statement.Condition ?? {}).flatMap((entries) => Object.entries(entries).map(([key, value]) => [key, resolve(String(value))]))
      ) };
      return asList(statement.Action).flatMap((action) => asList(statement.Resource).map((resource) => ({ action, resource: resolve(resource), context })));
    });
  });
}
