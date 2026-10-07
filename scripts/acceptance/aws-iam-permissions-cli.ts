/**
 * Command-line entry for the live commercial IAM permission acceptance.
 *
 *   ZENITH_LIVE_AWS_IAM=1 \
 *   ZENITH_LIVE_AWS_ACCOUNT_ID=<sandbox account> ZENITH_LIVE_REGION=us-east-1 \
 *   ZENITH_LIVE_AWS_DEPLOY_ROLE_ARN=arn:aws:iam::<account>:role/ZenithDeployRole<suffix> \
 *   ZENITH_LIVE_AWS_CREDENTIALS_FILE=/absolute/path/to/shared-credentials \
 *   npx tsx scripts/acceptance/aws-iam-permissions-cli.ts --out ./evidence
 *
 * Exit codes: 0 passed, 1 failed, 2 refused, 3 skipped (the gate was not set; a skip is not a pass).
 * The credentials file is referenced by path only; this program never prints or copies it. Only read
 * IAM and STS APIs are called, and only after every gate in aws-iam-permissions.ts passed.
 */
import {
  GetPolicyCommand, GetPolicyVersionCommand, IAMClient, ListAttachedRolePoliciesCommand, SimulatePrincipalPolicyCommand,
} from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { BASELINE_PATH, readBaseline, scanDriverResourceTypes } from "../../deploy/aws/tools/least-privilege-diff";
import { runIamAcceptanceCli, type IamAcceptanceConfig, type IamPort, type SimulatedDecision } from "./aws-iam-permissions";

const MAX_PAGES = 10;

/** Real SDK port. Constructed only after the gates passed; the file reference becomes the SDK's sole credential source. */
export function createSdkIamPort(config: IamAcceptanceConfig): IamPort {
  process.env.AWS_SHARED_CREDENTIALS_FILE = config.credentialsFile;
  if (config.profile) process.env.AWS_PROFILE = config.profile;
  const sts = new STSClient({ region: config.region, maxAttempts: 3 });
  const iam = new IAMClient({ region: config.region, maxAttempts: 3 });
  return {
    async callerAccountId() {
      return (await sts.send(new GetCallerIdentityCommand({}))).Account ?? "";
    },
    async attachedPolicyDocuments(roleArn) {
      const roleName = roleArn.slice(roleArn.lastIndexOf("/") + 1);
      const arns: string[] = [];
      let marker: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const out = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName, ...(marker ? { Marker: marker } : {}) }));
        for (const policy of out.AttachedPolicies ?? []) if (policy.PolicyArn) arns.push(policy.PolicyArn);
        if (!out.IsTruncated) break;
        marker = out.Marker;
      }
      const documents: unknown[] = [];
      for (const arn of arns) {
        const versionId = (await iam.send(new GetPolicyCommand({ PolicyArn: arn }))).Policy?.DefaultVersionId;
        const text = (await iam.send(new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: versionId }))).PolicyVersion?.Document ?? "";
        documents.push(JSON.parse(text.trimStart().startsWith("{") ? text : decodeURIComponent(text)));
      }
      return documents;
    },
    async simulate({ roleArn, action, resourceArn, context }) {
      const out = await iam.send(new SimulatePrincipalPolicyCommand({
        PolicySourceArn: roleArn, ActionNames: [action], ResourceArns: [resourceArn],
        ContextEntries: Object.entries(context).map(([ContextKeyName, value]) => ({ ContextKeyName, ContextKeyValues: [value], ContextKeyType: "string" as const })),
      }));
      const decision = out.EvaluationResults?.[0]?.EvalDecision;
      return (decision === "allowed" || decision === "explicitDeny" ? decision : "implicitDeny") as SimulatedDecision;
    },
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  return runIamAcceptanceCli(argv, process.env, { out: (text) => process.stdout.write(`${text}\n`), err: (text) => process.stderr.write(`${text}\n`) }, {
    createPort: createSdkIamPort,
    resourceTypes: () => scanDriverResourceTypes(),
    baseline: () => readBaseline(BASELINE_PATH),
  });
}

if (/aws-iam-permissions-cli\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`IAM acceptance aborted: ${error instanceof Error ? error.name : "error"}\n`);
    process.exitCode = 1;
  });
}
