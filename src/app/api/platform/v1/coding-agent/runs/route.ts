/**
 * GET  /api/platform/v1/coding-agent/runs   recent runs of the workspace
 * POST /api/platform/v1/coding-agent/runs   start a bounded run (admin, browser only)
 *
 * POST body (strict): `{ task, repository: "owner/name", ref?, root?, target?: { projectId, environmentId },
 * model?, limits?: { inputTokens, outputTokens, toolCalls, wallTimeMs, spendMicroUsd } }`.
 * Limits are clamped to the platform ceilings. The run reads the repository at one exact commit,
 * analyses it with a model on fixed read-only tools, and, when a target is named, submits the
 * resulting manifest as an `infrastructure.plan` proposal to the capability broker. Nothing is
 * deployed or adopted by this call.
 */
import { z } from "zod";
import { codingAgentDeps, codingAgentStore } from "@/lib/coding-agent/platform";
import { startRun, TASK_MAX } from "@/lib/coding-agent/service";
import { runView } from "@/lib/coding-agent/view";
import { parseWith, platformRoute, readJson } from "../../_lib/http";
import { agentAdmin, mapAgentError } from "../../_lib/coding-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const Body = z
  .object({
    task: z.string().min(1).max(TASK_MAX),
    repository: z.string().min(3).max(201),
    ref: z.string().min(1).max(250).default("HEAD"),
    root: z.string().max(200).optional(),
    target: z.object({ projectId: z.string().regex(ID), environmentId: z.string().regex(ID) }).strict().optional(),
    model: z.string().max(60).optional(),
    limits: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), toolCalls: z.number().int(), wallTimeMs: z.number().int(), spendMicroUsd: z.number().int() }).partial().strict().optional(),
  })
  .strict();

export const GET = platformRoute(async (req) => {
  const caller = await agentAdmin(req);
  const rows = await (await codingAgentStore()).list(caller.agent.workspaceId, 25);
  return { body: { runs: rows.map(runView) } };
});

export const POST = platformRoute(async (req) => {
  const caller = await agentAdmin(req);
  const body = parseWith(Body, await readJson(req));
  try {
    const { run } = await startRun(await codingAgentDeps(), caller.agent, {
      task: body.task,
      source: { repository: body.repository, ref: body.ref, ...(body.root ? { root: body.root } : {}) },
      ...(body.target ? { target: body.target } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.limits ? { limits: body.limits } : {}),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(290_000)]),
    });
    return { status: 201, body: runView(run) };
  } catch (error) {
    return mapAgentError(error);
  }
});
