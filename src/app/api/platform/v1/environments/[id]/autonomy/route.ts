/**
 * GET /api/platform/v1/environments/:id/autonomy   any member
 * PUT /api/platform/v1/environments/:id/autonomy   admin, browser-only
 *
 * The environment's autonomy level 0–5 (ADR-0007), what it means, whether it is
 * the class default (production 2, staging 3, development 3, sandbox 4 when never
 * set) and its version. PUT body: `{ level: 0..5, expectedVersion?: int }`.
 * Changing autonomy is a person's decision: PUT refuses any `Authorization`
 * header, so an agent can never raise its own autonomy.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { assertBrowserSession } from "../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const Body = z.object({ level: z.number(), expectedVersion: z.number().int().min(0).optional() }).strict();

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!ID.test(id)) throw notFound();
  return { body: await (await platformBroker()).getAutonomy({ workspaceId: caller.workspaceId, environmentId: id, principal: caller.principal }) };
});

export const PUT = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  if (!ID.test(id)) throw notFound();
  return {
    body: await (await platformBroker()).setAutonomy({
      workspaceId: caller.workspaceId,
      environmentId: id,
      level: body.level,
      actor: caller.principal,
      session: caller.session,
      expectedVersion: body.expectedVersion,
    }),
  };
});
