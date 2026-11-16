/**
 * POST /api/platform/v1/releases/:id/approve-migration
 *
 * Browser-only, like operation approval: a signed-in admin, same-origin, identity confirmed live,
 * never an agent or integration. This is the SEPARATE approval a data or contract migration needs
 * on top of the deployment approval. The body names the `bindingDigest` the person reviewed (the
 * environment, service, image digest, command digest and class); if it is not the release's current
 * binding the approval is refused. The person who requested the release cannot approve it. The
 * approval is single use and expires. After approving, deploy again.
 * Body: `{ bindingDigest: <64 hex>, ttlSec? }`.
 */
import { z } from "zod";
import { assertBrowserSession } from "../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";
import { requireRole, routeId, withReleases } from "../../../_lib/releases";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ bindingDigest: z.string().regex(/^[0-9a-f]{64}$/), ttlSec: z.number().int().min(60).max(7 * 86400).optional() }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  await requireRole(caller.principal, caller.workspaceId, "admin", "write");
  const body = parseWith(Body, await readJson(req));
  const approval = await withReleases((svc) => svc.approveMigration({ workspaceId: caller.workspaceId, runId: routeId(id), bindingDigest: body.bindingDigest, approver: caller.principal, ttlSec: body.ttlSec }));
  return { body: { approval: { id: approval.id, runId: approval.runId, class: approval.class, expiresAt: approval.expiresAt } } };
});
