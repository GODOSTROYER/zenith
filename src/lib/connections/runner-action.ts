/** Loaded by the connection route alongside the ordinary lifecycle actions. */
import { defineAction, getAction } from "@/lib/actions/core";
import { db } from "@/lib/db/store";
import { currentProductRoleResolver } from "@/lib/capabilities/current-product-roles";
import { CreateRunnerInput } from "./schemas";
import { createRunnerConnection, HUMAN_REQUIRED_MESSAGE, LifecycleRefusal } from "./service";
import { ConnectionRequest, connectionHandoff } from "./handoff";

defineAction<ConnectionRequest>({
  id: "connection.proposeRunner", title: "Plan a runner connection change", category: "connection", risk: "low", requiredRole: "viewer", mutates: false, input: ConnectionRequest,
  plan(ctx, request) {
    return { summary: "Prepare an identifier-only connection review draft.", details: ["This creates no connection, approval, grant or operation.", `A signed-in ${getAction(request.action).requiredRole} reviews the exact identifiers and confirms in the browser.`, `Unapproved review draft: ${connectionHandoff(request, ctx.workspaceId)}`], costDeltaUsd: 0, risk: "low", warnings: [], requiresApproval: false };
  },
  execute(ctx, request) {
    return { ok: true, summary: "Connection draft ready for human browser confirmation.", data: { request, browserPath: connectionHandoff(request, ctx.workspaceId), requiredRole: getAction(request.action).requiredRole, requiresBrowserConfirmation: true, approved: false, executed: false } };
  },
});

defineAction<CreateRunnerInput>({
  id: "connection.createRunner", title: "Connect a customer runner", category: "connection", risk: "medium", requiredRole: "admin", mutates: true, input: CreateRunnerInput,
  async plan() {
    return { summary: "Save a pending customer-runner connection.", details: ["Identifiers only; no cloud call or credential exchange.", "Verify checks runner readiness, not cloud identity or permissions.", "A current admin must confirm in the signed-in browser; an agent may only propose."], costDeltaUsd: 0, risk: "medium", warnings: [], requiresApproval: true };
  },
  async execute(ctx, input) {
    if (ctx.actor.type !== "user" || ctx.integration || db().members.filter((m) => m.workspaceId === ctx.workspaceId && m.id === ctx.actor.id && m.role === "admin").length !== 1) return { ok: false, summary: "Connection action refused.", error: HUMAN_REQUIRED_MESSAGE };
    try {
      const current = await currentProductRoleResolver().resolve({ kind: "user", id: ctx.actor.id, name: ctx.actor.name }, ctx.workspaceId);
      if (current.role !== "admin") return { ok: false, summary: "Connection action refused.", error: HUMAN_REQUIRED_MESSAGE };
      const made = await createRunnerConnection(ctx, input);
      return { ok: true, summary: "Runner connection saved; verify its readiness before use.", data: { connectionId: made.connection.id, platformConnectionId: made.connection.id, status: made.connection.status, ...made } };
    } catch (error) {
      return { ok: false, summary: "Connection action refused.", error: error instanceof LifecycleRefusal ? error.message : "The platform store or membership authority is unavailable. Restore it and retry." };
    }
  },
});
