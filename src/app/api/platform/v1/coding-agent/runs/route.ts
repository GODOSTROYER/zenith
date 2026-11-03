/**
 * GET  /api/platform/v1/coding-agent/runs   recent runs of the workspace
 * POST /api/platform/v1/coding-agent/runs   start a bounded run (admin, browser only)
 *
 * POST body (strict): `{ task, repository: "owner/name", ref?, root?, target?: { projectId, environmentId },
 * model?, limits?: { inputTokens, outputTokens, toolCalls, wallTimeMs, spendMicroUsd } }`.
 * Limits are clamped to the platform ceilings. This call only PINS the repository to an exact commit,
 * records the run and starts its durable workflow, then returns 201 with the run (status `running`).
 * The execution worker analyses the repository with a model on fixed read-only tools, step by step
 * with a stored checkpoint, and, when a target is named, submits the resulting manifest as an
 * `infrastructure.plan` proposal to the capability broker. Nothing is deployed or adopted by this call.
 * 503 when the workflow engine cannot be reached (the run is recorded and can be resumed).
 */
import { z } from "zod";
import { createRunSourceAccessChecker, codingAgentControl, codingAgentStore } from "@/lib/coding-agent/platform";
import { platformDb } from "@/lib/controlplane/db/open";
import { listRunStatuses } from "@/lib/controlplane/db/repos/coding-agent-runs";
import { createRun, TASK_MAX } from "@/lib/coding-agent/service";
import { runView } from "@/lib/coding-agent/view";
import { parseWith, platformRoute, readJson } from "../../_lib/http";
import { agentAdmin, mapAgentError } from "../../_lib/coding-agent";
import { requireProject, requireEnvironment } from "@/lib/actions/defs/_shared";
import { contentHash } from "@/lib/domain/types";
import { notFound, BrokerError } from "@/lib/capabilities/errors";
import { parseEditableManifest } from "@/lib/actions/defs/_manifest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const Body = z
  .object({
    task: z.string().min(1).max(TASK_MAX),
    repository: z.string().min(3).max(201),
    ref: z.string().min(1).max(250).prefault("HEAD"),
    root: z.string().max(200).optional(),
    mode: z.enum(["static", "model"]).prefault("static"),
    accessKind: z.enum(["installed", "public"]).optional(),
    bindingId: z.string().max(100).optional(),
    bindingVersion: z.number().int().positive().optional(),
    repositoryId: z.number().int().positive().optional(),
    contextDir: z.string().max(200).optional(),
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    dockerfile: z.string().max(300).optional(),
    target: z.object({ projectId: z.string().regex(ID), environmentId: z.string().regex(ID) }).strict().optional(),
    model: z.string().max(60).optional(),
    limits: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), toolCalls: z.number().int(), wallTimeMs: z.number().int(), spendMicroUsd: z.number().int() }).partial().strict().optional(),
  })
  .strict();

export const GET = platformRoute(async (req) => {
  const caller = await agentAdmin(req);
  const query = parseWith(z.object({ view: z.literal("status").optional(), ids: z.string().max(5050).optional() }).strict(), Object.fromEntries(req.nextUrl.searchParams));
  if (query.view === "status") {
    const ids = parseWith(z.array(z.string().regex(ID)).min(1).max(50), query.ids?.split(","));
    const runs = await listRunStatuses(await platformDb(), caller.agent.workspaceId, ids);
    return { body: { runs } };
  }
  if (query.ids !== undefined) throw new BrokerError("invalid_request", "Run IDs require the status view.");
  const rows = await (await codingAgentStore()).list(caller.agent.workspaceId, 25);
  const assertSourceAccess = createRunSourceAccessChecker();
  const views: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i += 4) {
    const batch = await Promise.all(rows.slice(i, i + 4).map(async row => {
      try { await assertSourceAccess(row); return runView(row); } catch { return null; }
    }));
    views.push(...batch.filter((value): value is Record<string, unknown> => value !== null));
  }
  return { body: { runs: views } };
});

export const POST = platformRoute(async (req) => {
  const caller = await agentAdmin(req);
  const body = parseWith(Body, await readJson(req));
  let targetBase;
  let environmentClass: "sandbox" | "staging" | "production" = "staging";
  if (body.target) {
    const project = requireProject(caller.ctx, body.target.projectId);
    const environment = requireEnvironment(caller.ctx, body.target.environmentId);
    if (project.id !== body.target.projectId || environment.projectId !== project.id) throw notFound();
    const parsed = parseEditableManifest(project.workingManifest);
    if (!parsed.ok) throw new BrokerError("invalid_state", "The current project manifest must be valid before creating a proposal.");
    targetBase = { manifest: structuredClone(project.workingManifest), manifestHash: contentHash(project.workingManifest) };
    environmentClass = environment.class;
  }
  try {
    const run = await createRun(await codingAgentControl(), caller.agent, {
      task: body.task,
      source: { repository: body.repository, ref: body.ref, root: body.root, accessKind: body.accessKind,
        bindingId: body.bindingId, bindingVersion: body.bindingVersion, repositoryId: body.repositoryId,
        contextDir: body.contextDir, contextDigest: body.contextDigest, dockerfile: body.dockerfile },
      mode: body.mode,
      environmentClass,
      ...(req.headers.get("idempotency-key") ? { idempotencyKey: req.headers.get("idempotency-key")! } : {}),
      ...(targetBase ? { targetBase } : {}),
      ...(body.target ? { target: body.target } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.limits ? { limits: body.limits } : {}),
    });
    return { status: 201, body: runView(run) };
  } catch (error) {
    return mapAgentError(error);
  }
});
