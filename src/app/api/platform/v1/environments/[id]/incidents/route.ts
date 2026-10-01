/** Stored investigations only, capped at 20; this read does not start an investigation. */
import { readIncidents, safeRead } from "@/app/(product)/platform/_lib/read-models";
import { platformRoute } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  return { body: await safeRead(() => readIncidents(caller, id)) };
});
