/**
 * The app-host route. Every request to `<slug>.<ZENITH_APP_DOMAIN>` arrives
 * here, rewritten by `src/middleware.ts` with its Host header preserved.
 *
 * This file holds no policy at all — that is the point. It boots the process,
 * hands the request to `handleGateway` and returns what comes back, so there
 * is exactly one place where admission is decided and one place where the
 * response guard is applied.
 *
 * `OPTIONS` is answered like any other unsupported method: a 405 with `allow`.
 * The gateway never emits an `access-control-*` header, so a cross-origin
 * caller is told the truth (nothing here is available to it) rather than being
 * handed a preflight that promises otherwise.
 *
 * Workstream W6 (hosted R3).
 */
import type { NextRequest } from "next/server";
import { handleGateway } from "@/lib/hosted/gateway";
import { ensureBoot } from "@/lib/server/boot";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ host: string; path?: string[] }>;
}

async function serve(req: NextRequest, ctx: RouteContext): Promise<Response> {
  await ensureBoot();
  return handleGateway(req, await ctx.params);
}

export const GET = serve;
export const HEAD = serve;
export const POST = serve;
export const PATCH = serve;
export const PUT = serve;
export const DELETE = serve;
export const OPTIONS = serve;
