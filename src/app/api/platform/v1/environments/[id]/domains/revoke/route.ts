/**
 * POST /api/platform/v1/environments/:id/domains/revoke   workspace admin, browser-only
 *
 * Body: `{ domainId }`. Ends a claim for good: the host stops being served at the next apply (its listener, certificate and
 * key are removed). Revocation is terminal; claiming the hostname again starts a new proof.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { platformDb, repos } from "@/lib/controlplane/db";
import { assertManagedProvider, requireManagedEnvironment } from "@/lib/managed-serving/access";
import { revokeCustomDomain } from "@/lib/managed-serving/domain-service";
import { assertBrowserSession } from "../../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { managedRefusals, readDomainDeps } from "../../../../_lib/managed";

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
  return { body: { domain: await managedRefusals(async () => revokeCustomDomain(await readDomainDeps(), { workspaceId: caller.workspaceId, id: body.domainId, by: caller.principal.id })) } };
});
