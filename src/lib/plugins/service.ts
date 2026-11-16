/**
 * Plugin lifecycle and authentication (PROD-UX-03).
 *
 *   register   verify the manifest signature against a trusted publisher key,
 *              then store it `pending_review` for ONE workspace
 *   review     a workspace admin approves an exact manifest digest and chooses
 *              which declared tools/scopes to allow (or rejects it)
 *   issue      a member binds one of THEIR OWN linked credentials to an
 *              approved plugin and receives an opaque, audience-bound `zp_`
 *              token (shown once, stored only as a hash)
 *   revoke     registration + every grant die in one transaction
 *   authenticate  every MCP request: token hash -> live grant + live approved
 *              registration + live parent credential, all checked now
 *
 * No token passthrough. The plugin never holds the parent credential, an OAuth
 * access token, or anything usable at another resource: the `zp_` token is
 * minted here, is accepted only by the MCP v3 endpoint whose URL is its stored
 * audience, and authenticates as the PARENT credential attenuated to the
 * approved tools and scopes. Zenith forwards no inbound bearer anywhere.
 *
 * No direct credential or store access. A plugin's only interface is the MCP
 * tool catalog; the manifest cannot declare anything else, and the token is
 * worthless at other resources. Launcher children use `za_` minted by the link
 * protocol but are stored only in plugin_grants, so the general credential
 * authority refuses them. v3 and launch/check enforce their plugin binding.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import * as repos from "@/lib/controlplane/db/repos";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { INTEGRATION_SCOPES, type IntegrationScope, type ToolName } from "@/lib/agent-access/v3/contract";
import { toolDescriptor } from "@/lib/agent-access/v3/catalog";
import type { AgentIdentity, PluginBinding } from "@/lib/agent-access/v3/principal";
import { mintToken } from "@/lib/agent-access/link/protocol";
import { LAUNCH_TOKEN_PATTERN, LaunchBinding, LaunchLease, launchIds } from "./launch-contract";
import { PluginError } from "./errors";
import { manifestDigestOf, parseManifest, PluginManifest, trustedPublishersFromEnv, verifyProvenance, type TrustedPublishers } from "./manifest";

export const PLUGIN_TOKEN_PREFIX = "zp_" as const;
export const PLUGIN_TOKEN_PATTERN = /^zp_[A-Za-z0-9_-]{43}$/;
export const MAX_PLUGIN_TOKEN_DAYS = 30;

export interface ParentCredential {
  id: string;
  subject: string;
  workspaceId: string;
  projectIds: readonly string[];
  environmentIds?: readonly string[];
  scopes: readonly string[];
  expiresAt: string;
  revokedAt?: string;
}

/** Looks up a linked credential that is live right now, or `null`. */
export type ParentLookup = (subject: string, workspaceId: string, credentialId: string) => Promise<ParentCredential | null>;

export interface PluginDeps {
  sql: Sql;
  parents: ParentLookup;
  publishers?: () => TrustedPublishers;
  now?: () => number;
  /** Re-read membership and ownership of every explicitly selected target.
   * Required for launcher children; missing wiring is a refusal. */
  assertLaunchScope?: (identity: AgentIdentity) => Promise<void>;
}

const nowOf = (deps: PluginDeps): number => (deps.now ?? Date.now)();
export const hashPluginToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** Store errors that carry a meaning for plugin callers keep it; everything else passes through. */
function mapStore(error: unknown): never {
  if (error instanceof ControlStoreError) {
    if (error.code === "not_found" || error.code === "tenant_mismatch") throw new PluginError("plugin_not_found", "Plugin not found.");
    if (error.code === "conflict" || error.code === "digest_mismatch" || error.code === "invalid_state") throw new PluginError("plugin_conflict", error.message, error.details);
    if (error.code === "invalid_input") throw new PluginError("plugin_manifest_invalid", error.message, error.details);
  }
  throw error;
}

/* -------------------------------- lifecycle ------------------------------- */

