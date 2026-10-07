/** Live, read-only capability probe of the tenant's own state bucket. The verdict is stored as immutable evidence. */
import { z } from "zod";
import { authorizeEnvironment } from "@/app/(product)/platform/_lib/read-models";
import { notFound } from "@/lib/capabilities/errors";
import { callerOf } from "../../../../_lib/principal";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { stateRecoveryService } from "../../../../_lib/state-recovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const Body = z.object({ connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), credentialsRef: z.string().min(7).max(512) }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw notFound();
  const body = parseWith(Body, await readJson(req));
  await authorizeEnvironment(caller, id, "infrastructure.observe");
  return { body: await (await stateRecoveryService()).probe(caller, { environmentId: id, ...body }) };
});
