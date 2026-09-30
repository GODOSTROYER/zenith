/**
 * ARN helpers. Drivers parse ARNs that came back from the provider (or a
 * `referenced` node's `externalRef`); they never assemble IAM-relevant ARNs from
 * untrusted strings — that is what `ctx.ref` and tofu references are for.
 */

export interface ParsedArn {
  partition: string;
  service: string;
  region: string;
  accountId: string;
  /** everything after the fifth colon (resource type and id, service-specific) */
  resource: string;
}

const ARN = /^arn:([a-z-]+):([a-z0-9-]+):([a-z0-9-]*):(\d{12}|aws|):(.+)$/;

/** Parse an ARN; `undefined` when `value` is not one. */
export function parseArn(value: string): ParsedArn | undefined {
  const m = ARN.exec(value);
  if (!m) return undefined;
  return { partition: m[1], service: m[2], region: m[3], accountId: m[4], resource: m[5] };
}

/** True when `value` is an ARN of `service` (and, if given, `resourceType`, e.g. `loadbalancer`). */
export function isArnOf(value: string, service: string, resourceType?: string): boolean {
  const a = parseArn(value);
  if (!a || a.service !== service) return false;
  return resourceType === undefined || a.resource.startsWith(`${resourceType}/`) || a.resource.startsWith(`${resourceType}:`);
}

/**
 * The CloudWatch `LoadBalancer` / `TargetGroup` dimension value of an ELBv2 ARN:
 * `…:loadbalancer/app/web/50dc6c495c0c9188` → `app/web/50dc6c495c0c9188`,
 * `…:targetgroup/web/73e2d6bc24d8a067` → `targetgroup/web/73e2d6bc24d8a067`.
 */
export function elbv2ArnSuffix(arn: string): string | undefined {
  const a = parseArn(arn);
  if (!a || a.service !== "elasticloadbalancing") return undefined;
  return a.resource.startsWith("loadbalancer/") ? a.resource.slice("loadbalancer/".length) : a.resource;
}

/** The partition a region belongs to (`aws`, `aws-cn`, `aws-us-gov`). */
export function partitionOfRegion(region: string): string {
  if (region.startsWith("cn-")) return "aws-cn";
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  return "aws";
}
