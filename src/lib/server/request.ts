/**
 * The request scope: what `route()` works out once, and where it keeps it.
 *
 * `RequestState` is resolved before the handler runs and read back by every
 * helper in this directory through `currentRequest()`, so `requireWorkspace()`
 * stays a synchronous zero-argument call that cannot answer differently twice
 * in one request.
 *
 * The resolution itself lives in `server/actor.ts` and is reached through a
 * dynamic import: that module reads this one's request scope, and importing it
 * back statically would be the only import cycle in `src/lib/server`.
 *
 * Split out of `server/context.ts`, which re-exports everything here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextRequest } from "next/server";
import type { Role } from "@/lib/actions/core";
import type { Actor, Member, Workspace } from "@/lib/domain/types";
import type { SessionUser } from "@/lib/auth/session";
import { withRequestId } from "@/lib/log";
import { errorResponse, json } from "@/lib/server/errors";
import type { MemberDenial } from "@/lib/server/membership";

export interface RequestState {
  /** signed-in user, or null in demo mode / signed out */
  user: SessionUser | null;
  /** the workspace this request acts in */
  workspace?: Workspace;
  /** the caller's member row *in that workspace* */
  member?: Member;
  /** why the caller holds no membership, when that is why there is no workspace */
  denial?: MemberDenial;
}

/** Resolved once per request by `route()`; every helper in this directory reads it. */
const requestState = new AsyncLocalStorage<RequestState>();

/** What `route()` worked out about this request, if we are inside one. */
export const currentRequest = (): RequestState | undefined => requestState.getStore();

type RouteCtx<P> = { params: Promise<P> };

/** The permission a route needs, stated once instead of re-typed per handler. */
export interface RouteOptions {
  /**
   * Refuse a caller whose role in the resolved workspace is below this, before
   * the handler runs — the same refusal `requireAdmin`/`workspaceRole` threw
   * when each route spelled the check out itself.
   */
  workspaceRole?: Role;
}

/** What the options above settled, handed to the handler rather than re-derived. */
export interface RouteGrant {
  /** the caller, resolved once for this request */
  actor: Actor;
  /** their role in the resolved workspace */
  role: Role;
}

type PlainHandler<P> = (req: NextRequest, params: P) => Promise<unknown>;
type GrantHandler<P> = (req: NextRequest, params: P, grant: RouteGrant) => Promise<unknown>;

/**
 * Boots the process, resolves the caller and their workspace, awaits Next 15's
 * async `params`, JSON-encodes the return value (a returned `Response` — e.g.
 * SSE — passes through) and maps thrown errors to `{ error: { message, fix? } }`.
 *
 * With an options object first, the permission the handler needs is a
 * parameter rather than its first two lines: `route({ workspaceRole: "admin" },
 * handler)` resolves the actor, refuses anybody below that role, and passes the
 * actor and role in.
 */
export function route<P extends Record<string, string> = Record<string, string>>(
  handler: PlainHandler<P>
): (req: NextRequest, ctx: RouteCtx<P>) => Promise<Response>;
export function route<P extends Record<string, string> = Record<string, string>>(
  options: RouteOptions,
  handler: GrantHandler<P>
): (req: NextRequest, ctx: RouteCtx<P>) => Promise<Response>;
export function route<P extends Record<string, string> = Record<string, string>>(
  optionsOrHandler: RouteOptions | PlainHandler<P>,
  maybeHandler?: GrantHandler<P>
) {
  const options: RouteOptions = typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
  const handler = (
    typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler
  ) as GrantHandler<P>;

  return async (req: NextRequest, ctx: RouteCtx<P>): Promise<Response> => {
    // One id per request, carried through every log line it produces and
    // handed back to the caller on a 500 so a report can be matched to a log.
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
    return withRequestId(requestId, async () => {
      try {
        // Server-rendered reads also use context helpers. Only API handling
        // needs to load/resume the action and provider runtime.
        const { ensureBoot } = await import("@/lib/server/boot");
        await ensureBoot();
        const { resolveRequest, routeGrant } = await import("@/lib/server/actor");
        const state = await resolveRequest(req);
        const out = await requestState.run(state, async () => {
          const params = ctx?.params ? await ctx.params : ({} as P);
          // A route that demands nothing must not resolve an actor: the
          // invitation routes answer callers `resolveActor()` would refuse.
          const grant = options.workspaceRole
            ? await routeGrant(req, options.workspaceRole)
            : (undefined as unknown as RouteGrant);
          return handler(req, params, grant);
        });
        const res = out instanceof Response ? out : json(out);
        res.headers.set("x-request-id", requestId);
        return res;
      } catch (err) {
        const res = errorResponse(err);
        res.headers.set("x-request-id", requestId);
        return res;
      }
    });
  };
}

/**
 * Integer query parameter, clamped. A forgotten clamp is an unbounded
 * response, so the bounds live here: default 0..1000, callers narrow them.
 *
 * Takes a request or a bare `URL`, because some handlers have already parsed
 * the one out of the other and there is no second rule for those.
 */
export const intParam = (
  from: NextRequest | URL,
  key: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {}
): number => {
  const min = bounds.min ?? 0;
  const max = bounds.max ?? 1000;
  const params = from instanceof URL ? from.searchParams : from.nextUrl.searchParams;
  const raw = params.get(key);
  const n = raw === null ? NaN : Math.trunc(Number(raw));
  const value = Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, value));
};
