/**
 * Trust-policy guard for IAM roles Zenith creates in a customer's AWS account.
 *
 * IAM has no condition key that restricts the CONTENT of a role trust policy, so the
 * deploy role's iam:CreateRole / iam:UpdateAssumeRolePolicy permissions cannot stop a
 * role trusted by an outside account. Zenith itself must therefore never emit or apply
 * one: this module is the single allow-list and validator, used at compile time (the
 * drivers) and at plan time (the OpenTofu plan inspector).
 *
 * Pure: no I/O. Messages quote only a truncated principal value.
 */

import { AWS_PARTITIONS, awsServicePrincipal } from "@/lib/credentials/aws/partition";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared/errors";

/**
 * Services Zenith trusts in a role trust policy (commercial names). Derived from the
 * drivers: lambda, ecs-tasks (task and exec roles), codebuild, ec2 (instances, EKS nodes),
 * events (ECS scheduled tasks), eks (cluster role), vpc-flow-logs (flow log delivery).
 * cloudfront and sns appear in the principal table but only in resource policies, never
 * in a trust policy, so they are deliberately absent.
 */
export const TRUST_SERVICES = ["lambda", "ecs-tasks", "codebuild", "ec2", "events", "eks", "vpc-flow-logs"] as const;

/** Every allowed service principal across the three partitions (e.g. `ec2.amazonaws.com.cn`). */
export const ALLOWED_TRUST_SERVICE_PRINCIPALS: ReadonlySet<string> = new Set(
  TRUST_SERVICES.flatMap((service) => AWS_PARTITIONS.map((partition) => awsServicePrincipal(partition, service))),
);

const ACTION_ASSUME = "sts:AssumeRole";
const ACTION_WEB_IDENTITY = "sts:AssumeRoleWithWebIdentity";

/**
 * The one Federated principal Zenith generates: the EKS cluster OIDC provider used for
 * IRSA. At compile time the ARN is a reference to a local value rendered by the driver.
 */
const EKS_OIDC_PROVIDER_ARN = /^arn:aws(?:-cn|-us-gov)?:iam::\d{12}:oidc-provider\/oidc\.eks\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/id\/[A-Fa-f0-9]{1,64}$/;
const TF_LOCAL_REF = /^\$\{local\.[A-Za-z0-9_-]+\}$/;

export interface TrustGuardOptions {
  /** Accept an unresolved Terraform `${local.x}` reference as the Federated OIDC provider (compile time only). */
  allowTerraformReferences?: boolean;
}

const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const shown = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v.length > 80 ? `${v.slice(0, 77)}...` : v) : typeof v);

