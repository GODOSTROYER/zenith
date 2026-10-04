/** Read-only bootstrap inspection. A compatible readback is not an authorization decision. */
import { GetPolicyCommand, GetPolicyVersionCommand, GetRoleCommand, IAMClient, type Policy } from "@aws-sdk/client-iam";
import type { AwsConnectionConfig, AwsSession } from "@/lib/credentials/types";
import { parseRoleArn } from "./arn";
import { SessionPolicyError, validateSessionPolicy } from "./policy";
import {
  AWS_ROLE_BOUNDARIES, ENVIRONMENT_ID_PATTERN, NAME_PREFIX, TAG_ENVIRONMENT, TAG_MANAGED, TAG_WORKSPACE,
  awsBootstrapContextForConnection, resolveAwsRoleBoundaries, roleFamilyPatterns, type AwsBootstrapContext, type AwsRoleFamily,
} from "./naming";

const FAMILIES = ["app", "build", "machine", "scheduler", "eksCluster", "eksNode"] as const;
const MAX_ROLES = 32;
const MAX_DOCUMENT = 131_072;
const MAX_DECODED_DOCUMENT = 32_768;
const MAX_POLICY_SIZE = 6_144;
const VERSION_ID = /^v[1-9][0-9]*(\.[A-Za-z0-9-]*)?$/;
const POLICY_ID = /^\w{16,128}$/;

export type AwsBootstrapPreflightStatus = "readback_compatible" | "migration_required" | "needs_stack_upgrade" | "conflict" | "unavailable";
export type AwsBootstrapPreflightCode =
  | "invalid_scope" | "session_unavailable" | "read_unavailable" | "policy_missing" | "policy_identity"
  | "policy_version" | "policy_changed" | "policy_document" | "policy_size" | "policy_family"
  | "role_missing" | "role_identity" | "role_ownership" | "role_boundary" | "legacy_boundary" | "compatible";

export interface AwsBootstrapRoleInventory {
  /** Native operation/environment inventory, checked again against IAM role tags. */
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly roleArns: readonly string[];
}

export interface AwsBootstrapFamilyReadback {
  readonly family: AwsRoleFamily;
  readonly policyArn: string;
  readonly status: AwsBootstrapPreflightStatus;
  readonly code: AwsBootstrapPreflightCode;
  readonly defaultVersionId?: string;
  readonly policySize?: number;
}

export interface AwsBootstrapRoleReadback {
  readonly roleArn: string;
  readonly family: AwsRoleFamily;
  readonly expectedBoundaryArn: string;
  readonly status: AwsBootstrapPreflightStatus;
  readonly code: AwsBootstrapPreflightCode;
}

export interface AwsBootstrapPreflight {
  readonly status: AwsBootstrapPreflightStatus;
  readonly code: AwsBootstrapPreflightCode;
  readonly families: readonly AwsBootstrapFamilyReadback[];
  readonly roles: readonly AwsBootstrapRoleReadback[];
  /** An inventory of these roles does not establish account-wide legacy disuse. */
  readonly legacyPolicy: "present" | "absent" | "unavailable" | "conflict";
  readonly checklist: readonly string[];
}

const CHECKLIST = Object.freeze([
  "Confirm the saved account, region and exact bootstrap suffix against the customer's owning stack or module outputs.",
  "Have the customer stack owner review and update the existing CloudFormation stack or bootstrap OpenTofu module first, keeping its parameters and legacy boundary.",
  "Repeat read-only preflight after the stack update. Resolve unavailable reads and identity, version, size or family conflicts before planning workload migration.",
  "Review the native environment plan and each owned role's family boundary, including role replacements from naming changes. Apply only through the existing approved execution path.",
  "Keep every legacy boundary attached until that role's reviewed apply replaces it directly with its exact family boundary. Never detach a boundary as an intermediate step.",
  "Have the customer administrator independently inventory all users and roles using the legacy policy before considering its retirement. This bounded role inventory cannot establish zero account-wide uses.",
  "Obtain independent IAM authorization acceptance for the required operations. Readback alone does not establish effective permissions.",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isVersionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && VERSION_ID.test(value);
}

function isMissing(error: unknown): boolean {
  try {
    return record(error) && error.name === "NoSuchEntityException";
  } catch {
    return false;
  }
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length || !value.every((item) => typeof item === "string")) return false;
  return new Set(value).size === expected.length && expected.every((item) => value.includes(item));
}

function policyStrings(value: unknown): boolean {
  return typeof value === "string" ? value.length > 0 : Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}

