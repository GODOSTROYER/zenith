/**
 * POST /api/platform/v1/operations/:id/mixed-run/reconcile
 *
 * Record the outcome of reconciling an indeterminate child (PROD-MIX-04): one that failed with possible effects, timed out, hit an
 * outage or was cancelled while running. The operator reads the provider (read-only), then records what was found:
 *   { childId, outcome: "no_effects" | "effects_present", evidenceDigest }   evidenceDigest is the sha256 of the evidence kept
 *                                                                          outside the platform; the platform stores the digest only.
 * Browser-only, editor or admin. Refused (409) unless the child currently needs reconciliation. This does not retry or start
 * anything and never claims the child clean without the operator's recorded evidence.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { reconcileChild } from "@/lib/execution/mixed-orchestration/service";
import { assertBrowserSession } from "../../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { authorizeRunControl, guarded, mixedContext } from "../../../../_lib/mixed-run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const Body = z.object({
  childId: z.string().min(1).max(200),
  outcome: z.enum(["no_effects", "effects_present"]),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  if (!ID.test(id)) throw notFound();
  const { broker, deps } = await mixedContext();
  await authorizeRunControl(broker, caller.workspaceId, id, caller.principal, { staffOnly: true });
  const summary = await guarded(() => reconcileChild(deps, { workspaceId: caller.workspaceId, parentOperationId: id, ...body, reconciledBy: caller.principal.id }));
  return { body: { summary } };
});
