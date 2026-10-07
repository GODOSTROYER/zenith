/**
 * POST /api/platform/v1/coding-agent/runs/:id/resume : continue a run that stopped on a budget, an
 * error or a crashed worker (admin, browser only). Body `{ limits? }` may RAISE budgets within the
 * platform ceilings; it can never lower them. The run continues from its stored checkpoint at the
 * same commit.
 */
import { z } from "zod";
import { codingAgentDeps } from "@/lib/coding-agent/platform";
import { resumeRun } from "@/lib/coding-agent/service";
import { runView } from "@/lib/coding-agent/view";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { agentAdmin, mapAgentError } from "../../../../_lib/coding-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z
  .object({ limits: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), toolCalls: z.number().int(), wallTimeMs: z.number().int(), spendMicroUsd: z.number().int() }).partial().strict().optional() })
  .strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await agentAdmin(req);
  const body = parseWith(Body, await readJson(req));
  try {
    const { run } = await resumeRun(await codingAgentDeps(), caller.agent, id, { ...(body.limits ? { limits: body.limits } : {}), signal: AbortSignal.any([req.signal, AbortSignal.timeout(290_000)]) });
    return { body: runView(run) };
  } catch (error) {
    return mapAgentError(error);
  }
});