/** Bound hostile JSON before traversing it, and never include document values in diagnostics. */
function boundedJson(value: unknown, depth = 0, budget = { remaining: 2_048 }): boolean {
  if (depth > 12 || --budget.remaining < 0) return false;
  if (typeof value === "string") return value.length <= 2_048;
  if (value === null || typeof value === "boolean" || typeof value === "number") return true;
  if (Array.isArray(value)) return value.length <= 128 && value.every((item) => boundedJson(item, depth + 1, budget));
  if (!record(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 64 && entries.every(([key, item]) => key.length <= 128 && boundedJson(item, depth + 1, budget));
}

function inspectDocument(raw: unknown, family: AwsRoleFamily, context: AwsBootstrapContext): { code: AwsBootstrapPreflightCode; size?: number } {
  if (typeof raw !== "string" || raw.length > MAX_DOCUMENT) return { code: "policy_document" };
  let document: unknown;
  try {
    // GetPolicyVersion uses RFC 3986 encoding; SDKs may already decode it. Decode once only.
    const text = raw.trimStart().startsWith("{") ? raw : decodeURIComponent(raw);
    if (text.length > MAX_DECODED_DOCUMENT || !/^[\u0009\u000A\u000D\u0020-\u00FF]*$/.test(text)) return { code: "policy_document" };
    document = JSON.parse(text);
  } catch {
    return { code: "policy_document" };
  }
  if (!record(document) || !boundedJson(document) || document.Version !== "2012-10-17" || !Array.isArray(document.Statement) || document.Statement.length === 0 || document.Statement.length > 64) return { code: "policy_document" };
  const size = JSON.stringify(document).replace(/\s+/g, "").length;
  if (size > MAX_POLICY_SIZE) return { code: "policy_size", size };
  const principals = roleFamilyPatterns(family).map((pattern) => `arn:${context.partition}:iam::${context.accountId}:role/${pattern}`);
  let allows = 0;
  let familyDeny = false;
  for (const statement of document.Statement) {
    if (!record(statement) || !["Allow", "Deny"].includes(String(statement.Effect)) || !policyStrings(statement.Action) || !policyStrings(statement.Resource) || "Principal" in statement || "NotPrincipal" in statement || "NotAction" in statement || "NotResource" in statement) return { code: "policy_family", size };
    if (statement.Effect === "Allow") {
      allows++;
      if (!record(statement.Condition) || !record(statement.Condition.ArnLike) || !sameStrings(statement.Condition.ArnLike["aws:PrincipalArn"], principals)) return { code: "policy_family", size };
    } else if (statement.Action === "*" && statement.Resource === "*" && record(statement.Condition) && Object.keys(statement.Condition).length === 1 && record(statement.Condition.ArnNotLike) && Object.keys(statement.Condition.ArnNotLike).length === 1 && sameStrings(statement.Condition.ArnNotLike["aws:PrincipalArn"], principals)) {
      familyDeny = true;
    }
  }
  // This is the family discriminator in the committed CFN and generated OpenTofu policies.
  // It does not compare all permission statements or evaluate AWS authorization.
  return { code: allows > 0 && familyDeny ? "compatible" : "policy_family", size };
}

function policyIdentity(policy: Policy | undefined, arn: string, name: string): policy is Policy & { PolicyId: string; DefaultVersionId: string } {
  return !!policy && policy.Arn === arn && policy.PolicyName === name && policy.Path === "/" && policy.IsAttachable === true &&
    typeof policy.PolicyId === "string" && POLICY_ID.test(policy.PolicyId) && isVersionId(policy.DefaultVersionId);
}

async function inspectFamily(client: IAMClient, family: AwsRoleFamily, context: AwsBootstrapContext, arn: string, signal: AbortSignal): Promise<AwsBootstrapFamilyReadback> {
  const result = (status: AwsBootstrapPreflightStatus, code: AwsBootstrapPreflightCode, detail: { defaultVersionId?: string; policySize?: number } = {}): AwsBootstrapFamilyReadback => Object.freeze({ family, policyArn: arn, status, code, ...detail });
  const name = `${AWS_ROLE_BOUNDARIES[family].policyName}${context.bootstrapNameSuffix}`;
  let captured = false;
  try {
    const first = (await client.send(new GetPolicyCommand({ PolicyArn: arn }), { abortSignal: signal })).Policy;
    if (!policyIdentity(first, arn, name)) return result("conflict", "policy_identity");
    captured = true;
    const version = (await client.send(new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: first.DefaultVersionId }), { abortSignal: signal })).PolicyVersion;
    if (!version || version.VersionId !== first.DefaultVersionId || version.IsDefaultVersion !== true) return result("conflict", "policy_version");
    const document = inspectDocument(version.Document, family, context);
    if (document.code !== "compatible") return result("conflict", document.code, { policySize: document.size });
    const last = (await client.send(new GetPolicyCommand({ PolicyArn: arn }), { abortSignal: signal })).Policy;
    if (!policyIdentity(last, arn, name) || last.PolicyId !== first.PolicyId || last.DefaultVersionId !== first.DefaultVersionId) return result("conflict", "policy_changed");
    return result("readback_compatible", "compatible", { defaultVersionId: first.DefaultVersionId, policySize: document.size });
  } catch (error) {
    // Missing first-read policies need a stack upgrade. A disappearance after capture is a conflict.
    if (isMissing(error)) return result(captured ? "conflict" : "needs_stack_upgrade", captured ? "policy_changed" : "policy_missing");
    return result("unavailable", "read_unavailable");
  }
}