export async function registerPlugin(deps: PluginDeps, input: { workspaceId: string; manifest: unknown; requestedBy: string }): Promise<repos.plugins.PluginRegistration & { created: boolean }> {
  const parsed = parseManifest(input.manifest);
  const provenance = verifyProvenance(parsed, (deps.publishers ?? trustedPublishersFromEnv)(), new Date(nowOf(deps)));
  try {
    const { registration, created } = await repos.plugins.register(deps.sql, {
      workspaceId: input.workspaceId,
      pluginId: parsed.manifest.id,
      pluginVersion: parsed.manifest.version,
      manifestDigest: parsed.manifestDigest,
      artifactDigest: parsed.artifactDigest,
      publisherId: parsed.manifest.publisher.id,
      manifest: parsed.manifest as unknown as Record<string, unknown>,
      provenance: provenance as unknown as Record<string, unknown>,
      requestedBy: input.requestedBy,
    });
    return { ...registration, created };
  } catch (error) {
    return mapStore(error);
  }
}

export interface ReviewInput {
  workspaceId: string;
  registrationId: string;
  manifestDigest: string;
  decision: "approve" | "reject";
  tools?: readonly string[];
  scopes?: readonly string[];
  reviewedBy: string;
}

export async function reviewPlugin(deps: PluginDeps, input: ReviewInput): Promise<repos.plugins.PluginRegistration> {
  const current = await repos.plugins.get(deps.sql, input.workspaceId, input.registrationId);
  if (!current) throw new PluginError("plugin_not_found", "Plugin not found.");
  // The stored manifest must still hash to what was verified; refuse to approve a row that was altered at rest.
  assertIntegrity(current);
  try {
    return await repos.plugins.review(deps.sql, {
      workspaceId: input.workspaceId,
      id: input.registrationId,
      manifestDigest: input.manifestDigest,
      decision: input.decision,
      tools: input.tools ?? [],
      scopes: input.scopes ?? [],
      reviewedBy: input.reviewedBy,
    });
  } catch (error) {
    return mapStore(error);
  }
}

export async function revokePlugin(deps: PluginDeps, input: { workspaceId: string; registrationId: string; revokedBy: string; reason: string }): Promise<{ registration: repos.plugins.PluginRegistration; grantsRevoked: number }> {
  try {
    return await repos.plugins.revoke(deps.sql, { workspaceId: input.workspaceId, id: input.registrationId, revokedBy: input.revokedBy, reason: input.reason });
  } catch (error) {
    return mapStore(error);
  }
}

function assertIntegrity(registration: repos.plugins.PluginRegistration): void {
  const parsed = PluginManifest.safeParse(registration.manifest);
  if (!parsed.success || manifestDigestOf(parsed.data) !== registration.manifestDigest) {
    throw new PluginError("plugin_grant_invalid", "The stored plugin manifest no longer matches its verified digest.");
  }
}

const isScope = (s: string): s is IntegrationScope => (INTEGRATION_SCOPES as readonly string[]).includes(s);
const toolsForScopes = (tools: readonly string[], scopes: readonly string[]): ToolName[] =>
  tools.filter((name): name is ToolName => {
    const tool = toolDescriptor(name);
    return !!tool && scopes.includes(tool.requiredScope);
  });
const intersect = (a: readonly string[], b: readonly string[]): string[] => a.filter((x) => b.includes(x));

/* ---------------------------------- grants -------------------------------- */

export interface IssuedPluginToken {
  /** shown once; only its hash is stored */
  token: string;
  grant: repos.plugins.PluginGrantRecord;
  tools: ToolName[];
}

