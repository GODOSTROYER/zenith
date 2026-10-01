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
import { BUILD_ROLE_NAME_PATTERN } from "../../../src/lib/credentials/aws/naming";
import { loadTemplate, makeEvaluator, resolveResource, statementsOf, type Statement } from "../../../tests/credentials/cfn";

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
};

/** Statements that only exist when an optional parameter is set, keyed for the module's HCL. */
const OPTIONAL: Record<string, { policy: string; sid: string }> = {
  observe_kms: { policy: "ObservePolicy", sid: "ReadStateKmsKey" },
  state_kms: { policy: "DeployStatePolicy", sid: "StateKmsKey" },
  route53: { policy: "DeployEdgePolicy", sid: "Route53ChangeRecordsInListedZones" },
};

const ZONES_MARKER = "__ROUTE53_ZONES__";

function tokenEvaluator(optionalOn: boolean) {
  const template = loadTemplate(TEMPLATE_PATH);
  const evaluator = makeEvaluator(template, {
    pseudo: { partition: "${partition}", accountId: "${account_id}", region: "${region}" },
    tokenParams: {
      EnvironmentTagValue: "${environment_tag_value}",
      StateBucketKmsKeyArn: "${kms_key_arn}",
      Route53HostedZoneArns: ZONES_MARKER,
    },
    forceConditions: { HasKmsKey: optionalOn, HasHostedZones: optionalOn, HasOidc: true, HasAssumeRole: false, CreateProvider: true },
    resourceOverrides: {
      WorkloadBoundary: { ref: "${boundary_arn}" },
      StateBucket: { ref: "${state_bucket}", attrs: { Arn: "${state_bucket_arn}" } },
    },
  });
  return { template, evaluator };
}

const render = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)
    .replaceAll(`"${ZONES_MARKER}"`, "${jsonencode(route53_hosted_zone_arns)}")}\n`;

export function generate(): Record<string, string> {
  const base = tokenEvaluator(false);
  const full = tokenEvaluator(true);
  const files: Record<string, string> = {};

  for (const [logicalId, file] of Object.entries(POLICY_RESOURCES)) {
    const props = resolveResource(base.template, base.evaluator, logicalId)!;
    if (logicalId === "WorkloadBoundary") {
      // YAML cannot import TS; fail generation/checking if its reserved build
      // principal drifts from the constant the CodeBuild driver uses.
      for (const statement of statementsOf(props.PolicyDocument).filter((s) => s.Sid?.startsWith("Build"))) {
        if (statement.Condition?.ArnLike?.["aws:PrincipalArn"] !== `arn:\${partition}:iam::\${account_id}:role/${BUILD_ROLE_NAME_PATTERN}`) {
          throw new Error(`Build principal naming drift in ${statement.Sid}`);
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

if (process.argv.includes("--write")) write();
if (process.argv.includes("--check")) {
  const mismatches = checkPolicies();
  if (mismatches.length) {
    console.error(`Policy template drift: ${mismatches.join(", ")}`);
    process.exitCode = 1;
  } else console.log(`checked ${Object.keys(generate()).length} policy templates; no drift`);
}