function familyForRole(arn: string, context: AwsBootstrapContext): AwsRoleFamily | undefined {
  const role = parseRoleArn(arn);
  if (!role || role.partition !== context.partition || role.accountId !== context.accountId || role.path !== "" || !role.name.startsWith(NAME_PREFIX)) return undefined;
  return FAMILIES.find((family) => AWS_ROLE_BOUNDARIES[family].suffixes.some((suffix) => role.name.endsWith(suffix)));
}

function captureScope(config: AwsConnectionConfig, inventory: AwsBootstrapRoleInventory): { context: AwsBootstrapContext; inventory: AwsBootstrapRoleInventory } {
  try {
    const context = awsBootstrapContextForConnection(config);
    if (config.endpoint !== undefined || config.mode === "static_dev" || typeof inventory.workspaceId !== "string" || typeof inventory.environmentId !== "string" || !ENVIRONMENT_ID_PATTERN.test(inventory.workspaceId) || !ENVIRONMENT_ID_PATTERN.test(inventory.environmentId) || !Array.isArray(inventory.roleArns) || inventory.roleArns.length > MAX_ROLES || new Set(inventory.roleArns).size !== inventory.roleArns.length || inventory.roleArns.some((arn) => !familyForRole(arn, context))) throw new Error("Invalid scope.");
    return { context, inventory: Object.freeze({ workspaceId: inventory.workspaceId, environmentId: inventory.environmentId, roleArns: Object.freeze([...inventory.roleArns].sort()) }) };
  } catch {
    throw new SessionPolicyError("AWS bootstrap preflight scope is invalid.");
  }
}

/** A narrower policy for the existing broker request API, never a new grant or authorization API. */
export function awsBootstrapPreflightSessionPolicy(config: AwsConnectionConfig, inventory: AwsBootstrapRoleInventory): Readonly<Record<string, unknown>> {
  const captured = captureScope(config, inventory);
  const boundaries = resolveAwsRoleBoundaries(captured.context);
  const legacy = `arn:${captured.context.partition}:iam::${captured.context.accountId}:policy/ZenithWorkloadBoundary${captured.context.bootstrapNameSuffix}`;
  const statements: Readonly<Record<string, unknown>>[] = [Object.freeze({
    Effect: "Allow", Action: Object.freeze(["iam:GetPolicy", "iam:GetPolicyVersion"]),
    Resource: Object.freeze([...FAMILIES.map((family) => boundaries[family]), legacy]),
  })];
  if (captured.inventory.roleArns.length > 0) statements.push(Object.freeze({ Effect: "Allow", Action: "iam:GetRole", Resource: captured.inventory.roleArns }));
  const document = Object.freeze({ Version: "2012-10-17", Statement: Object.freeze(statements) });
  // Existing STS validator fails closed above 2,048 compact characters, before any broker request.
  validateSessionPolicy(document);
  return document;
}

async function inspectRole(client: IAMClient, arn: string, family: AwsRoleFamily, boundary: string, legacy: string, inventory: AwsBootstrapRoleInventory, signal: AbortSignal): Promise<AwsBootstrapRoleReadback> {
  const result = (status: AwsBootstrapPreflightStatus, code: AwsBootstrapPreflightCode): AwsBootstrapRoleReadback => Object.freeze({ roleArn: arn, family, expectedBoundaryArn: boundary, status, code });
  const parsed = parseRoleArn(arn);
  if (!parsed) return result("conflict", "role_identity");
  try {
    const role = (await client.send(new GetRoleCommand({ RoleName: parsed.name }), { abortSignal: signal })).Role;
    if (!role || role.Arn !== arn || role.RoleName !== parsed.name || role.Path !== "/" || typeof role.RoleId !== "string" || !/^\w{16,128}$/.test(role.RoleId)) return result("conflict", "role_identity");
    const tags = role.Tags;
    if (!Array.isArray(tags) || tags.length > 50 || !tags.every((tag) => typeof tag.Key === "string" && tag.Key.length <= 128 && typeof tag.Value === "string" && tag.Value.length <= 256) || new Set(tags.map((tag) => tag.Key)).size !== tags.length ||
      ![[TAG_MANAGED, "true"], [TAG_WORKSPACE, inventory.workspaceId], [TAG_ENVIRONMENT, inventory.environmentId]].every(([key, value]) => tags.some((tag) => tag.Key === key && tag.Value === value))) return result("conflict", "role_ownership");
    if (role.PermissionsBoundary?.PermissionsBoundaryType !== "PermissionsBoundaryPolicy") return result("conflict", "role_boundary");
    if (role.PermissionsBoundary.PermissionsBoundaryArn === boundary) return result("readback_compatible", "compatible");
    if (role.PermissionsBoundary.PermissionsBoundaryArn === legacy) return result("migration_required", "legacy_boundary");
    return result("conflict", "role_boundary");
  } catch (error) {
    return result(isMissing(error) ? "conflict" : "unavailable", isMissing(error) ? "role_missing" : "read_unavailable");
  }
}

