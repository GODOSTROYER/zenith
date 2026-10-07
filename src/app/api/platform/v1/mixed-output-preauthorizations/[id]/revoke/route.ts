/**
 * POST /api/platform/v1/mixed-output-preauthorizations/:id/revoke
 *
 * Browser-only. The administrator who created the preauthorization, or any admin, withdraws it. It stops
 * covering outputs at once. Body: `{ reason?: string }`.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { revokeOutputPreauthorization } from "@/lib/execution/mixed-orchestration/preauthorization";
import { assertBrowserSession } from "../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";
import { guarded, mixedContext } from "../../../_lib/mixed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const Body = z.object({ reason: z.string().max(300).optional() }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  if (!ID.test(id)) throw notFound();
  const { broker, deps } = await mixedContext();
  const preauthorization = await guarded(() =>
    revokeOutputPreauthorization(broker.deps, deps.preauthorizations, { workspaceId: caller.workspaceId, id, actor: caller.principal, session: caller.session, reason: body.reason }),
  );
  return { body: { preauthorization } };
});
