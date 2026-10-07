/**
 * Live IAM permission acceptance for the commercial AWS partition ONLY.
 *
 * What it proves, when it is run against a sandbox account by its owner:
 *   1. The deploy role's attached managed policies, read back from IAM, grant
 *      exactly the actions the compiled bootstrap says (no new gap, no new unused
 *      sensitive grant versus the reviewed least-privilege baseline).
 *   2. IAM's policy simulator ALLOWS creating a maximum-length role name in every
 *      reserved family suffix when the family boundary carrying the saved suffix is
 *      selected, and does NOT allow a boundary with another suffix, the retained
 *      legacy boundary, or a missing boundary.
 *   3. It does NOT allow principal creation, secret value reads, self-modification
 *      of the bootstrap roles, state bucket administration, or unlisted managed
 *      policy attachment: the privilege was not widened.
 *
 * Gating (every gate fails closed and an unset gate is a SKIP, never a pass):
 *   - ZENITH_LIVE_AWS_IAM=1 must be set. Otherwise the run is skipped with that reason.
 *   - Credentials come ONLY from a shared-credentials FILE named by
 *     ZENITH_LIVE_AWS_CREDENTIALS_FILE (the path is the reference; its content is never
 *     read by this module or printed). AWS_ACCESS_KEY_ID in the environment is refused so
 *     the file is the sole source.
 *   - The caller's account must equal ZENITH_LIVE_AWS_ACCOUNT_ID.
 *   - The role ARN must be in the commercial `aws` partition. China and GovCloud are
 *     refused: sovereign live acceptance is deferred (it needs those accounts).
 *   - Only read APIs are used (sts:GetCallerIdentity, iam:ListAttachedRolePolicies,
 *     iam:GetPolicy, iam:GetPolicyVersion, iam:SimulatePrincipalPolicy). Nothing is created,
 *     changed or deleted.
 *
 * This module never runs by itself in tests or CI: the real port is constructed only after
 * every gate passed. Contract tests drive it with a modeled port, which is labeled as such.
 */
import fs from "node:fs";
import path from "node:path";
import { allowedActionsOf, diffAgainstCompilerActions } from "@/lib/credentials/aws/least-privilege";
import { usedActionsForResourceTypes, usedRuntimeActions } from "@/lib/credentials/aws/compiler-actions";
import { AWS_CONNECTION_REGIONS, isBootstrapNameSuffix } from "@/lib/aws-bootstrap-input";
import { AWS_ROLE_BOUNDARIES, awsBoundaryArn, ENVIRONMENT_ID_PATTERN, NAME_PREFIX, type AwsRoleFamily } from "@/lib/credentials/aws/naming";
import { IAM_ROLE_NAME_MAX } from "@/lib/credentials/aws/limits";
import { parseRoleArn } from "@/lib/credentials/aws/arn";

export const IAM_LIVE_FLAG = "ZENITH_LIVE_AWS_IAM";

export type IamAcceptanceStatus = "passed" | "failed" | "skipped" | "refused";
export type SimulatedDecision = "allowed" | "implicitDeny" | "explicitDeny";

export interface IamAcceptanceConfig {
  readonly accountId: string;
  readonly region: string;
  readonly deployRoleArn: string;
  readonly bootstrapNameSuffix: string;
  readonly environmentId: string;
  readonly credentialsFile: string;
  readonly profile?: string;
}

export type ConfigOutcome =
  | { readonly kind: "ready"; readonly config: IamAcceptanceConfig }
  | { readonly kind: "skipped" | "refused"; readonly reason: string };

type EnvLike = Readonly<Record<string, string | undefined>>;

