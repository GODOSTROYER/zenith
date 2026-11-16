import { platformDb } from "@/lib/controlplane/db";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { getUpdateControl, putUpdateControl, UpdateIntent, type UpdateKind } from "@/lib/controlplane/db/repos/agent-updates";
import { ApiError, currentRequest, json, requireWorkspace, route } from "@/lib/server/context";
import { registryOf } from "@/lib/runners/ports";
import { getRunnerRuntime } from "@/lib/runners/runtime";
import { agentError, agentJson } from "@/lib/runners/http";
import { assertPathAgent, authenticateAgentRequest, parseJsonBody } from "@/lib/runners/request-auth";
import { heartbeatAgent } from "@/lib/runners/service";
import { AgentApiError, MAX_SMALL_BODY_BYTES } from "@/lib/runners/types";

async function api<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof ControlStoreError) throw new ApiError(error.message, error.httpStatus);
    throw error;
  }
}

export const readUpdateRoute = (kind: UpdateKind) => route<{ id: string }>({ workspaceRole: "viewer" }, async (_req, params) => api(async () => {
  const rt = await getRunnerRuntime(), ws = requireWorkspace().id;
  if (!await registryOf(rt.store, kind).get(ws, params.id)) throw new ApiError("Agent not found in this workspace.", 404);
  return json(await getUpdateControl(await platformDb(), ws, kind, params.id));
}));

export const writeUpdateRoute = (kind: UpdateKind) => route<{ id: string }>({ workspaceRole: "admin" }, async (req, params, grant) => api(async () => {
  // Update intent is human browser authority, never a model or integration bearer.
  if (!currentRequest()?.user || grant.actor.id !== currentRequest()?.user?.id) throw new ApiError("A signed-in human admin must request an agent update or hold.", 403);
  const parsed = UpdateIntent.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("Send { expectedRevision, hold, manifestSha256 }; held agents cannot also request an update.", 400);
  const rt = await getRunnerRuntime(), ws = requireWorkspace().id;
  const agent = await registryOf(rt.store, kind).get(ws, params.id);
  if (!agent) throw new ApiError("Agent not found in this workspace.", 404);
  if (agent.status !== "active") throw new ApiError("A revoked agent cannot receive update controls.", 409);
  if (!agent.capabilities.includes("agent.update.control.v1")) throw new ApiError("This agent cannot honor update controls; integrate the MACH-04 loop before enabling update or hold.", 409);
  return json(await putUpdateControl(await platformDb(), ws, kind, params.id, grant.actor.id, parsed.data));
}));

/** Existing signed heartbeat path delivers request-bound, short-lived control JWS. */
export function updateHeartbeatHandler(kind: UpdateKind) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }): Promise<Response> => {
    try {
      const rt = await getRunnerRuntime(), params = await ctx.params;
      const auth = await authenticateAgentRequest(req, kind, rt, { maxBodyBytes: MAX_SMALL_BODY_BYTES });
      assertPathAgent(auth.agent, params.id);
      const body = parseJsonBody(auth.body) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AgentApiError(400, "invalid_request", "Heartbeat must be an object.");
      const heartbeat = await heartbeatAgent(rt, auth.agent, body);
      if (body.updateControlNonce === undefined) return agentJson(heartbeat); // earlier agents
      if (typeof body.updateControlNonce !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(body.updateControlNonce)) throw new AgentApiError(400, "invalid_request", "Invalid update control nonce.");
      const control = await getUpdateControl(await platformDb(), auth.agent.workspaceId, kind, auth.agent.id);
      if (rt.signer.alg !== "EdDSA") throw new AgentApiError(503, "runner_plane_unconfigured", "Update controls require the pinned EdDSA signer.");
      const now = Math.floor(rt.now() / 1000);
      const updateControl = await rt.signer.sign({ typ: "zenith-update-control+jwt" }, {
        schema: "zenith.update-control/v1", workspaceId: auth.agent.workspaceId, agentId: auth.agent.id, kind,
        nonce: body.updateControlNonce, revision: control.revision, hold: control.hold, manifestSha256: control.manifestSha256,
        iat: now, exp: now + 60,
      });
      return agentJson({ ...heartbeat, updateControl });
    } catch (error) {
      if (error instanceof ControlStoreError) return agentJson({ error: { code: error.code, message: error.message } }, error.httpStatus);
      return agentError(error);
    }
  };
}
