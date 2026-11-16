/**
 * Shared plumbing for /api/platform/v1/coding-agent (PROD-MACH-06).
 *
 * Every route is browser-only: a signed-in workspace ADMIN in the Zenith web app
 * (same-origin, live identity check). An agent credential cannot start, resume
 * or adopt a run, so no model-driven client can spend the workspace's model
 * budget or move a proposal into a working copy.
 */
import type { NextRequest } from "next/server";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { currentProductRoleResolver } from "@/lib/capabilities/current-product-roles";
import type { ActionContext } from "@/lib/actions/core";
import type { Principal } from "@/lib/controlplane/types";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { AgentServiceError, type AgentCaller } from "@/lib/coding-agent/service";
import { buildCtx } from "@/lib/server/scope";
import { requireWorkspace } from "@/lib/server/workspace";
import { assertBrowserSession } from "./browser";

export interface AgentRouteCaller {
  agent: AgentCaller;
  principal: Principal;
  ctx: ActionContext;
}

export async function agentAdmin(req: NextRequest): Promise<AgentRouteCaller> {
  const caller = await assertBrowserSession(req, { mutation: req.method !== "GET" });
  if (requireWorkspace().id !== caller.workspaceId) throw notFound();
  let role: string;
  try {
    role = (await currentProductRoleResolver().resolve(caller.principal, caller.workspaceId)).role;
  } catch {
    throw new BrokerError("policy_unavailable", "Workspace membership could not be confirmed, so this was refused.");
  }
  if (role === "none") throw notFound();
  if (role !== "admin") throw new BrokerError("role_insufficient", "Only a workspace admin can run coding agents.", "Ask a workspace admin.");
  return {
    agent: { workspaceId: caller.workspaceId, userId: caller.principal.id },
    principal: caller.principal,
    ctx: buildCtx({}, { type: "user", id: caller.principal.id, name: caller.principal.name }),
  };
}

/** Translate service and store refusals into the platform error body. */
export function mapAgentError(error: unknown): never {
  if (error instanceof AgentServiceError) {
    if (error.code === "not_found") throw notFound();
    if (error.code === "model_not_configured") throw new BrokerError("platform_store_unavailable", error.message, "Set ANTHROPIC_API_KEY on the deployment, then retry.", { reason: "model_not_configured" });
    throw new BrokerError(error.code === "unavailable" ? "platform_store_unavailable" : error.code, error.message);
  }
  if (error instanceof ControlStoreError) {
    if (error.code === "not_found" || error.code === "tenant_mismatch") throw notFound();
    if (error.code === "conflict" || error.code === "invalid_state") throw new BrokerError(error.code, "The run is not in a state that allows this.");
  }
  throw error;
}
