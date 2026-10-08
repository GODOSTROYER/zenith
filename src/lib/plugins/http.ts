/**
 * Browser-only management of plugins (PROD-UX-03). Same gate as every other
 * consent surface (`browser()`): a verified, signed-in workspace member in a
 * browser session, same-origin for mutations, and any request carrying an
 * `authorization` header refused, so an agent (or a plugin) can never register,
 * approve, issue to or revoke itself.
 *
 *   GET  /api/integrations/plugins                  list (admin sees all; members see approved ones)
 *   POST /api/integrations/plugins                  register a signed manifest        (admin)
 *   POST /api/integrations/plugins/review           approve an exact digest / reject  (admin)
 *   POST /api/integrations/plugins/revoke           revoke plugin + all its tokens    (admin)
 *   POST /api/integrations/plugins/tokens           issue an audience-bound token     (member, own credential)
 *   POST /api/integrations/plugins/tokens/revoke    revoke one token                  (admin or issuer)
 */
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { route } from "@/lib/server/request";
import { browser } from "@/lib/agent-access/control/browser";
import { assertPrivilegedConsent } from "@/lib/agent-access/control/privileged-consent";
import { controlOrigin, failure, json, jsonBody } from "@/lib/agent-access/control/boundary";
import { resourceFor } from "@/lib/agent-access/v3/auth";
import * as repos from "@/lib/controlplane/db/repos";
import { TOOL_NAMES } from "@/lib/agent-access/v3/contract";
import { PluginError } from "./errors";
import { grantView, view } from "./view";
import { defaultPluginDeps } from "./runtime";
import { issuePluginToken, issueLauncherToken, registerPlugin, revokePlugin, revokePluginGrant, reviewPlugin, MAX_PLUGIN_TOKEN_DAYS } from "./service";
import { launchIds } from "./launch-contract";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digestHex = z.string().regex(/^[0-9a-f]{64}$/);

const registerBody = z.strictObject({ manifest: z.unknown() });
const reviewBody = z.strictObject({
  registrationId: id,
  manifestDigest: digestHex,
  decision: z.enum(["approve", "reject"]),
  tools: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length).optional(),
  scopes: z.array(z.string().regex(/^[a-z]{1,20}$/)).max(6).optional(),
});
const revokeBody = z.strictObject({ registrationId: id, reason: z.string().min(1).max(500) });
const issueBody = z.strictObject({ registrationId: id, credentialId: id, days: z.number().int().min(1).max(MAX_PLUGIN_TOKEN_DAYS).default(7) });
const tokenRevokeBody = z.strictObject({ grantId: id });
const launchIssueBody = z.strictObject({ registrationId: id, manifestDigest: digestHex, credentialId: id,
  projectIds: launchIds, environmentIds: launchIds, minutes: z.number().int().min(1).max(1440).default(60) });

function refuse(error: unknown): Response {
  if (error instanceof z.ZodError) return json({ error: { code: "plugin_manifest_invalid", message: "Supply valid plugin request fields." } }, 400);
  if (error instanceof PluginError) return json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, error.status);
  return failure(error);
}

function requireAdmin(role: string): void {
  if (role !== "admin") throw new PluginError("plugin_forbidden", "Only a workspace admin can do that.");
}

export const pluginsGet = route(async (req: NextRequest) => {
  try {
    const { member, workspace } = await browser(req);
    const deps = await defaultPluginDeps();
    const all = await repos.plugins.list(deps.sql, workspace.id);
    const grants = await repos.plugins.listGrants(deps.sql, workspace.id);
    const visible = member.role === "admin" ? all : all.filter((r) => r.status === "approved");
    return json({
      workspaceId: workspace.id,
      role: member.role,
      resource: resourceFor(controlOrigin()),
      plugins: visible.map(view),
      tokens: grants.filter((g) => visible.some((r) => r.id === g.registrationId) && (member.role === "admin" || g.createdBy === member.id)).map(grantView),
    });
  } catch (error) {
    return refuse(error);
  }
});

export const pluginsRegister = route(async (req: NextRequest) => {
  try {
    const { identity, member, workspace } = await browser(req, true);
    requireAdmin(member.role);
    await assertPrivilegedConsent(req, identity);
    const input = registerBody.parse(await jsonBody(req));
    const registered = await registerPlugin(await defaultPluginDeps(), { workspaceId: workspace.id, manifest: input.manifest, requestedBy: identity.subject });
    return json({ plugin: view(registered), created: registered.created }, registered.created ? 201 : 200);
  } catch (error) {
    return refuse(error);
  }
});

