/**
 * GET  /api/platform/v1/environments/:id/domains   any member (person or integration credential)
 * POST /api/platform/v1/environments/:id/domains   workspace admin, browser-only
 *
 * Custom domains for a Zenith-managed environment (PROD-MAN-03). POST body: `{ hostname }`. It claims the hostname and answers
 * 201 with the DNS TXT challenge to publish (`_zenith-challenge.<hostname>`, value shown ONCE); the claim becomes serving
 * only after `POST .../domains/verify` finds that record, and stays serving only while Zenith can keep re-finding it (renewal
 * runs on the durable `managed-serving` job). GET lists this environment's claims with their derived state and the
 * provisional proof windows. A hostname another workspace has proven is "not available" and nothing more.
 */
import { z } from "zod";
import { platformBroker } from "@/lib/capabilities/platform";
import { assertManagedProvider, requireManagedEnvironment } from "@/lib/managed-serving/access";
import { claimCustomDomain, listCustomDomains } from "@/lib/managed-serving/domain-service";
import { GRACE_MS, MAX_DOMAINS_PER_ENVIRONMENT, PENDING_TTL_MS, PROOF_TTL_MS, RENEWAL_WINDOW_MS } from "@/lib/managed-serving/domains";
import { assertBrowserSession } from "../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";
import { domainDeps, managedRefusals, readDomainDeps } from "../../../_lib/managed";
import { callerOf } from "../../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ hostname: z.string().min(1).max(253) }).strict();
const DAY = 86_400_000;

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  await requireManagedEnvironment((await platformBroker()).deps, caller.principal, { workspaceId: caller.workspaceId, environmentId: id }, "member");
  const domains = await managedRefusals(async () => listCustomDomains(await readDomainDeps(), { workspaceId: caller.workspaceId, environmentId: id }));
  return {
    body: {
      environmentId: id,
      domains,
      policy: { maxPerEnvironment: MAX_DOMAINS_PER_ENVIRONMENT, proofValidDays: PROOF_TTL_MS / DAY, renewalWindowDays: RENEWAL_WINDOW_MS / DAY, graceDays: GRACE_MS / DAY, pendingChallengeDays: PENDING_TTL_MS / DAY, provisional: true },
    },
  };
});

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  const access = await requireManagedEnvironment((await platformBroker()).deps, caller.principal, { workspaceId: caller.workspaceId, environmentId: id }, "admin");
  assertManagedProvider(access);
  const claimed = await managedRefusals(async () => claimCustomDomain(await domainDeps(), { workspaceId: caller.workspaceId, environmentId: id, hostname: body.hostname, requestedBy: caller.principal.id }));
  return { status: claimed.outcome === "created" ? 201 : 200, body: claimed };
});
