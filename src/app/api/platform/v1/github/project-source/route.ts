import { z } from "zod";
import { platformDb } from "@/lib/controlplane/db/open";
import { requireProject } from "@/lib/actions/defs/_shared";
import { changeProjectRepository, getProjectRepository } from "@/lib/sources/github/project-source";
import { notFound } from "@/lib/capabilities/errors";
import { platformRoute, parseWith, readJson } from "../../_lib/http";
import { agentAdmin } from "../../_lib/coding-agent";
import { safeFailure } from "../_lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Base = { projectId: Id, expectedVersion: z.number().int().min(0) };
const Body = z.union([
  z.object({ ...Base, detach: z.literal(true) }).strict(),
  z.object({ ...Base, bindingId: Id, ref: z.string().min(1).max(250).regex(/^[A-Za-z0-9._+@~/-]+$/),
    root: z.string().max(200).optional(), contextDir: z.string().max(200).optional(), detach: z.literal(false).optional() }).strict(),
]);

export const GET = platformRoute(async req => {
  const caller = await agentAdmin(req);
  const projectId = parseWith(Id, req.nextUrl.searchParams.get("projectId"));
  if (requireProject(caller.ctx, projectId).id !== projectId) throw notFound();
  return { body: await getProjectRepository(await platformDb(), caller.agent.workspaceId, projectId) };
});
export const POST = platformRoute(async req => {
  const caller = await agentAdmin(req);
  const body = parseWith(Body, await readJson(req));
  if (requireProject(caller.ctx, body.projectId).id !== body.projectId) throw notFound();
  try {
    const result = await changeProjectRepository(await platformDb(), caller.agent.workspaceId, caller.agent.userId, body, async () => {
      const current = await agentAdmin(req);
      if (current.agent.workspaceId !== caller.agent.workspaceId || current.agent.userId !== caller.agent.userId || requireProject(current.ctx, body.projectId).id !== body.projectId) throw notFound();
    });
    return { body: result };
  } catch (error) { return safeFailure(error); }
});
