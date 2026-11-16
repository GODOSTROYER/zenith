/** Propose a state restore. Writes nothing to the backend; only a person in a browser can approve and run it. */
import { z } from "zod";
import { authorizeEnvironment } from "@/app/(product)/platform/_lib/read-models";
import { notFound } from "@/lib/capabilities/errors";
import { callerOf } from "../../../../_lib/principal";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { stateRecoveryService } from "../../../../_lib/state-recovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const Body = z.object({
  connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  sourceVersionId: z.string().min(1).max(1024).regex(/^[A-Za-z0-9._~+/=-]+$/),
}).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw notFound();
  const body = parseWith(Body, await readJson(req));
  await authorizeEnvironment(caller, id, "infrastructure.observe");
  return { status: 201, body: await (await stateRecoveryService()).propose(caller, { environmentId: id, ...body }) };
});