/**
 * Called only inside an existing authorized broker callback. No IAM writes, credentials,
 * client injection, permission widening, account-wide ownership claim or authorization proof.
 * At most 51 SDK sends, bounded by one 30-second abort signal and the session's own guard.
 */
export async function preflightAwsBootstrap(session: AwsSession, config: AwsConnectionConfig, inventory: AwsBootstrapRoleInventory): Promise<AwsBootstrapPreflight> {
  const result = (status: AwsBootstrapPreflightStatus, code: AwsBootstrapPreflightCode, families: readonly AwsBootstrapFamilyReadback[] = [], roles: readonly AwsBootstrapRoleReadback[] = [], legacyPolicy: AwsBootstrapPreflight["legacyPolicy"] = "unavailable"): AwsBootstrapPreflight => Object.freeze({ status, code, families: Object.freeze([...families]), roles: Object.freeze([...roles]), legacyPolicy, checklist: CHECKLIST });
  let context: AwsBootstrapContext;
  let ownedInventory: AwsBootstrapRoleInventory;
  try {
    const captured = captureScope(config, inventory);
    context = captured.context;
    ownedInventory = captured.inventory;
    if (session.provider !== "aws" || session.accountId !== context.accountId || session.region !== config.region || !["direct", "runner"].includes(session.transport)) return result("conflict", "invalid_scope");
  } catch {
    return result("conflict", "invalid_scope");
  }
  let client: IAMClient;
  try {
    client = session.client(IAMClient);
  } catch {
    return result("unavailable", "session_unavailable");
  }
  const signal = AbortSignal.timeout(30_000);
  const boundaries = resolveAwsRoleBoundaries(context);
  const legacyName = `ZenithWorkloadBoundary${context.bootstrapNameSuffix}`;
  const legacyArn = `arn:${context.partition}:iam::${context.accountId}:policy/${legacyName}`;
  const families: AwsBootstrapFamilyReadback[] = [];
  for (const family of FAMILIES) families.push(await inspectFamily(client, family, context, boundaries[family], signal));
  let legacyPolicy: AwsBootstrapPreflight["legacyPolicy"];
  try {
    const policy = (await client.send(new GetPolicyCommand({ PolicyArn: legacyArn }), { abortSignal: signal })).Policy;
    legacyPolicy = policyIdentity(policy, legacyArn, legacyName) ? "present" : "conflict";
  } catch (error) {
    legacyPolicy = isMissing(error) ? "absent" : "unavailable";
  }
  const roles: AwsBootstrapRoleReadback[] = [];
  for (const arn of [...ownedInventory.roleArns].sort()) {
    const family = familyForRole(arn, context);
    if (!family) return result("conflict", "invalid_scope");
    roles.push(await inspectRole(client, arn, family, boundaries[family], legacyArn, ownedInventory, signal));
  }
  if (legacyPolicy === "conflict" || (legacyPolicy === "absent" && roles.some((role) => role.code === "legacy_boundary"))) return result("conflict", "policy_identity", families, roles, legacyPolicy);
  const ordered = [...families, ...roles];
  const problem = ordered.find((item) => item.status === "conflict") ?? ordered.find((item) => item.status === "unavailable");
  if (problem) return result(problem.status, problem.code, families, roles, legacyPolicy);
  if (legacyPolicy === "unavailable") return result("unavailable", "read_unavailable", families, roles, legacyPolicy);
  const upgrade = families.find((item) => item.status === "needs_stack_upgrade");
  if (upgrade) return result("needs_stack_upgrade", upgrade.code, families, roles, legacyPolicy);
  if (roles.some((role) => role.code === "legacy_boundary")) return result("migration_required", "legacy_boundary", families, roles, legacyPolicy);
  return result("readback_compatible", "compatible", families, roles, legacyPolicy);
}