export async function issuePluginToken(
  deps: PluginDeps,
  input: { workspaceId: string; registrationId: string; credentialId: string; subject: string; audience: string; days: number }
): Promise<IssuedPluginToken> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_PLUGIN_TOKEN_DAYS) {
    throw new PluginError("plugin_manifest_invalid", `days must be a whole number from 1 to ${MAX_PLUGIN_TOKEN_DAYS}.`);
  }
  const registration = await repos.plugins.get(deps.sql, input.workspaceId, input.registrationId);
  if (!registration) throw new PluginError("plugin_not_found", "Plugin not found.");
  if (registration.status === "revoked") throw new PluginError("plugin_revoked", "This plugin was revoked.");
  if (registration.status !== "approved") throw new PluginError("plugin_not_approved", "A workspace admin must approve this plugin before it can be given a token.");
  assertIntegrity(registration);
  // Only the member's own credential can be bound: the lookup is by the signed-in subject.
  const parent = await deps.parents(input.subject, input.workspaceId, input.credentialId);
  if (!parent || parent.subject !== input.subject || parent.workspaceId !== input.workspaceId) {
    throw new PluginError("plugin_forbidden", "Choose one of your own live linked credentials in this workspace.");
  }
  const scopes = intersect(registration.approvedScopes, parent.scopes).filter(isScope);
  if (!scopes.includes("read")) throw new PluginError("plugin_forbidden", "The chosen credential does not hold the read scope the plugin needs.");
  const tools = toolsForScopes(registration.approvedTools, scopes);
  if (!tools.length) throw new PluginError("plugin_forbidden", "The chosen credential holds none of the scopes the approved tools need.");
  const now = nowOf(deps);
  const expires = Math.min(now + input.days * 86_400_000, Date.parse(parent.expiresAt));
  if (!Number.isFinite(expires) || expires <= now) throw new PluginError("plugin_forbidden", "The chosen credential has expired.");
  const token = PLUGIN_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  try {
    const grant = await repos.plugins.createGrant(deps.sql, {
      workspaceId: input.workspaceId,
      registrationId: registration.id,
      tokenHash: hashPluginToken(token),
      audience: input.audience,
      credentialId: parent.id,
      subject: parent.subject,
      scopes,
      projectIds: [...parent.projectIds],
      ...(parent.environmentIds ? { environmentIds: [...parent.environmentIds] } : {}),
      expiresAt: new Date(expires).toISOString(),
      createdBy: input.subject,
    });
    return { token, grant, tools };
  } catch (error) {
    return mapStore(error);
  }
}

export async function revokePluginGrant(deps: PluginDeps, input: { workspaceId: string; grantId: string; revokedBy: string }): Promise<void> {
  if (!(await repos.plugins.revokeGrant(deps.sql, input))) throw new PluginError("plugin_not_found", "That plugin token is not one this workspace can revoke, or it was already revoked.");
}

/**
 * RFC 7009 revocation by possession (PROD-UX-02): whoever holds a valid plugin
 * token may withdraw it. Resolves only a currently valid grant, so an unknown,
 * expired or already revoked token is simply `false` and never an oracle.
 * Audience binding is untouched: this only ever ends a grant.
 */
export async function revokePluginTokenByPossession(deps: PluginDeps, token: string): Promise<boolean> {
  if (!PLUGIN_TOKEN_PATTERN.test(token) && !LAUNCH_TOKEN_PATTERN.test(token)) return false;
  const resolved = await repos.plugins.resolveGrantByTokenHash(deps.sql, hashPluginToken(token));
  if (!resolved) return false;
  return repos.plugins.revokeGrant(deps.sql, { workspaceId: resolved.grant.workspaceId, grantId: resolved.grant.id, revokedBy: `token:${resolved.grant.id}` });
}

/* ------------------------------ authentication ---------------------------- */

const REFUSAL = {
  grant_revoked: ["plugin_grant_invalid", "This plugin token was revoked."],
  grant_expired: ["plugin_grant_invalid", "This plugin token has expired."],
  plugin_revoked: ["plugin_revoked", "This plugin was revoked in this workspace."],
  plugin_not_approved: ["plugin_not_approved", "This plugin is not approved in this workspace."],
  unknown: ["plugin_grant_invalid", "The plugin token is not valid."],
} as const;

/**
 * Resolve a `zp_` bearer to the identity the MCP layer authorizes as: the live
 * parent credential attenuated to the approved scopes/tools. Everything is
 * re-read now; there is no cache, so revocation of the plugin, the grant or the
 * parent credential is effective on the very next request.
 */