export const pluginsReview = route(async (req: NextRequest) => {
  try {
    const { identity, member, workspace } = await browser(req, true);
    requireAdmin(member.role);
    await assertPrivilegedConsent(req, identity);
    const input = reviewBody.parse(await jsonBody(req));
    const reviewed = await reviewPlugin(await defaultPluginDeps(), { workspaceId: workspace.id, reviewedBy: identity.subject, ...input });
    return json({ plugin: view(reviewed) });
  } catch (error) {
    return refuse(error);
  }
});

export const pluginsRevoke = route(async (req: NextRequest) => {
  try {
    const { identity, member, workspace } = await browser(req, true);
    requireAdmin(member.role);
    const input = revokeBody.parse(await jsonBody(req));
    const result = await revokePlugin(await defaultPluginDeps(), { workspaceId: workspace.id, registrationId: input.registrationId, revokedBy: identity.subject, reason: input.reason });
    return json({ plugin: view(result.registration), grantsRevoked: result.grantsRevoked, effect: "Effective on the plugin's next request. Nothing is cached, and nothing already dispatched is undone." });
  } catch (error) {
    return refuse(error);
  }
});

export const pluginsTokenIssue = route(async (req: NextRequest) => {
  try {
    const { identity, member, workspace } = await browser(req, true);
    if (!["admin", "editor"].includes(member.role)) throw new PluginError("plugin_forbidden", "This role cannot give a plugin access.");
    await assertPrivilegedConsent(req, identity);
    const input = issueBody.parse(await jsonBody(req));
    const issued = await issuePluginToken(await defaultPluginDeps(), {
      workspaceId: workspace.id,
      registrationId: input.registrationId,
      credentialId: input.credentialId,
      subject: identity.subject,
      audience: resourceFor(controlOrigin()),
      days: input.days,
    });
    // The only response that ever contains the token. It is not stored and cannot be shown again.
    return json({ token: issued.token, grantId: issued.grant.id, expiresAt: issued.grant.expiresAt, audience: issued.grant.audience, scopes: issued.grant.scopes, tools: issued.tools }, 201);
  } catch (error) {
    return refuse(error);
  }
});

/** Human approves finite targets for this child. The launcher cannot issue its
 * own credential and never receives the selected parent's bearer. */
export const pluginsLaunchTokenIssue = route(async (req: NextRequest) => {
  try {
    const { identity, member, workspace } = await browser(req, true);
    if (!["admin", "editor"].includes(member.role)) throw new PluginError("plugin_forbidden", "This role cannot give a plugin access.");
    await assertPrivilegedConsent(req, identity);
    const input = launchIssueBody.parse(await jsonBody(req));
    const issued = await issueLauncherToken(await defaultPluginDeps(), { ...input,
      workspaceId: workspace.id, subject: identity.subject, audience: resourceFor(controlOrigin()) });
    return json({ token: issued.token, grantId: issued.grant.id, registrationId: issued.grant.registrationId,
      manifestDigest: input.manifestDigest, workspaceId: workspace.id, expiresAt: issued.grant.expiresAt,
      audience: issued.grant.audience, projectIds: issued.grant.projectIds, environmentIds: issued.grant.environmentIds,
      scopes: issued.grant.scopes, tools: issued.tools }, 201);
  } catch (error) { return refuse(error); }
});

export const pluginsTokenRevoke = route(async (req: NextRequest) => {
  try {
    const { identity, member, workspace } = await browser(req, true);
    const input = tokenRevokeBody.parse(await jsonBody(req));
    const deps = await defaultPluginDeps();
    if (member.role !== "admin") {
      const own = (await repos.plugins.listGrants(deps.sql, workspace.id)).find((g) => g.id === input.grantId);
      if (!own || own.createdBy !== identity.subject) throw new PluginError("plugin_not_found", "That plugin token is not one this workspace can revoke, or it was already revoked.");
    }
    await revokePluginGrant(deps, { workspaceId: workspace.id, grantId: input.grantId, revokedBy: identity.subject });
    return json({ revoked: true, grantId: input.grantId });
  } catch (error) {
    return refuse(error);
  }
});
