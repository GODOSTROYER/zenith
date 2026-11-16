/** Read-only review trigger/polling. Bearers need plan scope; this never approves or applies. */
import { z } from "zod";
import { platformBroker } from "@/lib/capabilities/platform";
import { getDestroyReview, requestDestroyReview, DestroyReviewOptions } from "@/lib/capabilities/destroy-review";
import { notFound } from "@/lib/capabilities/errors";
import { callerOf } from "../../../_lib/principal";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!Id.safeParse(id).success) throw notFound();
  const body = parseWith(DestroyReviewOptions, await readJson(req));
  return { status: 202, body: await requestDestroyReview(await platformBroker(), { workspaceId: caller.workspaceId, environmentId: id }, caller.principal, body) };
});

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!Id.safeParse(id).success) throw notFound();
  const reviewId = req.nextUrl.searchParams.get("reviewId") ?? undefined;
  if (reviewId !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(reviewId)) throw notFound();
  return { body: await getDestroyReview(await platformBroker(), { workspaceId: caller.workspaceId, environmentId: id }, caller.principal, reviewId) };
});
