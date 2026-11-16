/**
 * Derives the OpenTofu module's IAM policy documents from the CloudFormation
 * template, so the two bootstrap artifacts cannot drift apart: the template is
 * the single source of truth for permissions, and
 * `deploy/aws/tofu-module/policies/*.json.tftpl` are generated from it.
 *
 *   npx tsx deploy/aws/tools/generate-tofu-policies.ts --write
 *
 * A test (tests/credentials/bootstrap-templates.test.ts) fails when the
 * committed files differ from what this produces.
 *
 * Substitution tokens in the generated files are OpenTofu template variables:
 * ${partition} ${account_id} ${region} ${state_bucket} ${state_bucket_arn}
 * ${boundary_arn} ${environment_tag_value} ${kms_key_arn}, and
 * ${jsonencode(route53_hosted_zone_arns)} for the hosted-zone list.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AWS_ROLE_BOUNDARIES, BUILD_ROLE_NAME_PATTERN, EC2_ROLE_NAME_PATTERN, EVENTS_ROLE_NAME_PATTERN, roleFamilyPatterns, type AwsRoleFamily } from "../../../src/lib/credentials/aws/naming";
import { ROUTE53_ZONES_INLINE_MAX, ROUTE53_ZONES_PER_OVERFLOW_POLICY, sampleLongestRoute53ZoneArns } from "../../../src/lib/credentials/aws/limits";
import { AWS_PARTITIONS, type AwsPartition } from "../../../src/lib/credentials/aws/partition";
import { BOUNDARY_POLICY_BUDGET_CHARS, IAM_MANAGED_POLICY_MAX_CHARS, PolicyBudgetError, planManagedPolicySplit, type PolicyBudgetReading } from "../../../src/lib/credentials/aws/policy-budget";
import { compactSize, loadTemplate, makeEvaluator, resolveResource, statementsOf, type Statement } from "../../../tests/credentials/cfn";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = path.resolve(HERE, "../zenith-connection.cfn.yaml");
export const POLICIES_DIR = path.resolve(HERE, "../tofu-module/policies");

const POLICY_RESOURCES: Record<string, string> = {
  ObservePolicy: "observe",
  DeployNetworkPolicy: "deploy-network",
  DeployBalancingPolicy: "deploy-balancing",
  DeployComputePolicy: "deploy-compute",
  DeployDataPolicy: "deploy-data",
  DeployEdgePolicy: "deploy-edge",
  DeployStatePolicy: "deploy-state",
  DeployIamPolicy: "deploy-iam",
  WorkloadBoundary: "workload-boundary",
  ...Object.fromEntries(Object.values(AWS_ROLE_BOUNDARIES).map((family) => [family.logicalId, family.template])),
};

/** Statements that only exist when an optional parameter is set, keyed for the module's HCL. */
const OPTIONAL: Record<string, { policy: string; sid: string }> = {
  observe_kms: { policy: "ObservePolicy", sid: "ReadStateKmsKey" },
  state_kms: { policy: "DeployStatePolicy", sid: "StateKmsKey" },
  route53: { policy: "DeployEdgePolicy", sid: "Route53ChangeRecordsInListedZones" },
};

const ZONES_MARKER = "__ROUTE53_ZONES__";

const isBoundary = (logicalId: string): boolean => logicalId !== "WorkloadBoundary" && logicalId.endsWith("Boundary");

/** Include the retained legacy policy in the guard during the migration window. */
export function boundarySizes(): { partition: string; logicalId: string; size: number; limit: number }[] {
  const template = loadTemplate(TEMPLATE_PATH);
  return AWS_PARTITIONS.flatMap((partition) => {
    // Worst case: longest suffix and environment scope, and the inline maximum of longest hosted zone ARNs.
    const evaluator = makeEvaluator(template, {
      pseudo: { partition, accountId: "123456789012", region: "cn-northwest-1" },
      params: {
        NameSuffix: `-${"x".repeat(19)}`, EnvironmentTagValue: "x".repeat(64),
        StateBucketKmsKeyArn: `arn:${partition}:kms:cn-northwest-1:123456789012:key/11111111-2222-3333-4444-555555555555`,
        Route53HostedZoneArns: sampleLongestRoute53ZoneArns(partition, ROUTE53_ZONES_INLINE_MAX),
      },
    });
    return Object.keys(POLICY_RESOURCES).map((logicalId) => ({
      partition, logicalId, size: compactSize(resolveResource(template, evaluator, logicalId)!.PolicyDocument),
      // Legacy grants remain equivalent (its state deny is stronger); new families keep 344 characters free.
      limit: isBoundary(logicalId) ? BOUNDARY_POLICY_BUDGET_CHARS : IAM_MANAGED_POLICY_MAX_CHARS,
    }));
  });
}

