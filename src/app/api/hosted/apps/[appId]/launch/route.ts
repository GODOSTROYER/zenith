/**
 * `POST|GET /api/hosted/apps/:appId/launch` — cross the origin boundary.
 *
 * The control origin will not hand an app host a platform cookie, so it mints a
 * 60-second single-use code bound to (app, subject, browser state) and sends the
 * browser to the app's own callback with it. The identity behind that code is
 * checked **live** against the provider first (R3-10): a session that was
 * signed out still carries a valid-looking JWT, and only the provider knows it
 * is over.
 *
 * `POST` answers `{ redirect }` for a page that will `location.assign` it;
 * `GET ?state=` answers a 303 to the same URL, so a plain link works too.
 *
 * Workstream W5 (hosted R3).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createExchange } from "@/lib/hosted/access";
import { hostedRoute, readJsonBody, verifiedIdentity } from "@/lib/hosted/access/http";

export const dynamic = "force-dynamic";

const Launch = z.object({ state: z.string() }).strict();

export const POST = hostedRoute<{ appId: string }>(async (req, { appId }) => {
  const identity = await verifiedIdentity(req);
  const { state } = await readJsonBody(req, Launch);
  return createExchange(appId, identity.subject, state);
});

export const GET = hostedRoute<{ appId: string }>(async (req, { appId }) => {
  const identity = await verifiedIdentity(req);
  const { redirect } = createExchange(
    appId,
    identity.subject,
    req.nextUrl.searchParams.get("state") ?? ""
  );
  // 303: whatever method got here, the browser follows with GET. `no-store`
  // because the location carries a single-use code.
  return new NextResponse(null, {
    status: 303,
    headers: { location: redirect, "cache-control": "no-store" },
  });
});
