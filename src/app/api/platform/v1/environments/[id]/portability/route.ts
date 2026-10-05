/** Verified exports, restores (with their independent readback verdicts) and adoption claims with baseline drift. Read-only; stored data only. */
import { readPortability, safeRead } from "@/app/(product)/platform/_lib/read-models";
import { platformRoute } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  return { body: await safeRead(() => readPortability(caller, id)) };
});
