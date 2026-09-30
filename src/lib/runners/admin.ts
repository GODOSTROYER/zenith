/**
 * The session-authenticated (human) half of the runner plane: create a
 * registration token, list agents, revoke an agent. Workspace and role come
 * from `route({ workspaceRole })`; nothing here trusts a workspace id from the
 * URL or body.
 *
 *   POST /api/platform/v1/runners/tokens        admin   → `zrt_…` / `zmt_…`, shown ONCE
 *   GET  /api/platform/v1/{runners|machines}    viewer
 *   POST /api/platform/v1/{runners|machines}/{id}/revoke   admin
 *
 * A revoke of another workspace's agent is a 404 (the store filters on the
 * caller's workspace in SQL), never a 403 that would confirm it exists.
 */
import { z } from "zod";
import { ApiError, json, requireWorkspace, route } from "@/lib/server/context";
import { scopedEnvironment } from "@/lib/server/scope";
import { registryOf, type AgentRecord } from "@/lib/runners/ports";
import { getRunnerRuntime } from "@/lib/runners/runtime";
import { createRegistrationToken, revokeAgent } from "@/lib/runners/service";
import { AgentApiError, MAX_REGISTRATION_TOKEN_TTL_SEC, type AgentKind } from "@/lib/runners/types";

const TokenBody = z
  .object({
    kind: z.enum(["runner", "machine"]).default("runner"),
    ttlMinutes: z.number().int().min(1).max(MAX_REGISTRATION_TOKEN_TTL_SEC / 60).default(MAX_REGISTRATION_TOKEN_TTL_SEC / 60),
    /** machines only: pin the zenithd machine to an environment and/or resource address */
    binding: z
      .object({ environmentId: z.string().min(1).max(128).optional(), address: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/).optional() })
      .strict()
      .optional(),
  })
  .strict();

/** Agent-API errors thrown inside a session route read as the product's `{ error: { message, fix } }`. */
function asApiError<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((error: unknown) => {
    if (error instanceof AgentApiError) throw new ApiError(error.message, error.status === 404 ? 404 : 400, { fix: "Check the id and that the agent belongs to this workspace." });
    throw error;
  });
}

export const createTokenRoute = route({ workspaceRole: "admin" }, async (req, _params, grant) => {
  const parsed = TokenBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) throw new ApiError("Send { kind: \"runner\" | \"machine\", ttlMinutes?: 1-60, binding?: { environmentId?, address? } }.", 400);
  const { kind, ttlMinutes, binding } = parsed.data;
  if (binding && kind !== "machine") throw new ApiError("A binding only applies to machine registration tokens.", 400);
  const workspace = requireWorkspace();
  // a machine bound to an environment must be bound to one of THIS workspace's
  if (binding?.environmentId) scopedEnvironment(binding.environmentId);
  const created = await createRegistrationToken(getRunnerRuntime(), { workspaceId: workspace.id, kind, createdBy: grant.actor.id, ttlSec: ttlMinutes * 60, binding });
  return json({ token: created.token, kind: created.kind, workspaceId: created.workspaceId, expiresAt: created.expiresAt, shownOnce: true }, 201);
});

/** Public, non-secret view of an agent. */
const view = (a: AgentRecord) => ({
  id: a.id,
  name: a.name,
  status: a.status,
  stale: a.stale,
  protocol: a.protocol,
  version: a.version ?? null,
  capabilities: a.capabilities,
  labels: a.labels,
  host: a.host,
  environmentId: a.environmentId ?? null,
  address: a.address ?? null,
  registeredAt: a.registeredAt,
  lastHeartbeatAt: a.lastHeartbeatAt ?? null,
  revokedAt: a.revokedAt ?? null,
});

export const listRoute = (kind: AgentKind) =>
  route({ workspaceRole: "viewer" }, async () => {
    const agents = await registryOf(getRunnerRuntime().store, kind).list(requireWorkspace().id);
    return { [kind === "runner" ? "runners" : "machines"]: agents.map(view) };
  });

export const revokeRoute = (kind: AgentKind) =>
  route<{ id: string }>({ workspaceRole: "admin" }, async (_req, params, grant) =>
    asApiError(async () => json(await revokeAgent(getRunnerRuntime(), kind, requireWorkspace().id, params.id, grant.actor.id)))
  );
