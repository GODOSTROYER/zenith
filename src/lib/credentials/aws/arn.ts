/** Small, strict ARN helpers for the IAM role ARNs stored on connections. */

export interface RoleArn {
  partition: "aws" | "aws-cn" | "aws-us-gov";
  accountId: string;
  path: string;
  name: string;
}

const ROLE_ARN = /^arn:(aws|aws-cn|aws-us-gov):iam::(\d{12}):role\/((?:[A-Za-z0-9+=,.@_-]+\/)*)([A-Za-z0-9+=,.@_-]{1,64})$/;

export function parseRoleArn(arn: unknown): RoleArn | undefined {
  if (typeof arn !== "string" || arn.length > 2048) return undefined;
  const m = ROLE_ARN.exec(arn);
  if (!m) return undefined;
  return { partition: m[1] as RoleArn["partition"], accountId: m[2], path: m[3], name: m[4] };
}

export const isAccountId = (v: unknown): v is string => typeof v === "string" && /^\d{12}$/.test(v);

/** AWS region names, e.g. `ap-south-1`, `us-gov-west-1`. Loose on purpose; the SDK is the real validator. */
export const isRegion = (v: unknown): v is string => typeof v === "string" && /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/.test(v);

/** External ids: 2–1224 chars of `[A-Za-z0-9+=,.@:/-_]` (IAM quota page). */
export const isExternalId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9+=,.@:/_-]{2,1224}$/.test(v);
