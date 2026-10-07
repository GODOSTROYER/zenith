/**
 * POST /api/platform/v1/coding-agent/runs/:id/cancel : stop a run for good (admin, browser only).
 * The run row becomes `cancelled` first, so a worker mid-step stops at its next checkpoint write,
 * and the durable workflow is asked to cancel (the running model call is aborted). Nothing is
 * compensated: a run only ever proposes.
 */
import { codingAgentControl } from "@/lib/coding-agent/platform";
import { cancelRun } from "@/lib/coding-agent/service";
import { runView } from "@/lib/coding-agent/view";
import { platformRoute } from "../../../../_lib/http";
import { agentAdmin, mapAgentError } from "../../../../_lib/coding-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await agentAdmin(req);
  try {
    return { body: runView(await cancelRun(await codingAgentControl(), caller.agent, id)) };
  } catch (error) {
    return mapAgentError(error);
  }
});
