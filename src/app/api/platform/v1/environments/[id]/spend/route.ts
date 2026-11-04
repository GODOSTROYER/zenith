/** GET reads the environment's estimate, provider-reported actual spend and forecast as three
 * separate kinds (none is a spending cap). POST asks the provider's billing API for a period and
 * stores the answer; it needs the person's browser and an operator-enabled live gate, and the
 * billing account comes from the environment's own connection, never from the body.
 * Foreign and missing environment ids give the same not-found response. */
import { z } from "zod";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { productionSpendDeps, readSpendView, refreshActualSpend } from "@/lib/cost/spend-service";
import { assertBrowserSession } from "../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({ periodStart: z.string().regex(DAY), periodEnd: z.string().regex(DAY) }).strict();

async function authorize(workspaceId: string, environmentId: string, principal: Parameters<Awaited<ReturnType<typeof platformBroker>>["authorizeRead"]>[1]): Promise<void> {
  const authorization = await (await platformBroker()).authorizeRead({ capability: "cost.estimate", scope: { workspaceId, environmentId } }, principal);
  if (authorization.decision.outcome !== "allow" || !authorization.claims) {
    throw new BrokerError("policy_denied", "Current policy does not authorize reading cost.", "Use a credential with the read scope or ask a workspace administrator to review policy.");
  }
}

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!ID.test(id)) throw notFound();
  await authorize(caller.workspaceId, id, caller.principal);
  return { body: await readSpendView(await productionSpendDeps(), caller.workspaceId, id) };
});

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  if (!ID.test(id)) throw notFound();
  const body = parseWith(Body, await readJson(req));
  await authorize(caller.workspaceId, id, caller.principal);
  const deps = await productionSpendDeps();
  const { stored, cached } = await refreshActualSpend(deps, { workspaceId: caller.workspaceId, environmentId: id, ...body, recordedBy: caller.principal.id });
  return { body: { actualSpend: stored.snapshot, cached, disclosure: (await readSpendView(deps, caller.workspaceId, id)).disclosure } };
});