export async function authenticatePluginToken(deps: PluginDeps, token: string, audience: string): Promise<AgentIdentity> {
  if (!PLUGIN_TOKEN_PATTERN.test(token) && !LAUNCH_TOKEN_PATTERN.test(token)) throw new PluginError("plugin_grant_invalid", "The plugin token is not valid.");
  const hash = hashPluginToken(token);
  const resolved = await repos.plugins.resolveGrantByTokenHash(deps.sql, hash);
  if (!resolved) {
    const [code, message] = REFUSAL[await repos.plugins.diagnoseTokenHash(deps.sql, hash)];
    throw new PluginError(code, message);
  }
  const { grant, registration } = resolved;
  if (registration.status !== "approved") throw new PluginError("plugin_grant_invalid", "The plugin approval is no longer live.");
  // Audience binding: a token minted for another endpoint or origin is refused here.
  if (grant.audience !== audience) throw new PluginError("plugin_grant_invalid", "This plugin token was issued for a different resource.");
  assertIntegrity(registration);
  const parent = await deps.parents(grant.subject, grant.workspaceId, grant.credentialId);
  if (!parent || parent.id !== grant.credentialId || parent.subject !== grant.subject || parent.workspaceId !== grant.workspaceId || parent.revokedAt || !(Date.parse(parent.expiresAt) > nowOf(deps))) {
    throw new PluginError("plugin_grant_invalid", "The connection this plugin token was issued under is no longer live.");
  }
  const scopes = intersect(intersect(grant.scopes, registration.approvedScopes), parent.scopes);
  if (!scopes.includes("read")) throw new PluginError("plugin_grant_invalid", "The plugin token no longer holds the read scope.");
  const tools = toolsForScopes(registration.approvedTools, scopes);
  const projectIds = intersect(grant.projectIds, parent.projectIds);
  const environmentIds = grant.environmentIds && parent.environmentIds ? intersect(grant.environmentIds, parent.environmentIds) : (grant.environmentIds ?? parent.environmentIds);
  const expiresAt = new Date(Math.min(Date.parse(grant.expiresAt), Date.parse(parent.expiresAt))).toISOString();
  const binding: PluginBinding = {
    registrationId: registration.id,
    grantId: grant.id,
    pluginId: registration.pluginId,
    version: registration.pluginVersion,
    manifestDigest: registration.manifestDigest,
    tools,
  };
  void repos.plugins.touchGrant(deps.sql, grant.workspaceId, grant.id).catch(() => undefined);
  const identity: AgentIdentity = {
    subject: grant.subject,
    integrationId: parent.id,
    workspaceId: grant.workspaceId,
    projectIds,
    ...(environmentIds ? { environmentIds } : {}),
    scopes,
    expiresAt,
    plugin: binding,
  };
  if (LAUNCH_TOKEN_PATTERN.test(token)) {
    verifyProvenance(parseManifest(registration.manifest), (deps.publishers ?? trustedPublishersFromEnv)(), new Date(nowOf(deps)));
    assertFiniteLaunchScope(identity);
    await assertLiveLaunchScope(deps, identity);
  }
  return identity;
}

function assertFiniteLaunchScope(identity: AgentIdentity): void {
  if (!launchIds.safeParse(identity.projectIds).success || !launchIds.safeParse(identity.environmentIds).success ||
      !identity.plugin?.tools.length || !(Date.parse(identity.expiresAt) > Date.now())) {
    throw new PluginError("plugin_grant_invalid", "A launcher requires live, finite project and environment grants.");
  }
}
async function assertLiveLaunchScope(deps: PluginDeps, identity: AgentIdentity): Promise<void> {
  if (!deps.assertLaunchScope) throw new PluginError("plugin_unavailable", "The live launcher scope authority is unavailable.");
  await deps.assertLaunchScope(identity);
}

/** A child is hashed in platform.plugin_grants, never agent.agent_credentials.
 * It can therefore authenticate only at the plugin-aware v3 resource and the
 * launcher check, not REST, v1/v2, link approvals or browser management. */
