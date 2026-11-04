/**
 * POST /api/platform/v1/recovery/items/:id/decide
 *
 * Browser-only, like operation approval: a signed-in admin, same-origin, identity confirmed live, never an agent
 * or integration. The body names the `bindingDigest` the person reviewed (it covers the exact item and the exact
 * current state of what it points at), so any later change makes the decision unusable.
 * Body: `{ decision: "resume" | "abandon" | "keep_uncertain", bindingDigest: <64 hex>, reason }`.
 *  - resume: reopens an operation with a fresh approval round (someone must approve again) or re-queues an intent.
 *  - abandon: cancels the operation or supersedes the intent.
 *  - keep_uncertain: records that an uncertain operation or effect was seen; it stays uncertain.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { platformRecovery } from "@/lib/platform/recovery";
import { assertBrowserSession } from "../../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^ri_[a-f0-9]{40}$/;
const Body = z.object({
  decision: z.enum(["resume", "abandon", "keep_uncertain"]),
  bindingDigest: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  if (!ID.test(id)) throw notFound();
  const body = parseWith(Body, await readJson(req));
  const item = await (await platformRecovery()).decide({ principal: caller.principal, workspaceId: caller.workspaceId, itemId: id, ...body });
  return { body: { item } };
});
