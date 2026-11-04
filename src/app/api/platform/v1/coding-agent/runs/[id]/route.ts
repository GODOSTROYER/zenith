/** GET /api/platform/v1/coding-agent/runs/:id : one run's budgets, usage, outcome and proposal (admin, browser only). */
import { notFound } from "@/lib/capabilities/errors";
import { codingAgentStore } from "@/lib/coding-agent/platform";
import { runView } from "@/lib/coding-agent/view";
import { platformRoute } from "../../../_lib/http";
import { agentAdmin } from "../../../_lib/coding-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await agentAdmin(req);
  const row = await (await codingAgentStore()).get(caller.agent.workspaceId, id);
  if (!row) throw notFound();
  return { body: runView(row) };
});
