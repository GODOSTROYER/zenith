/** POST is a body-bearing read. Broker authorization precedes planning;
 * foreign and missing environment ids produce the same not-found response.
 * No compact grant, connection configuration or manifest is returned. */
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { db } from "@/lib/db/store";
import { RecommendOptions, recommendPlacement } from "@/lib/placement/recommend";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw notFound();
  const data = db();
  const env = data.environments.find((e) => e.id === id && data.projects.some((p) => p.id === e.projectId && p.workspaceId === caller.workspaceId));
  if (!env) throw notFound();
  const options = parseWith(RecommendOptions, await readJson(req));
  const authorization = await (await platformBroker()).authorizeRead({ capability: "placement.solve", scope: {
    workspaceId: caller.workspaceId, projectId: env.projectId, environmentId: env.id,
  } }, caller.principal);
  if (authorization.decision.outcome !== "allow" || !authorization.claims) throw new BrokerError("policy_denied", "Current policy does not authorize placement planning.", "Use a credential with the plan scope or ask a workspace administrator to review policy.");
  return { body: await recommendPlacement({ workspaceId: caller.workspaceId, projectId: env.projectId, environmentId: env.id, ...options }) };
});
