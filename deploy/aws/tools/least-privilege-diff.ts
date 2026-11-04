/**
 * Least-privilege diff for the AWS bootstrap: compares the actions the compiled
 * deploy policies grant (evaluated from the CloudFormation template, the single
 * source of truth) with the actions the compiler and execution path actually use.
 *
 *   npx tsx deploy/aws/tools/least-privilege-diff.ts            # human report
 *   npx tsx deploy/aws/tools/least-privilege-diff.ts --json     # machine report
 *   npx tsx deploy/aws/tools/least-privilege-diff.ts --check    # exit 1 on drift from the baseline
 *   npx tsx deploy/aws/tools/least-privilege-diff.ts --write-baseline   # re-record after a reviewed change
 *
 * Static and offline: no AWS call is made and no policy is changed or widened.
 * `--write-baseline` only rewrites tools/least-privilege-baseline.json, which is
 * a review record of known gaps, never a grant.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowedActionsOf, diffAgainstCompilerActions, type LeastPrivilegeReport } from "../../../src/lib/credentials/aws/least-privilege";
import { COMPILER_RESOURCE_ACTIONS, usedActionsForResourceTypes, usedRuntimeActions } from "../../../src/lib/credentials/aws/compiler-actions";
import { loadTemplate, makeEvaluator, resolveResource } from "../../../tests/credentials/cfn";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = path.resolve(HERE, "../zenith-connection.cfn.yaml");
export const BASELINE_PATH = path.resolve(HERE, "least-privilege-baseline.json");
export const DRIVERS_DIR = path.resolve(HERE, "../../../src/lib/providers/aws/drivers");

export interface BaselineMissing { via: string[]; status: "gap_to_triage" | "denied_by_design"; note: string }
export interface LeastPrivilegeBaseline {
  version: 1;
  /** Actions the compiler needs that the deploy role does not grant. Reviewed, never silently growing. */
  knownMissing: Record<string, BaselineMissing>;
  /** Granted sensitive-service write actions no compiler path uses. A new entry needs review. */
  allowedUnusedSensitive: string[];
}

const GAP_NOTE = "The compiler emits this resource type but the deploy policies do not grant the action, so applying it through the deploy role fails at IAM. Not widened here: changing the bootstrap needs its own reviewed change and independent live IAM acceptance.";

/** Actions allowed by the deploy-role managed policies, evaluated with every optional feature on. */
export function grantedDeployActions(partition = "aws"): string[] {
  const template = loadTemplate(TEMPLATE_PATH);
  const evaluator = makeEvaluator(template, {
    pseudo: { partition, accountId: "123456789012", region: "us-east-1" },
    params: {
      NameSuffix: "", EnvironmentTagValue: "*",
      StateBucketKmsKeyArn: `arn:${partition}:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555`,
      Route53HostedZoneArns: [`arn:${partition}:route53:::hostedzone/Z0123456789ABC`],
    },
  });
  const actions = new Set<string>();
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type !== "AWS::IAM::ManagedPolicy" || !logicalId.startsWith("Deploy")) continue;
    const props = resolveResource(template, evaluator, logicalId);
    if (props) for (const action of allowedActionsOf(props.PolicyDocument)) actions.add(action);
  }
  return [...actions].sort();
}