/** Parse and gate the environment. Pure and offline; nothing is read from the credentials file. */
export function readIamAcceptanceConfig(env: EnvLike, fileExists: (file: string) => boolean = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true): ConfigOutcome {
  if (env[IAM_LIVE_FLAG] !== "1") return { kind: "skipped", reason: `${IAM_LIVE_FLAG}=1 is not set; live commercial IAM acceptance was not run (deferred, not counted as passed).` };
  const missing = ["ZENITH_LIVE_AWS_ACCOUNT_ID", "ZENITH_LIVE_REGION", "ZENITH_LIVE_AWS_DEPLOY_ROLE_ARN", "ZENITH_LIVE_AWS_CREDENTIALS_FILE"].filter((name) => !env[name]);
  if (missing.length) return { kind: "refused", reason: `Required settings are missing: ${missing.join(", ")}.` };
  const accountId = env.ZENITH_LIVE_AWS_ACCOUNT_ID!;
  const region = env.ZENITH_LIVE_REGION!;
  if (!/^\d{12}$/.test(accountId)) return { kind: "refused", reason: "ZENITH_LIVE_AWS_ACCOUNT_ID must be a 12-digit account id." };
  if (!(AWS_CONNECTION_REGIONS as readonly string[]).includes(region)) return { kind: "refused", reason: "ZENITH_LIVE_REGION must be a supported commercial region; China and GovCloud live acceptance is deferred." };
  const role = parseRoleArn(env.ZENITH_LIVE_AWS_DEPLOY_ROLE_ARN);
  if (!role) return { kind: "refused", reason: "ZENITH_LIVE_AWS_DEPLOY_ROLE_ARN is not a role ARN." };
  if (role.partition !== "aws") return { kind: "refused", reason: "Only the commercial aws partition is supported; sovereign live acceptance is deferred." };
  if (role.accountId !== accountId) return { kind: "refused", reason: "The deploy role is not in ZENITH_LIVE_AWS_ACCOUNT_ID." };
  const bootstrapNameSuffix = env.ZENITH_LIVE_AWS_NAME_SUFFIX ?? "";
  if (!isBootstrapNameSuffix(bootstrapNameSuffix)) return { kind: "refused", reason: "ZENITH_LIVE_AWS_NAME_SUFFIX is not a valid bootstrap suffix." };
  const environmentId = env.ZENITH_LIVE_ENVIRONMENT_ID ?? "env-iam-probe";
  if (!ENVIRONMENT_ID_PATTERN.test(environmentId)) return { kind: "refused", reason: "ZENITH_LIVE_ENVIRONMENT_ID is not a valid environment id." };
  if (env.AWS_ACCESS_KEY_ID || env.AWS_SESSION_TOKEN) return { kind: "refused", reason: "Unset AWS_ACCESS_KEY_ID and AWS_SESSION_TOKEN: the credentials file must be the only credential source." };
  const credentialsFile = env.ZENITH_LIVE_AWS_CREDENTIALS_FILE!;
  if (!path.isAbsolute(credentialsFile) || !fileExists(credentialsFile)) return { kind: "refused", reason: "ZENITH_LIVE_AWS_CREDENTIALS_FILE must be the absolute path of an existing file." };
  const profile = env.ZENITH_LIVE_AWS_PROFILE;
  if (profile !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(profile)) return { kind: "refused", reason: "ZENITH_LIVE_AWS_PROFILE is not a valid profile name." };
  return { kind: "ready", config: Object.freeze({ accountId, region, deployRoleArn: env.ZENITH_LIVE_AWS_DEPLOY_ROLE_ARN!, bootstrapNameSuffix, environmentId, credentialsFile, ...(profile ? { profile } : {}) }) };
}

export interface IamProbe {
  readonly id: string;
  readonly action: string;
  readonly resourceArn: string;
  readonly context: Readonly<Record<string, string>>;
  /** `allowed` must be allowed; `not_allowed` may be an implicit or explicit deny. */
  readonly expect: "allowed" | "not_allowed";
  readonly why: string;
}

const BOUNDARY_KEY = "iam:PermissionsBoundary";
const MANAGED_TAG_KEY = "aws:RequestTag/zenith:managed";

/** Role name of exactly the IAM maximum that ends in `suffix`. */
export const maximumRoleName = (suffix: string, tag = ""): string => `${NAME_PREFIX}${tag}${"a".repeat(IAM_ROLE_NAME_MAX - NAME_PREFIX.length - tag.length - suffix.length)}${suffix}`;

