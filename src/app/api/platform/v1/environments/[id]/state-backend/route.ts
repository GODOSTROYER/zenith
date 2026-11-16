/** Static backend capability matrix, the last stored live probe and restore history. Reads nothing from the backend itself. */
import { z } from "zod";
import { authorizeEnvironment, safeRead } from "@/app/(product)/platform/_lib/read-models";
import { notFound } from "@/lib/capabilities/errors";
import { callerOf } from "../../../_lib/principal";
import { parseWith, platformRoute } from "../../../_lib/http";
import { stateRecoveryService } from "../../../_lib/state-recovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const Query = z.object({ connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict();

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  const query = parseWith(Query, { connectionId: req.nextUrl.searchParams.get("connectionId") ?? undefined });
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw notFound();
  await authorizeEnvironment(caller, id, "infrastructure.observe");
  return { body: await safeRead(async () => (await stateRecoveryService()).describe(caller, id, query.connectionId)) };
});
