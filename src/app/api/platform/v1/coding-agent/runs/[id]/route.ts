/** GET /api/platform/v1/coding-agent/runs/:id : one run's budgets, usage, outcome and proposal (admin, browser only). */
import { notFound } from "@/lib/capabilities/errors";
import { assertRunSourceAccess, codingAgentStore } from "@/lib/coding-agent/platform";
import { BrokerError } from "@/lib/capabilities/errors";
import { platformDb } from "@/lib/controlplane/db/open";
import { purgeRunPayload } from "@/lib/coding-agent/lifecycle";
import { z } from "zod";
import { runView } from "@/lib/coding-agent/view";
import { platformRoute, parseWith, readJson } from "../../../_lib/http";
import { agentAdmin } from "../../../_lib/coding-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await agentAdmin(req);
  const row = await (await codingAgentStore()).get(caller.agent.workspaceId, id);
  if (!row) throw notFound();
  try { await assertRunSourceAccess(row); } catch {
    throw new BrokerError("invalid_state", "Source access is unavailable or this analysis has expired. Reconnect the repository and start a new analysis.");
  }
  return { body: runView(row) };
});

/** Delete disposable analysis content without touching GitHub or deployed infrastructure. */
export const DELETE = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await agentAdmin(req);
  const body = parseWith(z.object({ expectedVersion: z.number().int().positive() }).strict(), await readJson(req));
  const store = await codingAgentStore();
  const row = await store.get(caller.agent.workspaceId, id);
  if (!row) throw notFound();
  if (!await purgeRunPayload(await platformDb(), caller.agent.workspaceId, id, body.expectedVersion)) throw new BrokerError("conflict", "This run changed. Refresh before deleting its content.");
  return { body: { deleted: true } };
});
