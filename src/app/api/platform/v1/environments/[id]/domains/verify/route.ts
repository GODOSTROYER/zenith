/**
 * POST /api/platform/v1/environments/:id/domains/verify   workspace admin, browser-only
 *
 * Body: `{ domainId }`. Looks up the claim's DNS TXT challenge now and records the outcome: a match makes the claim serving
 * (or renews it, or re-proves a lapsed one); a miss or an inconclusive lookup is reported and never silently treated as
 * success. The same code runs as the durable renewal job.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { platformDb, repos } from "@/lib/controlplane/db";
import { assertManagedProvider, requireManagedEnvironment } from "@/lib/managed-serving/access";
import { verifyCustomDomain } from "@/lib/managed-serving/domain-service";
import { assertBrowserSession } from "../../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { domainDeps, managedRefusals } from "../../../../_lib/managed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ domainId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  const access = await requireManagedEnvironment((await platformBroker()).deps, caller.principal, { workspaceId: caller.workspaceId, environmentId: id }, "admin");
  assertManagedProvider(access);
  const row = await repos.managedServing.getDomain(await platformDb(), caller.workspaceId, body.domainId);
  if (!row || row.environmentId !== id) throw notFound();
  return { body: await managedRefusals(async () => verifyCustomDomain(await domainDeps(), { workspaceId: caller.workspaceId, id: body.domainId })) };
});