/** Violations of a trust policy (document object or JSON text). Empty means the policy is acceptable. */
export function validateTrustPolicy(policy: unknown, opts: TrustGuardOptions = {}): string[] {
  let doc: unknown = policy;
  if (typeof policy === "string") {
    try { doc = JSON.parse(policy); } catch { return ["the trust policy is not valid JSON"]; }
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return ["the trust policy is not a JSON object"];
  const statements = list((doc as { Statement?: unknown }).Statement);
  if (statements.length === 0) return ["the trust policy has no statements"];

  const out: string[] = [];
  let allows = 0;
  statements.forEach((raw, i) => {
    const at = `statement ${i + 1}`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) { out.push(`${at} is not an object`); return; }
    const st = raw as Record<string, unknown>;
    if (st.NotPrincipal !== undefined) out.push(`${at} uses NotPrincipal`);
    if (st.NotAction !== undefined) out.push(`${at} uses NotAction`);
    // A plain Deny can only narrow trust; it is accepted (but never counts as trust).
    if (st.Effect === "Deny") return;
    if (st.Effect !== "Allow") { out.push(`${at} has an unknown Effect`); return; }
    allows += 1;

    const actions = list(st.Action);
    let federated = false;
    const p = st.Principal;
    if (p === undefined) { if (st.NotPrincipal === undefined) out.push(`${at} has no Principal`); }
    else if (typeof p === "string") out.push(`${at} trusts ${shown(p)} directly`);
    else if (p === null || typeof p !== "object" || Array.isArray(p)) out.push(`${at} has a malformed Principal`);
    else {
      const entries = Object.entries(p as Record<string, unknown>);
      if (entries.length === 0) out.push(`${at} has an empty Principal`);
      if (entries.length > 1 && entries.some(([t]) => t === "Federated")) out.push(`${at} mixes a federated principal with other principal types`);
      for (const [type, value] of entries) {
        const values = list(value);
        if (values.length === 0) out.push(`${at} has an empty ${shown(type)} principal`);
        if (type === "Service") {
          for (const v of values) if (typeof v !== "string" || !ALLOWED_TRUST_SERVICE_PRINCIPALS.has(v)) out.push(`${at} trusts service principal ${shown(v)} which is not approved`);
        } else if (type === "Federated") {
          federated = true;
          for (const v of values) {
            const ok = typeof v === "string" && (EKS_OIDC_PROVIDER_ARN.test(v) || (opts.allowTerraformReferences === true && TF_LOCAL_REF.test(v)));
            if (!ok) out.push(`${at} trusts federated principal ${shown(v)} which is not a Zenith EKS OIDC provider`);
          }
        } else out.push(`${at} trusts a ${shown(type)} principal; only approved services are allowed`);
      }
    }

    if (actions.length === 0) out.push(`${at} has no Action`);
    for (const a of actions) {
      const ok = typeof a === "string" && (federated ? a === ACTION_WEB_IDENTITY : a === ACTION_ASSUME);
      if (!ok) out.push(`${at} grants action ${shown(a)}, which is not permitted for its principal`);
    }
  });
  if (allows === 0) out.push("the trust policy has no Allow statement");
  return out;
}

/** Compile-time form: throws the driver compile error before anything is planned. */
export function assertTrustPolicy(policy: unknown, address: string, opts: TrustGuardOptions = {}): void {
  const violations = validateTrustPolicy(policy, opts);
  if (violations.length > 0) throw new DriverCompileError("policy_refused", address, `IAM role trust policy refused: ${violations.slice(0, 3).join("; ")}.`);
}

/* --------------------------------- plan time -------------------------------- */

/** The slice of a normalized plan change the plan-time check reads. */
export interface TrustPlanChange {
  address: string;
  type: string;
  action: string;
  changes: readonly { path: string; after: unknown }[];
}

export class TrustPolicyRefusedError extends Error {
  readonly code = "trust_policy_refused";
  constructor(message: string) { super(message); this.name = "TrustPolicyRefusedError"; }
}

const UNKNOWN = "(known after apply)";

/**
 * Refuse any aws_iam_role create/update/replace whose assume_role_policy is not an
 * approved Zenith trust policy. A computed (unknown), masked or missing value is refused:
 * only a policy that can be read and validated is safe.
 */
export function assertPlanTrustPolicies(plan: { resourceChanges: readonly TrustPlanChange[] }, opts: TrustGuardOptions = {}): void {
  for (const rc of plan.resourceChanges) {
    if (rc.type !== "aws_iam_role" || !["create", "update", "replace"].includes(rc.action)) continue;
    const attr = rc.changes.find((c) => c.path === "assume_role_policy");
    if (!attr) {
      // An update that leaves the attribute alone keeps the existing (previously checked) policy.
      if (rc.action === "update") continue;
      throw new TrustPolicyRefusedError(`Refusing ${rc.address}: the role has no readable assume_role_policy.`);
    }
    if (attr.after === UNKNOWN) throw new TrustPolicyRefusedError(`Refusing ${rc.address}: its trust policy is not known until apply, so it cannot be verified.`);
    const violations = validateTrustPolicy(attr.after, opts);
    if (violations.length > 0) throw new TrustPolicyRefusedError(`Refusing ${rc.address}: trust policy not allowed (${violations.slice(0, 3).join("; ")}).`);
  }
}
