/**
 * Request context + JSON conventions for every /api route.
 *
 * Workstream D. One demo session = one local user ("You"); the Navigator
 * identifies itself with the `x-orrery-actor: navigator` header and is then
 * bound by the workspace autonomy level.
 */
import { NextResponse, type NextRequest } from "next/server";
import type { ActionContext } from "@/lib/actions/core";
import { db } from "@/lib/db/store";
import { AutonomyLevel, type Actor, type Workspace } from "@/lib/domain/types";
import { ensureBoot } from "@/lib/server/boot";

/* --------------------------------- actors --------------------------------- */

export const demoActor = (): Actor => ({ type: "user", id: "local", name: "You" });

export const navigatorActor = (): Actor => ({
  type: "navigator",
  id: "navigator",
  name: "Navigator",
});

/** True only for the Navigator's own calls; everything else is the local user. */
export const actorFromRequest = (req: NextRequest): Actor =>
  req.headers.get("x-orrery-actor") === "navigator" ? navigatorActor() : demoActor();

/* -------------------------------- workspace ------------------------------- */

/** The demo runs a single workspace. Routes never create one implicitly. */
export function requireWorkspace(): Workspace {
  const w = db().workspaces[0];
  if (!w)
    throw new ApiError("No workspace exists yet.", 404, {
      fix: "Run `npm run seed`, or complete onboarding at /onboarding.",
    });
  return w;
}

/** Effective autonomy for the Navigator. Defaults to the safe level: approve. */
export function readAutonomy(): AutonomyLevel {
  const parsed = AutonomyLevel.safeParse(db().settings.autonomy);
  return parsed.success ? parsed.data : "approve";
}

export interface Scope {
  projectId?: string;
  environmentId?: string;
}

export function buildCtx(scope: Scope = {}, actor: Actor = demoActor()): ActionContext {
  return {
    workspaceId: requireWorkspace().id,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    actor,
    autonomy: actor.type === "navigator" ? readAutonomy() : undefined,
  };
}

/* ------------------------------ json + errors ----------------------------- */

/** Every error body is `{ error: { message, fix? } }` — errors name their fix. */
export class ApiError extends Error {
  readonly status: number;
  readonly fix?: string;
  constructor(message: string, status = 400, opts: { fix?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fix = opts.fix;
  }
}

export const notFound = (what: string, fix: string) => new ApiError(`${what} was not found.`, 404, { fix });

export const json = (data: unknown, status = 200): NextResponse =>
  NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });

export function errorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  const api = err instanceof ApiError ? err : undefined;
  if (!api) console.error("[orrery/api]", err);
  return json({ error: { message, fix: api?.fix } }, api?.status ?? 500);
}

/* -------------------------------- wrapper --------------------------------- */

type RouteCtx<P> = { params: Promise<P> };

/**
 * Boots the process, awaits Next 15's async `params`, JSON-encodes the return
 * value (a returned `Response` — e.g. SSE — passes through) and maps thrown
 * errors to `{ error: { message, fix? } }`.
 */
export function route<P extends Record<string, string> = Record<string, string>>(
  handler: (req: NextRequest, params: P) => Promise<unknown>
) {
  return async (req: NextRequest, ctx: RouteCtx<P>): Promise<Response> => {
    try {
      await ensureBoot();
      const params = ctx?.params ? await ctx.params : ({} as P);
      const out = await handler(req, params);
      return out instanceof Response ? out : json(out);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export const intParam = (req: NextRequest, key: string, fallback: number): number => {
  const raw = req.nextUrl.searchParams.get(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
