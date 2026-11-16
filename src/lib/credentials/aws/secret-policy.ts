/** Exact-ARN value-write policies. No value reads, wildcard resources or IAM reach. */
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { ENVIRONMENT_ID_PATTERN } from "./naming";
import { SessionPolicyError, validateSessionPolicy } from "./policy";

export function assertAwsSecretResource(arn: string, accountId: string, region: string, environmentId: string): void {
  const match = /^arn:(aws|aws-cn|aws-us-gov):secretsmanager:([a-z0-9-]+):(\d{12}):secret:([A-Za-z0-9/_+=.@-]+)-[A-Za-z0-9]{6}$/.exec(arn);
  if (!ENVIRONMENT_ID_PATTERN.test(environmentId) || !match || match[2] !== region || match[3] !== accountId ||
      !(match[4].startsWith(`zenith/${environmentId}/`) || match[4].startsWith(`zenith/zenith-${environmentId}-`))) {
    throw new SessionPolicyError("Secret targets must be exact ARNs in this account, region and environment.");
  }
}

export function secretWritePolicy(grant: CapabilityGrantClaims, accountId: string, region: string, resources?: readonly string[]): string {
  const granted = grant.constraints?.secretResources;
  if (grant.cap !== "secret.write" || grant.aud !== "worker" || !grant.env || !Number.isSafeInteger(grant.fence) || !Array.isArray(granted) || !granted.length ||
      granted.some((r) => typeof r !== "string") || new Set(granted).size !== granted.length) throw new SessionPolicyError("secret.write needs signed exact secretResources.");
  for (const arn of granted) assertAwsSecretResource(arn, accountId, region, grant.env);
  const targets = resources ?? granted as string[];
  if (!targets.length || new Set(targets).size !== targets.length || targets.some((r) => !granted.includes(r))) throw new SessionPolicyError("Secret session targets exceed the signed grant.");
  return validateSessionPolicy({ Version: "2012-10-17", Statement: [{
    Effect: "Allow", Action: ["secretsmanager:DescribeSecret", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecretVersionStage"], Resource: targets,
    Condition: { StringEquals: { "aws:ResourceTag/zenith:managed": "true", "aws:ResourceTag/zenith:workspace": grant.ws, "aws:ResourceTag/zenith:environment": grant.env } },
  }] });
}