/** One overflow DNS policy at its maximum: 40 of the longest zone ARNs, as the OpenTofu module renders it. */
export function overflowPolicySize(partition: AwsPartition): number {
  return compactSize({
    Version: "2012-10-17",
    Statement: [{ Sid: "Route53ChangeRecordsInListedZones", Effect: "Allow", Action: "route53:ChangeResourceRecordSets", Resource: sampleLongestRoute53ZoneArns(partition, ROUTE53_ZONES_PER_OVERFLOW_POLICY) }],
  });
}

export interface PolicyBudgetRow extends PolicyBudgetReading {
  partition: string;
  logicalId: string;
  boundary: boolean;
}

/** Per-policy size, headroom and near-limit flag in every partition. */
export function policyBudgetReport(): PolicyBudgetRow[] {
  return boundarySizes().map(({ partition, logicalId, size, limit }) => ({
    partition, logicalId, boundary: isBoundary(logicalId), size, budget: limit, headroom: limit - size,
    nearLimit: size >= limit * 0.9, overBudget: size > limit,
  }));
}

/**
 * Refuse any policy over its budget. A permissions boundary is one managed policy per
 * role and cannot be split. A deploy policy over budget gets the deterministic split a
 * reviewer would apply in the refusal; the deploy role has no spare managed-policy slot
 * under the default quota (8 attached + 2 DNS overflow = 10), so such a split is never
 * applied automatically. Hosted zones, the one unbounded input, split automatically in
 * the OpenTofu module (see src/lib/credentials/aws/limits.ts).
 */
export function checkBoundarySizes(): void {
  const template = loadTemplate(TEMPLATE_PATH);
  for (const { partition, logicalId, size, limit } of boundarySizes()) {
    if (size <= limit) continue;
    const where = `${logicalId} in ${partition}`;
    const base = `${where}: ${size} characters exceeds policy budget ${limit} (IAM maximum ${IAM_MANAGED_POLICY_MAX_CHARS})`;
    if (logicalId === "WorkloadBoundary" || isBoundary(logicalId)) throw new PolicyBudgetError(`${base}; a permissions boundary is a single managed policy and cannot be split.`);
    const evaluator = makeEvaluator(template, { pseudo: { partition, accountId: "123456789012", region: "cn-northwest-1" }, params: { NameSuffix: `-${"x".repeat(19)}`, EnvironmentTagValue: "x".repeat(64) } });
    const statements = statementsOf(resolveResource(template, evaluator, logicalId)!.PolicyDocument) as unknown as Record<string, unknown>[];
    let advice: string;
    try {
      advice = `it would split into ${planManagedPolicySplit(statements, { maxPolicies: 20 }).parts.length} managed policies`;
    } catch (error) {
      advice = error instanceof PolicyBudgetError ? error.message : "it cannot be split";
    }
    throw new PolicyBudgetError(`${base}; ${advice}. The deploy role has no spare managed-policy slot under the default quota.`);
  }
  for (const partition of AWS_PARTITIONS) {
    const size = overflowPolicySize(partition);
    if (size > IAM_MANAGED_POLICY_MAX_CHARS) throw new PolicyBudgetError(`DNS overflow policy in ${partition}: ${size} characters exceeds IAM maximum ${IAM_MANAGED_POLICY_MAX_CHARS}.`);
  }
}

function tokenEvaluator(optionalOn: boolean) {
  const template = loadTemplate(TEMPLATE_PATH);
  const evaluator = makeEvaluator(template, {
    pseudo: { partition: "${partition}", accountId: "${account_id}", region: "${region}", urlSuffix: "${dns_suffix}" },
    tokenParams: {
      EnvironmentTagValue: "${environment_tag_value}",
      StateBucketKmsKeyArn: "${kms_key_arn}",
      Route53HostedZoneArns: ZONES_MARKER,
    },
    forceConditions: { HasKmsKey: optionalOn, HasHostedZones: optionalOn, HasOidc: true, HasAssumeRole: false, CreateProvider: true },
    resourceOverrides: {
      WorkloadBoundary: { ref: "${boundary_arn}" },
      ...Object.fromEntries(Object.entries(AWS_ROLE_BOUNDARIES).map(([family, spec]) => [spec.logicalId, { ref: `\${${family}_boundary_arn}` }])),
      StateBucket: { ref: "${state_bucket}", attrs: { Arn: "${state_bucket_arn}" } },
    },
  });
  return { template, evaluator };
}

