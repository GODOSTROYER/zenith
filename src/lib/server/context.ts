/**
 * Request context + JSON conventions for every /api route.
 *
 * Workstream D. One demo session = one local user ("You"); the Navigator
 * identifies itself with `navigatorHeaders()` — the actor header plus a
 * process-local key — and is then bound by the workspace autonomy level.
 * The Navigator's in-process path (lib/navigator/run.ts) never goes through
 * HTTP at all, so nothing outside this server can claim its name.
 */
import { NextResponse, type NextRequest } from "next/server";
import type { ActionContext } from "@/lib/actions/core";
import { db, save } from "@/lib/db/store";
import { AutonomyLevel, type Actor, type Workspace } from "@/lib/domain/types";
import { ensureBoot } from "@/lib/server/boot";
import { sessionUserFromRequest } from "@/lib/supabase/route";
import type { SessionUser } from "@/lib/auth/session";

/* --------------------------------- actors --------------------------------- */

export const demoActor = (): Actor => ({ type: "user", id: "local", name: "You" });

export const navigatorActor = (): Actor => ({
  type: "navigator",
  id: "navigator",
  name: "Navigator",
});

/**
 * Navigator attribution has to be earned, not asserted: the audit log is
 * evidence, so a browser must not be able to sign its actions "Navigator".
 * The Navigator's own server-side calls carry a secret minted at boot and
 * never leaving this process; anything else is just the user.
 */
type GK = typeof globalThis & { __orreryNavKey?: string };

const navigatorKey = (): string => {
  const g = globalThis as GK;
  return (g.__orreryNavKey ??= crypto.randomUUID());
};

/** Headers the Navigator's own HTTP calls must send to be attributed to it. */
export const navigatorHeaders = (): Record<string, string> => ({
  "x-orrery-actor": "navigator",
  "x-orrery-actor-key": navigatorKey(),
});

const isNavigator = (req: NextRequest): boolean =>
  req.headers.get("x-orrery-actor") === "navigator" &&
  req.headers.get("x-orrery-actor-key") === navigatorKey();

/** True only for the Navigator's own calls; everything else is the local user. */
export const actorFromRequest = (req: NextRequest): Actor =>
  isNavigator(req) ? navigatorActor() : demoActor();

/**
 * Identity-aware actor: a proven Navigator call wins; otherwise the signed-in
 * Supabase user when auth is configured (verified via getClaims); otherwise
 * the local demo user. Also keeps the workspace member list in sync so the
 * audit log and revisions carry a real name.
 */
export async function resolveActor(req: NextRequest): Promise<Actor> {
  if (isNavigator(req)) return navigatorActor();
  const user = await sessionUserFromRequest(req);
  if (!user) return demoActor();
  ensureMember(user);
  return { type: "user", id: user.id, name: user.name };
}

/** Upsert the signed-in user into the workspace's member list (first user = admin). */
export function ensureMember(user: SessionUser): void {
  const d = db();
  const ws = d.workspaces[0];
  if (!ws) return;
  const existing = d.members.find((m) => m.id === user.id || m.email === user.email);
  if (existing) {
    if (existing.name !== user.name || existing.id !== user.id) {
      existing.name = user.name;
      existing.id = user.id;
      save();
    }
    return;
  }
  d.members.push({
    id: user.id,
    workspaceId: ws.id,
    name: user.name,
    email: user.email,
    role: d.members.some((m) => m.workspaceId === ws.id && m.role === "admin") ? "editor" : "admin",
  });
  save();
}

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
