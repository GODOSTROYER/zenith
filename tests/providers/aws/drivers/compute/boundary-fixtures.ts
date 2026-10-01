/** Resolve only the fixture's known OpenTofu expressions for local IAM checks. */
import type { TofuFragment } from "@/lib/drivers/types";
import { asList, statementsOf } from "../../../../credentials/cfn";

export const BOUNDARY_ACCOUNT = "123456789012";
export const BOUNDARY_PREFIX = "zenith-env-1";

export function policyRequests(fragment: TofuFragment, refs: Record<string, string> = {}): { action: string; resource: string }[] {
  const resolve = (value: string): string => value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    if (expr in refs) return refs[expr];
    if (/^data\.aws_partition\.[\w]+\.partition$/.test(expr)) return "aws";
    if (/^data\.aws_caller_identity\.[\w]+\.account_id$/.test(expr)) return BOUNDARY_ACCOUNT;
    if (/^data\.aws_region\.[\w]+\.(name|region)$/.test(expr)) return "eu-west-1";
    if (/^random_id\.[\w]+\.hex$/.test(expr)) return "abcdef12";
    const [type, label, attr] = expr.split(".");
    const body = fragment.resource?.[type]?.[label];
    if (type === "aws_cloudwatch_log_group" && attr === "name" && body) return resolve(String(body.name));
    if (type === "aws_s3_bucket" && body && (attr === "arn" || attr === "bucket")) {
      const bucket = resolve(String(body.bucket));
      return attr === "arn" ? `arn:aws:s3:::${bucket}` : bucket;
    }
    throw new Error(`Unresolved fixture expression: ${expr}`);
  });
  return Object.values(fragment.resource?.aws_iam_role_policy ?? {}).flatMap((body) =>
    statementsOf(body.policy).flatMap((statement) =>
      asList(statement.Action).flatMap((action) => asList(statement.Resource).map((resource) => ({ action, resource: resolve(resource) })))
    )
  );
}
