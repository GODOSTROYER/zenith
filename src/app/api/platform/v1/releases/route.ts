/**
 * GET /api/platform/v1/releases?environmentId=&serviceAddress=&limit=
 *
 * Digest-bound release runs, newest first: state, image digest, provenance level, migration class
 * and approval status, rollout percentage and the post-cutover readback. Read-only; a viewer (or an
 * agent with the read scope) may call it.
 */
import { BrokerError } from "@/lib/capabilities/errors";
import { platformRoute } from "../_lib/http";
import { callerOf } from "../_lib/principal";
import { requireRole, withReleases } from "../_lib/releases";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FILTER = /^[A-Za-z0-9_./:-]{1,200}$/;

export const GET = platformRoute(async (req) => {
  const caller = await callerOf(req);
  await requireRole(caller.principal, caller.workspaceId, "viewer", "read");
  const q = req.nextUrl.searchParams;
  const environmentId = q.get("environmentId") ?? undefined;
  const serviceAddress = q.get("serviceAddress") ?? undefined;
  for (const v of [environmentId, serviceAddress]) if (v !== undefined && !FILTER.test(v)) throw new BrokerError("invalid_request", "A filter value is malformed.");
  const limit = Math.max(1, Math.min(200, Number(q.get("limit") ?? "50") || 50));
  const releases = await withReleases((svc) => svc.list(caller.workspaceId, { environmentId, serviceAddress, limit }));
  return { body: { releases } };
});