const render = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)
    .replaceAll(`"${ZONES_MARKER}"`, "${jsonencode(route53_hosted_zone_arns)}")}\n`;

export function generate(): Record<string, string> {
  checkBoundarySizes();
  const base = tokenEvaluator(false);
  const full = tokenEvaluator(true);
  const files: Record<string, string> = {};

  for (const [logicalId, file] of Object.entries(POLICY_RESOURCES)) {
    const props = resolveResource(base.template, base.evaluator, logicalId)!;
    const family = (Object.keys(AWS_ROLE_BOUNDARIES) as AwsRoleFamily[]).find((key) => AWS_ROLE_BOUNDARIES[key].logicalId === logicalId);
    if (family) {
      const expected = roleFamilyPatterns(family).map((pattern) => `arn:\${partition}:iam::\${account_id}:role/${pattern}`);
      if (props.ManagedPolicyName !== `${AWS_ROLE_BOUNDARIES[family].policyName}`) throw new Error(`Boundary policy naming drift: ${family}`);
      for (const statement of statementsOf(props.PolicyDocument)) {
        if (statement.Effect !== "Allow") continue;
        if (JSON.stringify(statement.Condition?.ArnLike?.["aws:PrincipalArn"]) !== JSON.stringify(expected)) throw new Error(`Boundary principal naming drift: ${family}`);
      }
    }
    if (logicalId === "WorkloadBoundary") {
      // YAML cannot import TS; verify every reserved service-role discriminator.
      for (const statement of statementsOf(props.PolicyDocument)) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        const pattern = actions.some((a) => a && ["ecr:PutImage", "s3:GetObjectVersion", "cloudfront:CreateInvalidation"].includes(a)) ? BUILD_ROLE_NAME_PATTERN
          : actions.some((a) => a && ["ecs:RunTask", "iam:PassRole"].includes(a)) || statement.Condition?.ArnNotLike ? EVENTS_ROLE_NAME_PATTERN
          : actions.some((a) => a === "ssm:UpdateInstanceInformation" || a === "ssm:GetManifest" || a === "ssm:GetDocument") ? EC2_ROLE_NAME_PATTERN : undefined;
        if (!pattern) continue;
        const operator = statement.Effect === "Deny" ? "ArnNotLike" : "ArnLike";
        if (statement.Condition?.[operator]?.["aws:PrincipalArn"] !== `arn:\${partition}:iam::\${account_id}:role/${pattern}`) {
          throw new Error(`Service-role principal naming drift for ${actions.join(", ")}`);
        }
      }
    }
    files[`${file}.json.tftpl`] = render(props.PolicyDocument);
  }
  const cb = resolveResource(base.template, base.evaluator, "CodeBuildRole")!;
  files["codebuild.json.tftpl"] = render((cb.Policies as { PolicyDocument: unknown }[])[0].PolicyDocument);
  const writer = resolveResource(base.template, base.evaluator, "SecretWriterRole")!;
  files["secret-writer.json.tftpl"] = render((writer.Policies as { PolicyDocument: unknown }[])[0].PolicyDocument);

  // The CodeBuild role's optional KMS statement.
  const cbFull = resolveResource(full.template, full.evaluator, "CodeBuildRole")!;
  const cbBaseSids = new Set(statementsOf((cb.Policies as { PolicyDocument: unknown }[])[0].PolicyDocument).map((s) => s.Sid));
  const codebuildKms = statementsOf((cbFull.Policies as { PolicyDocument: unknown }[])[0].PolicyDocument).filter(
    (s) => !cbBaseSids.has(s.Sid)
  );

  const optional: Record<string, Statement[]> = { codebuild_kms: codebuildKms };
  for (const [key, { policy, sid }] of Object.entries(OPTIONAL)) {
    const props = resolveResource(full.template, full.evaluator, policy)!;
    const found = statementsOf(props.PolicyDocument).filter((s) => s.Sid === sid);
    if (found.length !== 1) throw new Error(`Expected exactly one optional statement ${sid} in ${policy}`);
    optional[key] = found;
  }
  files["optional-statements.json.tftpl"] = render(optional);
  return files;
}

function write(): void {
  fs.mkdirSync(POLICIES_DIR, { recursive: true });
  for (const [name, text] of Object.entries(generate())) fs.writeFileSync(path.join(POLICIES_DIR, name), text, "utf8");
  console.log(`wrote ${Object.keys(generate()).length} policy templates to ${POLICIES_DIR}`);
}

/** Byte-for-byte drift check; missing files are failures too. */
export function checkPolicies(directory = POLICIES_DIR): string[] {
  return Object.entries(generate()).filter(([name, expected]) => {
    const file = path.join(directory, name);
    return !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== expected;
  }).map(([name]) => name);
}

if (process.argv.includes("--report")) {
  for (const row of policyBudgetReport()) console.log(`${row.partition.padEnd(11)} ${row.logicalId.padEnd(24)} ${String(row.size).padStart(5)}/${row.budget} headroom ${row.headroom}${row.nearLimit ? "  NEAR LIMIT" : ""}${row.overBudget ? "  OVER" : ""}`);
}
if (process.argv.includes("--write")) write();
if (process.argv.includes("--check")) {
  const mismatches = checkPolicies();
  if (mismatches.length) {
    console.error(`Policy template drift: ${mismatches.join(", ")}`);
    process.exitCode = 1;
  } else console.log(`checked ${Object.keys(generate()).length} policy templates; no drift`);
}