/** The probe table. Everything here is commercial `aws`; the account and suffix come from the saved connection. */
export function buildIamProbes(config: Pick<IamAcceptanceConfig, "accountId" | "region" | "bootstrapNameSuffix">): IamProbe[] {
  const { accountId, bootstrapNameSuffix: suffix } = config;
  const boundary = (family: AwsRoleFamily, s = suffix): string => awsBoundaryArn(family, "aws", accountId, s);
  const role = (name: string): string => `arn:aws:iam::${accountId}:role/${name}`;
  const probes: IamProbe[] = [];
  const families = Object.keys(AWS_ROLE_BOUNDARIES) as AwsRoleFamily[];
  for (const family of families) {
    AWS_ROLE_BOUNDARIES[family].suffixes.forEach((roleSuffix, index) => {
      probes.push({
        id: `create-role-${family}-${index}-maximum-name-with-saved-suffix`, action: "iam:CreateRole", resourceArn: role(maximumRoleName(roleSuffix)),
        context: { [BOUNDARY_KEY]: boundary(family), [MANAGED_TAG_KEY]: "true" }, expect: "allowed",
        why: `A ${IAM_ROLE_NAME_MAX}-character ${roleSuffix} role is creatable with the ${family} boundary that carries the saved suffix.`,
      });
    });
  }
  const sample = maximumRoleName("-role");
  const wrongSuffix = suffix === "-other" ? "-another" : "-other";
  probes.push(
    { id: "create-role-foreign-suffix-boundary", action: "iam:CreateRole", resourceArn: role(sample), context: { [BOUNDARY_KEY]: boundary("app", wrongSuffix), [MANAGED_TAG_KEY]: "true" }, expect: "not_allowed", why: "A boundary carrying a different suffix is not selectable." },
    { id: "create-role-legacy-boundary", action: "iam:CreateRole", resourceArn: role(sample), context: { [BOUNDARY_KEY]: `arn:aws:iam::${accountId}:policy/ZenithWorkloadBoundary${suffix}`, [MANAGED_TAG_KEY]: "true" }, expect: "not_allowed", why: "The retained legacy boundary cannot be selected for new roles." },
    { id: "create-role-without-boundary", action: "iam:CreateRole", resourceArn: role(sample), context: { [MANAGED_TAG_KEY]: "true" }, expect: "not_allowed", why: "A role without a permissions boundary cannot be created." },
    { id: "create-role-without-managed-tag", action: "iam:CreateRole", resourceArn: role(sample), context: { [BOUNDARY_KEY]: boundary("app") }, expect: "not_allowed", why: "A role without the managed tag cannot be created." },
    { id: "pass-role-to-ecs-tasks", action: "iam:PassRole", resourceArn: role(maximumRoleName("-exec")), context: { "iam:PassedToService": "ecs-tasks.amazonaws.com" }, expect: "allowed", why: "A zenith role can be passed to a listed service." },
    { id: "pass-role-foreign-role", action: "iam:PassRole", resourceArn: role("not-a-zenith-role"), context: { "iam:PassedToService": "ecs-tasks.amazonaws.com" }, expect: "not_allowed", why: "A role outside the zenith-* names cannot be passed." },
    { id: "create-user", action: "iam:CreateUser", resourceArn: `arn:aws:iam::${accountId}:user/zenith-probe`, context: {}, expect: "not_allowed", why: "Principal creation is denied." },
    { id: "create-access-key", action: "iam:CreateAccessKey", resourceArn: `arn:aws:iam::${accountId}:user/zenith-probe`, context: {}, expect: "not_allowed", why: "Credential minting is denied." },
    { id: "create-oidc-provider", action: "iam:CreateOpenIDConnectProvider", resourceArn: `arn:aws:iam::${accountId}:oidc-provider/example.invalid`, context: {}, expect: "not_allowed", why: "OIDC providers are bootstrap-owned." },
    { id: "modify-deploy-role-policy", action: "iam:PutRolePolicy", resourceArn: role(`ZenithDeployRole${suffix}`), context: { [BOUNDARY_KEY]: boundary("app") }, expect: "not_allowed", why: "The deploy role cannot modify itself." },
    { id: "attach-unlisted-managed-policy", action: "iam:AttachRolePolicy", resourceArn: role(sample), context: { [BOUNDARY_KEY]: boundary("app"), "iam:PolicyARN": "arn:aws:iam::aws:policy/AdministratorAccess" }, expect: "not_allowed", why: "Only listed managed policies can be attached." },
    { id: "read-secret-value", action: "secretsmanager:GetSecretValue", resourceArn: `arn:aws:secretsmanager:${config.region}:${accountId}:secret:zenith/probe-AbCdEf`, context: {}, expect: "not_allowed", why: "Secret values are never readable by the deploy role." },
    { id: "delete-state-bucket", action: "s3:DeleteBucket", resourceArn: `arn:aws:s3:::zenith-state-${accountId}-${config.region}${suffix}`, context: {}, expect: "not_allowed", why: "The state bucket cannot be administered by the deploy role." },
  );
  return probes;
}

export interface ProbeResult { readonly id: string; readonly decision: SimulatedDecision; readonly expect: IamProbe["expect"]; readonly ok: boolean; readonly why: string }

export function evaluateProbe(probe: IamProbe, decision: SimulatedDecision): ProbeResult {
  const ok = probe.expect === "allowed" ? decision === "allowed" : decision !== "allowed";
  return Object.freeze({ id: probe.id, decision, expect: probe.expect, ok, why: probe.why });
}

