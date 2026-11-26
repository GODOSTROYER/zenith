/**
 * One-click AWS connection: the values Zenith derives for a new connection and
 * the CloudFormation quick-create link that opens the AWS console with them
 * already filled in.
 *
 * Pure apart from the random suffix: no network, no environment reads.
 *
 *  - Role names are fixed by the bootstrap template (`ZenithObserveRole${NameSuffix}`
 *    and so on, with no path), so Zenith derives the role ARNs from the account
 *    id and the suffix instead of asking the user to copy stack outputs.
 *  - Every one-click connection gets its own random suffix, so a second
 *    connection in the same account never collides on IAM role or policy names.
 *  - Quick-create links only accept a template stored in Amazon S3, and the
 *    bootstrap template is too large to send inline, so the template URL must be
 *    an S3 URL in one of the documented formats.
 *    https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stacks-quick-create-links.html
 */
import { isBootstrapNameSuffix, isSupportedAwsConnectionRegion } from "@/lib/aws-bootstrap-input";

export const ROLE_BASE_NAMES = Object.freeze({
  observe: "ZenithObserveRole",
  deploy: "ZenithDeployRole",
  secretWriter: "ZenithSecretWriterRole",
} as const);

const SUFFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const SUFFIX_RANDOM_LENGTH = 8;

/** `-z` plus 8 random lowercase letters or digits: valid, short enough for every derived name, and unique in practice. */
export function generateBootstrapNameSuffix(random: (bytes: Uint8Array) => Uint8Array = (b) => globalThis.crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(SUFFIX_RANDOM_LENGTH));
  let out = "";
  // 256 is not a multiple of 36; the small bias does not matter for a collision-avoidance label.
  for (const byte of bytes) out += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length];
  const suffix = `-z${out}`;
  if (!isBootstrapNameSuffix(suffix)) throw new Error("generated bootstrap suffix is invalid");
  return suffix;
}

export interface DerivedRoleArns {
  observeRoleArn: string;
  deployRoleArn: string;
  secretWriterRoleArn: string;
}

/** The ARNs of the roles the bootstrap stack creates for this account and suffix (commercial partition only). */
export function derivedRoleArns(accountId: string, suffix: string): DerivedRoleArns {
  if (!/^\d{12}$/.test(accountId)) throw new Error("account id must be 12 digits");
  if (!isBootstrapNameSuffix(suffix)) throw new Error("invalid bootstrap suffix");
  const arn = (base: string) => `arn:aws:iam::${accountId}:role/${base}${suffix}`;
  return {
    observeRoleArn: arn(ROLE_BASE_NAMES.observe),
    deployRoleArn: arn(ROLE_BASE_NAMES.deploy),
    secretWriterRoleArn: arn(ROLE_BASE_NAMES.secretWriter),
  };
}

/** Stack names allow letters, digits and hyphens and must start with a letter; the suffix keeps them distinct. */
export const stackNameFor = (suffix: string): string => `zenith-connection${suffix}`;

const BUCKET = "[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]";
const REGION = "[a-z]{2}(?:-[a-z]+)+-\\d{1,2}";
const KEY = "[A-Za-z0-9!_.*'()/-]{1,1024}";
const S3_TEMPLATE_URL = new RegExp(
  `^https://(?:s3\\.${REGION}\\.amazonaws\\.com/${BUCKET}/${KEY}|${BUCKET}\\.s3(?:\\.${REGION})?\\.amazonaws\\.com/${KEY}|s3-${REGION}\\.amazonaws\\.com/${BUCKET}/${KEY})$`,
);

/** True only for an https S3 object URL with no query, fragment or credentials. */
export const isS3TemplateUrl = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 2048 && S3_TEMPLATE_URL.test(value);

export type LaunchTrust =
  | { mode: "oidc_web_identity"; issuerHost: string; subject: string; createOidcProvider?: boolean }
  | { mode: "aws_assume_role"; principalArn?: string; externalId: string };

/** The template parameters to prefill. Values the template does not know are ignored by CloudFormation. */
export function launchParameters(trust: LaunchTrust, suffix: string): Record<string, string> {
  if (!isBootstrapNameSuffix(suffix)) throw new Error("invalid bootstrap suffix");
  if (trust.mode === "oidc_web_identity") {
    return {
      ZenithIssuerHost: trust.issuerHost,
      ZenithOidcSubject: trust.subject,
      CreateOidcProvider: trust.createOidcProvider === false ? "no" : "yes",
      NameSuffix: suffix,
    };
  }
  return {
    ...(trust.principalArn ? { ZenithPrincipalArn: trust.principalArn } : {}),
    ExternalId: trust.externalId,
    CreateOidcProvider: "no",
    NameSuffix: suffix,
  };
}

export interface QuickCreateInput {
  region: string;
  templateUrl: string;
  stackName: string;
  parameters: Record<string, string>;
}

/** https://<region>.console.aws.amazon.com/cloudformation/home?region=<region>#/stacks/create/review?templateURL=…&stackName=…&param_X=… */
export function quickCreateUrl(input: QuickCreateInput): string {
  if (!isSupportedAwsConnectionRegion(input.region)) throw new Error("unsupported region");
  if (!isS3TemplateUrl(input.templateUrl)) throw new Error("the template URL must be an https Amazon S3 object URL");
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(input.stackName)) throw new Error("invalid stack name");
  const query = [
    `templateURL=${encodeURIComponent(input.templateUrl)}`,
    `stackName=${encodeURIComponent(input.stackName)}`,
    ...Object.entries(input.parameters).map(([name, value]) => {
      if (!/^[A-Za-z0-9]{1,255}$/.test(name)) throw new Error("invalid parameter name");
      return `param_${name}=${encodeURIComponent(value)}`;
    }),
  ].join("&");
  return `https://${input.region}.console.aws.amazon.com/cloudformation/home?region=${input.region}#/stacks/create/review?${query}`;
}
