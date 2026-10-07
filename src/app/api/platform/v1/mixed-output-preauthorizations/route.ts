/**
 * GET  /api/platform/v1/mixed-output-preauthorizations?parentOperationId=&activeOnly=   browser
 * POST /api/platform/v1/mixed-output-preauthorizations                                   admin, browser-only
 *
 * A precise preauthorization lets ONE dependency reference of ONE parent operation be materialized and
 * consumed without a fresh review (PROD-MIX-03). It names the parent operation, the reference and its
 * contract digest, the consumer's and producer's immutable subplan digests, the parent's desired-inputs
 * digest and the value type (and for a secret the exact vault reference). 1 to 10 uses, 5 minutes to 7
 * days. It never accepts a value, a wildcard or a list. Needs the admin's own browser session.
 * Body: `{ parentOperationId, environmentId, desiredDigest, referenceId, contractDigest, consumerSubplanDigest,
 * producerSubplanDigest, valueType, secretRef?, valueDigest?, maxUses, lifetimeMs, reason? }`.
 */
import { z } from "zod";
import { BrokerError } from "@/lib/capabilities/errors";
import { createOutputPreauthorization, listOutputPreauthorizations } from "@/lib/execution/mixed-orchestration/preauthorization";
import { assertBrowserSession } from "../_lib/browser";
import { parseWith, platformRoute, readJson } from "../_lib/http";
import { guarded, mixedContext } from "../_lib/mixed-run";
import { callerOf } from "../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const SHA = /^[a-f0-9]{64}$/;
const Body = z
  .object({
    parentOperationId: z.string().regex(ID),
    environmentId: z.string().regex(ID),
    desiredDigest: z.string().regex(SHA),
    referenceId: z.string().regex(ID),
    contractDigest: z.string().regex(SHA),
    consumerSubplanDigest: z.string().regex(SHA),
    producerSubplanDigest: z.string().regex(SHA),
    valueType: z.enum(["string", "number", "boolean", "resource_id", "endpoint", "secret_ref"]),
    secretRef: z.string().max(400).optional(),
    valueDigest: z.string().regex(SHA).optional(),
    maxUses: z.number().int().min(1).max(10),
    lifetimeMs: z.number().int().min(5 * 60_000).max(7 * 24 * 60 * 60_000),
    reason: z.string().max(300).optional(),
  })
  .strict();

export const GET = platformRoute(async (req) => {
  const caller = await callerOf(req);
  const q = req.nextUrl.searchParams;
  const parentOperationId = q.get("parentOperationId") ?? undefined;
  if (parentOperationId !== undefined && !ID.test(parentOperationId)) throw new BrokerError("invalid_request", "parentOperationId is malformed.");
  const { broker, deps } = await mixedContext();
  const preauthorizations = await guarded(() =>
    listOutputPreauthorizations(broker.deps, deps.preauthorizations, { workspaceId: caller.workspaceId, principal: caller.principal, parentOperationId, activeOnly: q.get("activeOnly") === "true" }),
  );
  return { body: { preauthorizations } };
});

export const POST = platformRoute(async (req) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  const { broker, deps } = await mixedContext();
  const preauthorization = await guarded(() =>
    createOutputPreauthorization(broker.deps, deps.preauthorizations, { workspaceId: caller.workspaceId, actor: caller.principal, session: caller.session, ...body }),
  );
  return { status: 201, body: { preauthorization } };
});
