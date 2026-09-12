/** Private-app publishing reuses the fixed source contract and hosted pipeline.
 * The hosted authority transaction holds grant and active-release checks through
 * job admission. The separate dispatch journal stays at-most-once, not exactly-once.
 */
import { authority, type Repos } from "@/lib/hosted/authority";
import { SOURCE_LIMITS, RECIPE_V1 } from "@/lib/hosted/contracts";
import { createAdminClient } from "@/lib/supabase/admin";
import { appHostname } from "@/lib/hosted/config";
import { ensureBoot } from "@/lib/server/boot";
import { runAction, type ActionResult } from "@/lib/actions/core";
import { flushPendingAsync } from "@/lib/db/store";
import { redact, type SelectedScope } from "@/lib/agent-access/security";
import { assertWrites, journal, liveMember, publicReceipt, operationView } from "./application";
import { requireScope, ownerOf, object, type AgentGrant } from "./access";
import { OperationError, digest, type Intent, type Receipt, type Operation } from "./journal";
import { uploads, validateArchive, type Upload } from "./uploads";

/** A live account check, not a cached JWT or an enrollment claim. */
export async function verifyHostedIdentity(subject: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      createAdminClient().auth.admin.getUserById(subject),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("identity timeout")), 5000); }),
    ]);
    if (result.error || !result.data.user) throw new OperationError("identity_unavailable", "The live identity provider did not confirm this account. Access is denied; check account and identity-service status.", 503);
    const user = result.data.user as unknown as Record<string, unknown>;
    if (!user.email_confirmed_at || typeof user.banned_until === "string" && Date.parse(user.banned_until) > Date.now() || user.deleted_at)
      throw new OperationError("identity_denied", "A confirmed, active identity-provider account is required for private-app changes.", 403);
  } finally { clearTimeout(timer); }
}
export async function permittedApp(repos: Repos, grant: AgentGrant, appId: string, owner = false) {
  if (!grant.appIds?.includes(appId)) throw new OperationError("app_not_found", "No permitted private app matches this grant.", 404);
  const app = await repos.apps.get(appId), access = await repos.grants.activeFor(appId, grant.subject);
  if (!app || app.workspaceId !== grant.workspaceId || !access || owner && access.role !== "owner") throw new OperationError("app_not_found", "No permitted private app matches this grant.", 404);
  liveMember(grant.subject, grant.workspaceId, owner ? "editor" : "viewer");
  return { app, access };
}
function fingerprint(app: Awaited<ReturnType<typeof permittedApp>>, intent: Intent): string {
  return digest({ app: app.app, grant: { id: app.access.id, role: app.access.role, state: app.access.state, updatedAt: app.access.updatedAt }, intent });
}
function actionInput(intent: Intent, grant: AgentGrant, selected: SelectedScope) {
  const appId = String(intent.input.appId), jobId = String(intent.input.jobId);
  if (intent.kind === "rollback_app") return { id: "app.rollback", input: { appId, jobId, releaseId: intent.input.releaseId } };
  const source = uploads().get(String(intent.input.uploadId), ownerOf(grant, selected), appId);
  if (source.metadata.sha256 !== intent.input.sourceSha256) throw new OperationError("source_digest_mismatch", "The uploaded source does not match this reviewed publish. Prepare a new review.");
  return { id: "app.publish", input: { appId, jobId, source: { kind: "tarball", base64: source.bytes.toString("base64"), filename: "source.tar" } } };
}
export async function acceptUpload(id: string, appId: string, bytes: Buffer, expectedDigest: string, grant: AgentGrant, selected: SelectedScope): Promise<Upload> {
  requireScope(grant, "publish"); assertWrites(); await ensureBoot(); await verifyHostedIdentity(grant.subject);
  await authority().tx(async repos => { await permittedApp(repos, grant, appId, true); });
  const validated = validateArchive(bytes);
  return authority().tx(async repos => {
    await permittedApp(repos, grant, appId, true); requireScope(grant, "publish");
    return uploads().put(id, ownerOf(grant, selected), appId, bytes, expectedDigest, validated);
  });
}
export async function prepareHosted(kind: "publish" | "rollback_app", args: Record<string, unknown>, requestId: string, grant: AgentGrant, selected: SelectedScope) {
  requireScope(grant, "plan"); requireScope(grant, "publish"); assertWrites(); await ensureBoot(); await verifyHostedIdentity(grant.subject);
  const appId = String(args.appId);
  let intent: Intent;
  if (kind === "publish") {
    const source = uploads().get(String(args.uploadId), ownerOf(grant, selected), appId);
    intent = { kind, input: { appId, jobId: requestId, uploadId: source.metadata.id, sourceSha256: source.metadata.sha256 } };
  } else intent = { kind, input: { appId, jobId: requestId, releaseId: String(args.releaseId) } };
  const initial = await authority().tx(async repos => fingerprint(await permittedApp(repos, grant, appId, true), intent));
  const action = actionInput(intent, grant, selected), actor = liveMember(grant.subject, grant.workspaceId, "editor");
  const result = await runAction(action.id, { ...selected, actor: { type: "user", id: actor.id, name: `${actor.name} via Zenith integration` } }, action.input, { mode: "plan" });
  if (!result.plan) throw new OperationError("plan_failed", "The hosted pipeline did not produce a review. Inspect its runtime and builder configuration.");
  return authority().tx(async repos => {
    const state = fingerprint(await permittedApp(repos, grant, appId, true), intent);
    if (state !== initial) throw new OperationError("plan_stale", "App state or grants changed during preparation. Review the current release and prepare again.");
    const receipt = journal().prepare(ownerOf(grant, selected), intent, state, { ...result.plan, requiredRole: "admin", requiresApproval: true }, requestId);
    return { ...publicReceipt(receipt), appId, sourceSha256: intent.input.sourceSha256 };
  });
}
export async function authorizeAppReview(receipt: Receipt, subject: string): Promise<void> {
  if (receipt.intent.kind !== "publish" && receipt.intent.kind !== "rollback_app") return;
  await ensureBoot(); await verifyHostedIdentity(subject);
  const appId = String(receipt.intent.input.appId), app = await authority().repos.apps.get(appId), access = await authority().repos.grants.activeFor(appId, subject);
  if (!app || app.workspaceId !== receipt.owner.workspaceId || access?.role !== "owner") throw new OperationError("app_review_denied", "The independent reviewer must currently own this private app as well as hold the required workspace role.", 403);
}
export async function executeHosted(receipt: Receipt, key: string, grant: AgentGrant, selected: SelectedScope) {
  requireScope(grant, "execute"); requireScope(grant, "publish"); assertWrites(); await ensureBoot(); await verifyHostedIdentity(grant.subject);
  const store = journal(), owner = ownerOf(grant, selected), appId = String(receipt.intent.input.appId);
  let reserved: Operation | undefined, result: ActionResult | undefined;
  try {
    await authority().tx(async repos => {
      const current = await permittedApp(repos, grant, appId, true);
      const approver = receipt.approval ? await repos.grants.activeFor(appId, receipt.approval.subject) : null;
      const action = actionInput(receipt.intent, grant, selected);
      const claimed = store.claim(receipt.id, owner, key, fresh => {
        requireScope(grant, "execute"); requireScope(grant, "publish");
        liveMember(grant.subject, grant.workspaceId, "editor"); liveMember(fresh.approval!.subject, grant.workspaceId, fresh.preview.requiredRole);
        if (approver?.role !== "owner") throw new OperationError("approval_revoked", "The reviewer no longer owns this private app. Prepare a fresh review.", 403);
        if (fingerprint(current, fresh.intent) !== fresh.stateHash) throw new OperationError("plan_stale", "The app's active release, state or access grant changed after review. Prepare again.");
      });
      reserved = claimed.operation;
      if (!claimed.created) return;
      const actor = liveMember(grant.subject, grant.workspaceId, "editor");
      const response = await runAction(action.id, { ...selected, actor: { type: "user", id: actor.id, name: `${actor.name} via Zenith integration [${reserved.id}]` } }, action.input, { mode: "execute", idempotencyKey: reserved.id });
      result = response.result;
    }); // hosted COMMIT happens before recording an accepted dispatch
    await flushPendingAsync();
  } catch (error) {
    if (!reserved) throw error;
    const uncertain = store.settle(reserved.id, "needs_reconciliation", { summary: "The hosted transaction or its acknowledgement was interrupted. Inspect the durable job before any replacement publish; this operation will not be redispatched.", jobId: receipt.intent.input.jobId, appId });
    return hostedOperationView(uncertain, grant, selected);
  }
  if (!reserved) throw new OperationError("dispatch_unavailable", "No dispatch was reserved. Inspect the receipt state before retrying.");
  if (!result) return hostedOperationView(reserved, grant, selected);
  const data = object(result.data) ? result.data : {};
  const completed = store.settle(reserved.id, result.ok ? "accepted" : "failed", { ok: result.ok, summary: redact(result.summary), error: redact(result.error),
    ...(typeof data.jobId === "string" ? { jobId: data.jobId } : {}), appId });
  return hostedOperationView(completed, grant, selected);
}
export async function hostedOperationView(operation: Operation, grant: AgentGrant, selected: SelectedScope) {
  const basic = operationView(operation, grant, selected);
  if (typeof operation.result?.jobId !== "string" || typeof operation.result.appId !== "string") return basic;
  await ensureBoot();
  const { app } = await permittedApp(authority().repos, grant, operation.result.appId);
  const job = await authority().repos.jobs.get(operation.result.jobId);
  if (!job || job.appId !== app.id || job.workspaceId !== grant.workspaceId) return { ...basic, job: null };
  return { ...basic, job: { id: job.id, status: job.status, phase: job.phase, result: redact(job.result), error: redact(job.error) }, app: { id: app.id, activeReleaseId: app.activeReleaseId, state: app.state, hostname: appHostname(app.slug) },
    notice: "Job acceptance is not publication success. Follow the job and active release; failed candidates must not replace a healthy release." };
}
export async function readHosted(name: string, args: Record<string, unknown>, grant: AgentGrant) {
  requireScope(grant, "read"); await ensureBoot();
  if (name === "zenith_get_source_contract") return { contractVersion: 1, recipe: RECIPE_V1, limits: SOURCE_LIMITS, source: "React/Vite frontend only; fixed broker backend. No submitted scripts, config, lockfiles, extra dependencies, dotfiles, links or paths outside src/public.", transfer: "Use the binary source-upload endpoint through the local packager, never base64 in a model tool call." };
  if (name === "zenith_list_apps") {
    const items = [];
    for (const id of grant.appIds ?? []) {
      const app = await authority().repos.apps.get(id), access = await authority().repos.grants.activeFor(id, grant.subject);
      if (app?.workspaceId === grant.workspaceId && access) items.push({ id: app.id, name: app.name, slug: app.slug, state: app.state, role: access.role, activeReleaseId: app.activeReleaseId });
    }
    return { items };
  }
  const { app, access } = await permittedApp(authority().repos, grant, String(args.appId));
  const releases = await authority().repos.releases.listByApp(app.id);
  return { app: { id: app.id, name: app.name, slug: app.slug, state: app.state, activeReleaseId: app.activeReleaseId, role: access.role, hostname: appHostname(app.slug) },
    releases: releases.slice(0, 50).map(r => ({ id: r.id, number: r.number, status: r.status, schemaVersion: r.schemaVersion })) };
}