export async function issueLauncherToken(deps: PluginDeps, input: {
  workspaceId: string; registrationId: string; manifestDigest: string; credentialId: string;
  subject: string; audience: string; projectIds: string[]; environmentIds: string[]; minutes: number;
}): Promise<IssuedPluginToken> {
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 1440 ||
      !launchIds.safeParse(input.projectIds).success || !launchIds.safeParse(input.environmentIds).success) {
    throw new PluginError("plugin_manifest_invalid", "Choose finite targets and a lifetime of 1 to 1440 minutes.");
  }
  const resource = new URL(input.audience);
  if (resource.protocol !== "https:" || resource.username || resource.password || resource.search || resource.hash || resource.pathname !== "/api/agent/v3/mcp") {
    throw new PluginError("plugin_forbidden", "Launcher tokens require the trusted HTTPS MCP v3 resource.");
  }
  const registration = await repos.plugins.get(deps.sql, input.workspaceId, input.registrationId);
  if (!registration) throw new PluginError("plugin_not_found", "Plugin not found.");
  if (registration.status !== "approved") throw new PluginError("plugin_not_approved", "An admin must approve the exact signed manifest first.");
  assertIntegrity(registration);
  if (registration.manifestDigest !== input.manifestDigest) throw new PluginError("plugin_conflict", "Review the current manifest digest.");
  verifyProvenance(parseManifest(registration.manifest), (deps.publishers ?? trustedPublishersFromEnv)(), new Date(nowOf(deps)));
  const parent = await deps.parents(input.subject, input.workspaceId, input.credentialId);
  if (!parent || parent.id !== input.credentialId || parent.subject !== input.subject || parent.workspaceId !== input.workspaceId || parent.revokedAt ||
      input.projectIds.some((p) => !parent.projectIds.includes(p)) || input.environmentIds.some((e) => parent.environmentIds && !parent.environmentIds.includes(e))) {
    throw new PluginError("plugin_forbidden", "Choose explicit targets within your own live linked credential.");
  }
  const scopes = intersect(registration.approvedScopes, parent.scopes).filter(isScope);
  const tools = toolsForScopes(registration.approvedTools, scopes);
  const expires = Math.min(nowOf(deps) + input.minutes * 60_000, Date.parse(parent.expiresAt));
  if (!scopes.includes("read") || !tools.length || !Number.isFinite(expires) || expires <= nowOf(deps)) {
    throw new PluginError("plugin_forbidden", "The parent cannot grant the approved plugin access.");
  }
  await assertLiveLaunchScope(deps, { subject: parent.subject, workspaceId: parent.workspaceId, integrationId: parent.id,
    projectIds: input.projectIds, environmentIds: input.environmentIds, scopes, expiresAt: new Date(expires).toISOString() });
  const token = mintToken();
  try {
    const grant = await repos.plugins.createGrant(deps.sql, { workspaceId: input.workspaceId, registrationId: registration.id,
      credentialId: parent.id, subject: parent.subject, tokenHash: hashPluginToken(token), audience: input.audience,
      scopes, projectIds: input.projectIds, environmentIds: input.environmentIds, createdBy: input.subject, expiresAt: new Date(expires).toISOString() });
    // A withdrawal while issuing must not return a usable child.
    await authenticatePluginToken(deps, token, input.audience);
    return { token, grant, tools };
  } catch (error) { return mapStore(error); }
}

/** null means this hash has never been a plugin grant. Known expired/revoked
 * children throw, so authentication cannot downgrade to a broader authority. */
export async function resolveLauncherIdentity(deps: PluginDeps, token: string, audience: string): Promise<AgentIdentity | null> {
  if (!LAUNCH_TOKEN_PATTERN.test(token) || !(await repos.plugins.hasGrantTokenHash(deps.sql, hashPluginToken(token)))) return null;
  return authenticatePluginToken(deps, token, audience);
}

export async function checkLauncherLease(deps: PluginDeps, token: string, raw: unknown, audience: string): Promise<LaunchLease> {
  const input = LaunchBinding.safeParse(raw);
  if (!input.success || !LAUNCH_TOKEN_PATTERN.test(token)) throw new PluginError("plugin_grant_invalid", "Invalid launcher binding.");
  const binding = input.data;
  if (binding.credentialDigest !== hashPluginToken(token) || binding.audience !== audience) throw new PluginError("plugin_grant_invalid", "Invalid launcher binding.");
  const identity = await resolveLauncherIdentity(deps, token, audience);
  if (!identity?.plugin || identity.workspaceId !== binding.workspaceId || identity.plugin.registrationId !== binding.registrationId || identity.plugin.manifestDigest !== binding.manifestDigest) {
    throw new PluginError("plugin_grant_invalid", "This credential is not the reviewed launcher child.");
  }
  const lease = LaunchLease.safeParse({ ...binding, status: "active", credentialKind: "plugin_scoped_za",
    projectIds: identity.projectIds, environmentIds: identity.environmentIds, scopes: identity.scopes,
    tools: identity.plugin.tools, expiresAt: identity.expiresAt });
  if (!lease.success || Date.parse(lease.data.expiresAt) > nowOf(deps) + 86_400_000) throw new PluginError("plugin_grant_invalid", "Invalid launcher lease.");
  return lease.data;
}