/** `aws_*` resource types the AWS drivers emit through `b.resource("<type>", ...)`. */
export function scanDriverResourceTypes(dir = DRIVERS_DIR): string[] {
  const types = new Set<string>();
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(".ts")) {
        for (const match of fs.readFileSync(full, "utf8").matchAll(/\.resource\(\s*["`](aws_[a-z0-9_]+)["`]/g)) types.add(match[1]);
      }
    }
  };
  visit(dir);
  return [...types].sort();
}

export interface LeastPrivilegeResult {
  report: LeastPrivilegeReport;
  uncatalogued: readonly string[];
  resourceTypes: readonly string[];
}

export function computeLeastPrivilegeReport(resourceTypes: readonly string[] = scanDriverResourceTypes(), granted: readonly string[] = grantedDeployActions()): LeastPrivilegeResult {
  const used = usedActionsForResourceTypes(resourceTypes);
  const report = diffAgainstCompilerActions(granted, [...used.used, ...usedRuntimeActions()]);
  return { report, uncatalogued: used.uncatalogued, resourceTypes };
}

export interface BaselineComparison {
  newMissing: string[];
  /** Baseline entries the policies now grant (or the compiler stopped needing); remove them. */
  staleMissing: string[];
  newUnusedSensitive: string[];
}

export function compareToBaseline(report: LeastPrivilegeReport, baseline: LeastPrivilegeBaseline): BaselineComparison {
  const missing = new Set(report.missing.map((item) => item.action));
  const known = new Set(Object.keys(baseline.knownMissing));
  const allowed = new Set(baseline.allowedUnusedSensitive);
  return {
    newMissing: [...missing].filter((action) => !known.has(action)).sort(),
    staleMissing: [...known].filter((action) => !missing.has(action)).sort(),
    newUnusedSensitive: report.unusedSensitive.filter((action) => !allowed.has(action)),
  };
}

export function readBaseline(file = BASELINE_PATH): LeastPrivilegeBaseline {
  return JSON.parse(fs.readFileSync(file, "utf8")) as LeastPrivilegeBaseline;
}

export function buildBaseline(report: LeastPrivilegeReport, previous?: LeastPrivilegeBaseline): LeastPrivilegeBaseline {
  const knownMissing: Record<string, BaselineMissing> = {};
  for (const item of report.missing) {
    const before = previous?.knownMissing[item.action];
    knownMissing[item.action] = { via: [...item.via], status: before?.status ?? "gap_to_triage", note: before?.note ?? GAP_NOTE };
  }
  return { version: 1, knownMissing, allowedUnusedSensitive: [...report.unusedSensitive] };
}

function printReport(result: LeastPrivilegeResult, comparison: BaselineComparison): void {
  const { report } = result;
  console.log(`Granted patterns: ${report.grantedPatterns}; compiler actions needed: ${report.usedActions}; resource types scanned: ${result.resourceTypes.length}`);
  console.log(`\nNeeded but not granted (${report.missing.length}):`);
  for (const item of report.missing) console.log(`  ${item.action}  <- ${item.via.join(", ")}`);
  console.log(`\nGranted write actions nothing in the compiler needs (${report.unused.length}); sensitive: ${report.unusedSensitive.length}`);
  for (const action of report.unused) console.log(`  ${action}${report.unusedSensitive.includes(action) ? "  [sensitive]" : ""}`);
  if (result.uncatalogued.length) console.log(`\nUNCATALOGUED resource types (add them to compiler-actions.ts): ${result.uncatalogued.join(", ")}`);
  console.log(`\nBaseline drift: new missing ${comparison.newMissing.length}, stale ${comparison.staleMissing.length}, new unused sensitive ${comparison.newUnusedSensitive.length}`);
}

export function runCli(argv: readonly string[]): number {
  const result = computeLeastPrivilegeReport();
  const cataloguedStale = Object.keys(COMPILER_RESOURCE_ACTIONS).filter((type) => !result.resourceTypes.includes(type));
  if (argv.includes("--write-baseline")) {
    const previous = fs.existsSync(BASELINE_PATH) ? readBaseline() : undefined;
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(buildBaseline(result.report, previous), null, 2)}\n`, "utf8");
    console.log(`wrote ${BASELINE_PATH}`);
    return result.uncatalogued.length ? 1 : 0;
  }
  const comparison = compareToBaseline(result.report, readBaseline());
  if (argv.includes("--json")) console.log(JSON.stringify({ ...result, comparison, cataloguedStale }, null, 2));
  else printReport(result, comparison);
  const drift = comparison.newMissing.length + comparison.staleMissing.length + comparison.newUnusedSensitive.length + result.uncatalogued.length + cataloguedStale.length;
  return argv.includes("--check") && drift > 0 ? 1 : 0;
}

if (/least-privilege-diff\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  process.exitCode = runCli(process.argv.slice(2));
}
