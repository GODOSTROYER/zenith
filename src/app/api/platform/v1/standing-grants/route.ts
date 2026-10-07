/**
 * GET  /api/platform/v1/standing-grants?environmentId=&activeOnly=   any member, browser
 * POST /api/platform/v1/standing-grants                               admin, browser-only
 *
 * A standing grant is a person's explicit, bounded pre-approval for repeat agent operations
 * (PROD-DUR-04). POST needs the admin's own browser session (any `Authorization` header is refused),
 * and every bound is mandatory: one environment (optionally a project and resource), an explicit
 * capability list that never includes destructive or escape-hatch capabilities, a risk ceiling of
 * low, medium or high, the agents (integration:<id> or navigator:<id>) that may use it, a use count
 * from 1 to 1000 and an expiry from 5 minutes to 30 days.
 * Body: `{ environmentId, projectId?, resourceId?, capabilities[], maxRisk, allowedPrincipals[], maxUses, expiresInMinutes, reason? }`.
 */
import { z } from "zod";
import { BrokerError } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { assertBrowserSession } from "../_lib/browser";
import { parseWith, platformRoute, readJson } from "../_lib/http";
import { callerOf } from "../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const Body = z
  .object({
    environmentId: z.string().regex(ID),
    projectId: z.string().regex(ID).optional(),
    resourceId: z.string().regex(ID).optional(),
    capabilities: z.array(z.string().min(1).max(100)).min(1).max(20),
    maxRisk: z.enum(["low", "medium", "high", "critical"]),
    allowedPrincipals: z.array(z.string().min(3).max(300)).min(1).max(20),
    maxUses: z.number().int().min(1).max(1000),
    expiresInMinutes: z.number().int().min(5).max(30 * 24 * 60),
    reason: z.string().max(300).optional(),
  })
  .strict();

export const GET = platformRoute(async (req) => {
  const caller = await callerOf(req);
  const q = req.nextUrl.searchParams;
  const environmentId = q.get("environmentId") ?? undefined;
  if (environmentId !== undefined && !ID.test(environmentId)) throw new BrokerError("invalid_request", "environmentId is malformed.");
  const grants = await (await platformBroker()).listStandingGrants({ workspaceId: caller.workspaceId, principal: caller.principal, environmentId, activeOnly: q.get("activeOnly") === "true" });
  return { body: { grants } };
});

export const POST = platformRoute(async (req) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  const grant = await (await platformBroker()).createStandingGrant({
    workspaceId: caller.workspaceId,
    actor: caller.principal,
    session: caller.session,
    scope: { environmentId: body.environmentId, ...(body.projectId ? { projectId: body.projectId } : {}), ...(body.resourceId ? { resourceId: body.resourceId } : {}) },
    capabilities: body.capabilities,
    maxRisk: body.maxRisk,
    allowedPrincipals: body.allowedPrincipals,
    maxUses: body.maxUses,
    lifetimeMs: body.expiresInMinutes * 60_000,
    reason: body.reason,
  });
  return { status: 201, body: { grant } };
});
