/**
 * GET /api/platform/v1/operations
 *
 * The workspace's operations, newest first, paginated: `?limit=` (1–200,
 * default 50), `?cursor=` (opaque, from `nextCursor`), and filters `status`
 * (comma list), `projectId`, `environmentId`, `resourceId`, `capability`.
 * Workspace-scoped: only operations of a workspace the caller is a member of.
 */
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { BrokerError } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import type { OperationStatus } from "@/lib/controlplane/types";
import { intParam } from "@/lib/server/request";
import { platformRoute } from "../_lib/http";
import { callerOf } from "../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUSES: readonly OperationStatus[] = ["proposed", "awaiting_approval", "approved", "rejected", "denied", "queued", "running", "succeeded", "failed", "uncertain", "cancelled", "expired"];
const ID = /^[A-Za-z0-9_-]{1,200}$/;

export const GET = platformRoute(async (req) => {
  const caller = await callerOf(req);
  const params = req.nextUrl.searchParams;

  const idParam = (key: string): string | undefined => {
    const value = params.get(key);
    if (value === null || value === "") return undefined;
    if (!ID.test(value)) throw new BrokerError("invalid_request", `${key} is not a valid id.`);
    return value;
  };
  const statusRaw = params.get("status");
  let status: OperationStatus[] | undefined;
  if (statusRaw) {
    status = statusRaw.split(",").map((s) => s.trim()) as OperationStatus[];
    if (status.length > STATUSES.length || status.some((s) => !STATUSES.includes(s))) throw new BrokerError("invalid_request", "status must be a comma-separated list of operation statuses.");
  }
  const capability = params.get("capability") ?? undefined;
  if (capability !== undefined && !Object.prototype.hasOwnProperty.call(CAPABILITIES, capability)) throw new BrokerError("invalid_request", "capability is not a known capability.");
  const cursor = params.get("cursor") ?? undefined;
  if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw new BrokerError("invalid_request", "The page cursor is not valid.");

  const page = await (await platformBroker()).listOperations({
    workspaceId: caller.workspaceId,
    principal: caller.principal,
    filters: { status, projectId: idParam("projectId"), environmentId: idParam("environmentId"), resourceId: idParam("resourceId"), capability },
    limit: intParam(req, "limit", 50, { min: 1, max: 200 }),
    cursor,
  });
  return { body: { operations: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) } };
});
