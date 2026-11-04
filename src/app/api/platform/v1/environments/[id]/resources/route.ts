/** Persisted state only. Broker authorization, tenant-scoped SQL, redacted and paginated output. */
import { readResources, safeRead } from "@/app/(product)/platform/_lib/read-models";
import { BrokerError } from "@/lib/capabilities/errors";
import { platformRoute } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  const rawLimit = req.nextUrl.searchParams.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if ((rawLimit !== null && !/^\d+$/.test(rawLimit)) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new BrokerError("invalid_request", "limit must be an integer between 1 and 200.");
  return { body: await safeRead(() => readResources(caller, id, limit, req.nextUrl.searchParams.get("cursor") ?? undefined)) };
});
