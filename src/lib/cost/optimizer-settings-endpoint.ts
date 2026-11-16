/** Browser-only handlers registered at environments/[id]/optimizer/route.ts. */
import { platformBroker } from "@/lib/capabilities/platform";
import { notFound } from "@/lib/capabilities/errors";
import { platformDb } from "@/lib/controlplane/db";
import { assertBrowserSession } from "@/app/api/platform/v1/_lib/browser";
import { platformRoute, readJson } from "@/app/api/platform/v1/_lib/http";
import { readOptimizerSettings, setOptimizerSettings } from "./optimizer-settings-service";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req, { mutation: false });
  if (!ID.test(id)) throw notFound();
  return { body: await readOptimizerSettings(await platformDb(), await platformBroker(), { workspaceId: caller.workspaceId, environmentId: id, actor: caller.principal, session: caller.session }) };
});
export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  if (!ID.test(id)) throw notFound();
  const body = await readJson(req);
  return { body: await setOptimizerSettings(await platformDb(), await platformBroker(), { workspaceId: caller.workspaceId, environmentId: id, actor: caller.principal, session: caller.session }, body) };
});
