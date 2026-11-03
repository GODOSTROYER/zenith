/** Browser-only export. MCP clients use separately scoped source-context tools. */
import { z } from "zod";
import { authorizedRunHandoff } from "@/lib/coding-agent/handoff-platform";
import { platformRoute, readJson, parseWith } from "../../../../_lib/http";
import { agentAdmin } from "../../../../_lib/coding-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const Input = z.object({ expectedVersion: z.number().int().positive().optional(), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await agentAdmin(req);
  const input = parseWith(Input, await readJson(req, 2_048));
  return { body: await authorizedRunHandoff({ workspaceId: caller.agent.workspaceId, runId: id, ...input }) };
});
