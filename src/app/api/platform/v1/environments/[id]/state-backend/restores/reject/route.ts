/** A person in the signed-in browser rejects a proposed restore. Agent credentials and the Navigator are refused. */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { assertBrowserSession } from "../../../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../../../_lib/http";
import { stateRecoveryService } from "../../../../../_lib/state-recovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const Body = z.object({ restoreId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw notFound();
  const body = parseWith(Body, await readJson(req));
  return { body: await (await stateRecoveryService()).reject(caller, { environmentId: id, restoreId: body.restoreId }) };
});
