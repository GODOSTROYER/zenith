/** Latest persisted reconciliation report; absence is unknown, never an invented clean pass. */
import { readDrift, safeRead } from "@/app/(product)/platform/_lib/read-models";
import { platformRoute } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  return { body: await safeRead(() => readDrift(caller, id)) };
});
