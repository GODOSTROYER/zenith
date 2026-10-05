/** GET /api/platform/v1/connections/:id : one connection with its open rotation, identifiers only. */
import { notFound } from "@/lib/capabilities/errors";
import { describeConnection, LifecycleRefusal } from "@/lib/connections/service";
import { platformRoute } from "../../_lib/http";
import { personOrCredentialCaller } from "../../_lib/connections";
import { routeId } from "../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await personOrCredentialCaller(req);
  try {
    return { body: { connection: await describeConnection(caller.ctx, routeId(id)) } };
  } catch (error) {
    if (error instanceof LifecycleRefusal && error.code === "not_found") throw notFound();
    throw error;
  }
});