/** What the live IAM readback of the deploy role's policies looks like against the reviewed baseline. */
export interface ReadbackCheck {
  readonly liveActions: number;
  readonly newMissing: readonly string[];
  readonly newUnusedSensitive: readonly string[];
}

export function checkLiveReadback(
  documents: readonly unknown[], resourceTypes: readonly string[],
  baseline: { readonly knownMissing: Readonly<Record<string, unknown>>; readonly allowedUnusedSensitive: readonly string[] },
): ReadbackCheck {
  const live = [...new Set(documents.flatMap((doc) => allowedActionsOf(doc)))].sort();
  const used = usedActionsForResourceTypes(resourceTypes);
  const report = diffAgainstCompilerActions(live, [...used.used, ...usedRuntimeActions()]);
  const known = new Set(Object.keys(baseline.knownMissing));
  const allowed = new Set(baseline.allowedUnusedSensitive);
  return Object.freeze({
    liveActions: live.length,
    newMissing: report.missing.map((item) => item.action).filter((action) => !known.has(action)),
    newUnusedSensitive: report.unusedSensitive.filter((action) => !allowed.has(action)),
  });
}

/** The only cloud-facing surface. A real implementation is built after the gates pass. */
export interface IamPort {
  callerAccountId(): Promise<string>;
  /** Default-version documents of every managed policy attached to the role. */
  attachedPolicyDocuments(roleArn: string): Promise<readonly unknown[]>;
  simulate(request: { roleArn: string; action: string; resourceArn: string; context: Readonly<Record<string, string>> }): Promise<SimulatedDecision>;
}

export interface IamAcceptanceReport {
  readonly status: IamAcceptanceStatus;
  readonly reason?: string;
  readonly readback?: ReadbackCheck;
  readonly probes: readonly ProbeResult[];
}

export async function runIamAcceptance(
  config: IamAcceptanceConfig, port: IamPort, resourceTypes: readonly string[],
  baseline: Parameters<typeof checkLiveReadback>[2],
): Promise<IamAcceptanceReport> {
  if (await port.callerAccountId() !== config.accountId) return { status: "refused", reason: "The credentials belong to a different account than ZENITH_LIVE_AWS_ACCOUNT_ID.", probes: [] };
  const readback = checkLiveReadback(await port.attachedPolicyDocuments(config.deployRoleArn), resourceTypes, baseline);
  const probes: ProbeResult[] = [];
  for (const probe of buildIamProbes(config)) {
    probes.push(evaluateProbe(probe, await port.simulate({ roleArn: config.deployRoleArn, action: probe.action, resourceArn: probe.resourceArn, context: probe.context })));
  }
  const failed = probes.filter((probe) => !probe.ok).length + readback.newMissing.length + readback.newUnusedSensitive.length;
  return { status: failed === 0 ? "passed" : "failed", readback, probes };
}

/** Exit codes: 0 passed, 1 failed, 2 refused, 3 skipped. A skip is never a pass. */
export const IAM_EXIT = Object.freeze({ passed: 0, failed: 1, refused: 2, skipped: 3 } as const);

export interface IamCliIo { out(text: string): void; err(text: string): void }

export async function runIamAcceptanceCli(
  argv: readonly string[], env: EnvLike, io: IamCliIo,
  deps: { createPort: (config: IamAcceptanceConfig) => IamPort | Promise<IamPort>; resourceTypes: () => readonly string[]; baseline: () => Parameters<typeof checkLiveReadback>[2] },
): Promise<number> {
  const outIndex = argv.indexOf("--out");
  const outDir = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const outcome = readIamAcceptanceConfig(env);
  if (outcome.kind !== "ready") {
    io.out(`${outcome.kind.toUpperCase()}: ${outcome.reason}`);
    return outcome.kind === "skipped" ? IAM_EXIT.skipped : IAM_EXIT.refused;
  }
  const report = await runIamAcceptance(outcome.config, await deps.createPort(outcome.config), deps.resourceTypes(), deps.baseline());
  for (const probe of report.probes) io.out(`${probe.ok ? "ok  " : "FAIL"} ${probe.id}: expected ${probe.expect}, IAM said ${probe.decision}`);
  if (report.reason) io.err(report.reason);
  io.out(`IAM acceptance: ${report.status}`);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "aws-iam-acceptance.json"), `${JSON.stringify({ level: "live_sandbox", partition: "aws", region: outcome.config.region, accountId: outcome.config.accountId, ...report }, null, 2)}\n`, "utf8");
  }
  return IAM_EXIT[report.status];
}
