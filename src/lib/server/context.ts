/**
 * Request context + JSON conventions for every /api route.
 *
 * Workstream D. One demo session = one local user ("You"); the Navigator
 * identifies itself with `navigatorHeaders()` — the actor header plus a
 * process-local key — and is then bound by the workspace autonomy level.
 * The Navigator's in-process path (lib/navigator/run.ts) never goes through
 * HTTP at all, so nothing outside this server can claim its name.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { NextResponse, type NextRequest } from "next/server";
import type { ActionContext, Role } from "@/lib/actions/core";
import { db, save } from "@/lib/db/store";
import {
  AutonomyLevel,
  type Actor,
  type Invite,
  type Member,
  type Workspace,
} from "@/lib/domain/types";
import { ensureBoot } from "@/lib/server/boot";
import { log, withRequestId, currentRequestId } from "@/lib/log";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { sessionUserFromRequest } from "@/lib/supabase/route";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";

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
 * the local demo user. Inside `route()` the answer was already computed once
 * for the request, so the actor and the resolved workspace can never disagree.
 */
export async function resolveActor(req: NextRequest): Promise<Actor> {
  if (isNavigator(req)) return navigatorActor();
  const state = requestState.getStore();
  if (state) {
    if (!state.user) return demoActor();
    if (state.member) return { type: "user", id: state.member.id, name: state.member.name };
    if (state.denial)
      throw new ApiError(state.denial.message, 403, { fix: state.denial.fix });
  }
  const user = state?.user ?? (await sessionUserFromRequest(req));
  if (!user) return demoActor();
  const outcome = ensureMember(user);
  if ("denied" in outcome)
    throw new ApiError(outcome.denied.message, 403, { fix: outcome.denied.fix });
  return { type: "user", id: outcome.member.id, name: outcome.member.name };
}

/**
 * The actor's role **in the resolved workspace**.
 *
 * `roleOf` (actions/core) finds a member row by id across every workspace, so
 * for a user who belongs to two it answers with whichever sorted first. Every
 * membership decision here is about one workspace, so it asks this instead.
 */
export function workspaceRole(actor: Actor): Role {
  const here = db().members.filter((m) => m.workspaceId === requireWorkspace().id);
  const mine = here.find((m) => m.id === actor.id);
  if (mine) return mine.role;
  // Demo mode ("local") and a brand-new workspace have nobody to defer to.
  return actor.id === "local" || here.length === 0 ? "admin" : "viewer";
}

/** Every caller of a route that mutates membership passes through here. */
export async function requireAdmin(req: NextRequest): Promise<Actor> {
  const actor = await resolveActor(req);
  const role = workspaceRole(actor);
  if (role !== "admin")
    throw new ApiError(
      `Managing members needs the admin role and you are ${role} in ${requireWorkspace().name}.`,
      403,
      { fix: "Ask a workspace admin to make this change, or to give you the admin role." }
    );
  return actor;
}

/* -------------------------------- membership ------------------------------- */

/** Invites in the settings bag: the store's `Database` shape is a spine file. */
// ponytail: settings.invites; move to a Database column when the store gains one
export const readInvites = (): Invite[] => {
  const raw = db().settings.invites;
  return Array.isArray(raw) ? (raw as Invite[]) : [];
};

export const writeInvites = (invites: Invite[]): void => {
  db().settings.invites = invites;
  save();
};

/** Seeded stand-ins nobody can sign in as. They must never hold the admin seat. */
const PLACEHOLDER_EMAILS = new Set(["you@local", "you@kepler.dev"]);
const isPlaceholder = (m: Member): boolean =>
  !m.email || PLACEHOLDER_EMAILS.has(m.email.toLowerCase());

export interface MemberDenial {
  message: string;
  fix: string;
}

/**
 * Which workspace this user's sign-in is about, when the caller has not said.
 *
 * Order matters. An invite is checked **before** the first-real-member rule:
 * with two workspaces, someone invited to B must join B, not silently take the
 * admin seat of an empty A that happens to sort first.
 */
function joinTarget(user: SessionUser): Workspace | undefined {
  const d = db();
  const email = user.email.toLowerCase();
  const held = d.members.find((m) => m.id === user.id || m.email.toLowerCase() === email);
  if (held) return d.workspaces.find((w) => w.id === held.workspaceId);

  const invite = readInvites().find((i) => !i.acceptedAt && i.email.toLowerCase() === email);
  const invited = invite && d.workspaces.find((w) => w.id === invite.workspaceId);
  if (invited) return invited;

  const empty = d.workspaces.find(
    (w) => !d.members.some((m) => m.workspaceId === w.id && !isPlaceholder(m))
  );
  // An operator-granted app_metadata.role is install-wide, not per workspace,
  // so it admits them to the one workspace there is — never picks between many.
  return empty ?? (user.role && d.workspaces.length === 1 ? d.workspaces[0] : undefined);
}

/**
 * Upsert the signed-in user into a workspace's member list.
 *
 * Signing up is not joining. A real user joins only as that workspace's first
 * real member, with a role the operator granted through `app_metadata.role`,
 * or by accepting an invite that names their email. Everyone else is refused
 * by name, with the admins who can invite them. Every rule below is scoped to
 * one workspace: being admin of A grants nothing in B.
 */
export function ensureMember(
  user: SessionUser,
  target?: Workspace
): { member: Member } | { denied: MemberDenial } {
  const d = db();
  const ws = target ?? joinTarget(user);
  if (!ws)
    return {
      denied: d.workspaces.length
        ? denial(user, d.workspaces)
        : {
            message: "No workspace exists yet, so there is nothing to join.",
            fix: "Complete onboarding at /onboarding, or run `npm run seed`.",
          },
    };

  const mine = (): Member[] => d.members.filter((m) => m.workspaceId === ws.id);
  const email = user.email.toLowerCase();
  let member = mine().find((m) => m.id === user.id || m.email.toLowerCase() === email);
  let dirty = false;

  if (member) {
    // An invite names an email; the id only exists once they sign in.
    if (member.id !== user.id || member.name !== user.name) {
      member.id = user.id;
      member.name = user.name;
      dirty = true;
    }
    if (user.role && member.role !== user.role) {
      member.role = user.role;
      dirty = true;
    }
  } else {
    const role = user.role ?? joinRole(ws.id, email);
    if (!role) return { denied: denial(user, [ws]) };
    member = { id: user.id, workspaceId: ws.id, name: user.name, email: user.email, role };
    d.members.push(member);
    dirty = true;
  }

  // Self-heal: a workspace whose only admin is a placeholder has, in practice,
  // no admin at all — every admin action is unreachable for everybody. The
  // first real user to sign in takes the seat, and the placeholder goes.
  const stale = mine().filter((m) => m !== member && isPlaceholder(m));
  if (stale.length) {
    if (!mine().some((m) => !stale.includes(m) && m.role === "admin")) member.role = "admin";
    for (const p of stale) d.members.splice(d.members.indexOf(p), 1);
    dirty = true;
  }

  if (dirty) save();
  return { member };
}

/** The role a never-seen user may join with, or undefined to refuse them. */
function joinRole(workspaceId: string, email: string): Member["role"] | undefined {
  const real = db().members.filter((m) => m.workspaceId === workspaceId && !isPlaceholder(m));
  if (real.length === 0) return "admin"; // the first real user owns the workspace

  const invites = readInvites();
  const invite = invites.find(
    (i) => i.workspaceId === workspaceId && !i.acceptedAt && i.email.toLowerCase() === email
  );
  if (!invite) return undefined;
  invite.acceptedAt = new Date().toISOString();
  writeInvites(invites);
  return invite.role;
}

/** Refused by name, naming the admins of the workspace(s) who could let them in. */
function denial(user: SessionUser, workspaces: Workspace[]): MemberDenial {
  const who = user.email || user.name;
  // Naming the admins only works when there is one workspace to name them of:
  // handing a stranger every admin address on the server is not a fix.
  if (workspaces.length !== 1)
    return {
      message: `${who} is not a member of any of the ${workspaces.length} workspaces on this server.`,
      fix: `Ask an admin of the workspace you should be in to invite ${who} from Settings → Members.`,
    };
  const ws = workspaces[0];
  const admins = db().members.filter(
    (m) => m.workspaceId === ws.id && m.role === "admin" && !isPlaceholder(m)
  );
  return {
    message: `${who} is not a member of ${ws.name}.`,
    fix: admins.length
      ? `Ask ${admins.map((a) => `${a.name} (${a.email})`).join(" or ")} to invite ${who} from Settings → Members.`
      : `No admin exists who could invite you. The operator can grant a role by setting app_metadata.role on your Supabase user (see scripts/seed-users.ts).`,
  };
}

/* -------------------------------- workspace ------------------------------- */

/**
 * The workspace this browser is currently in. httpOnly, so only the server
 * writes it — and only `POST /api/workspace/select`, after checking that the
 * caller is a member. It is a preference, never an authorisation: every read
 * re-checks membership, so a stale cookie from a previous sign-in is ignored
 * rather than obeyed.
 */
export const WORKSPACE_COOKIE = "orrery-workspace";

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

/** Resolved once per request by `route()`; every helper below reads it. */
const requestState = new AsyncLocalStorage<RequestState>();

/** What `route()` worked out about this request, if we are inside one. */
export const currentRequest = (): RequestState | undefined => requestState.getStore();

/**
 * Workspaces this caller may act in. Demo mode (no Supabase keys) is one local
 * user who is in all of them; a signed-in user is in the ones they belong to,
 * matched by id or by the email an invite named before they first signed in.
 */
export function workspacesFor(user: SessionUser | null): Workspace[] {
  const d = db();
  if (!user) return isSupabaseConfigured() ? [] : d.workspaces;
  const email = user.email.toLowerCase();
  const mine = new Set(
    d.members
      .filter((m) => m.id === user.id || m.email.toLowerCase() === email)
      .map((m) => m.workspaceId)
  );
  return d.workspaces.filter((w) => mine.has(w.id));
}

/** Cookie if it still names a workspace the caller belongs to, else their first. */
const pickWorkspace = (cookie: string | undefined, user: SessionUser | null): Workspace | undefined => {
  const allowed = workspacesFor(user);
  return allowed.find((w) => w.id === cookie) ?? allowed[0];
};

const noWorkspace = (user: SessionUser | null): ApiError =>
  db().workspaces.length === 0
    ? new ApiError("No workspace exists yet.", 404, {
        fix: "Complete onboarding at /onboarding, or run `npm run seed`.",
      })
    : new ApiError(`${user?.email || "You"} are not a member of any workspace here.`, 404, {
        fix: "Ask an admin of the workspace you should be in to invite you from Settings → Members, or create your own at /onboarding.",
      });

/**
 * The workspace this request acts in. Every scoped read and write goes through
 * here, so there is one answer per request and no route can pick a different
 * one. Routes never create a workspace implicitly.
 */
export function requireWorkspace(): Workspace {
  const state = requestState.getStore();
  if (state) {
    if (state.workspace) return state.workspace;
    // "Nothing exists yet" is a 404 for everybody; only once something does is
    // being kept out of it a refusal, and then the denial names who can let
    // this caller in.
    if (state.denial && db().workspaces.length)
      throw new ApiError(state.denial.message, 403, { fix: state.denial.fix });
    throw noWorkspace(state.user);
  }
  // Outside a route handler: a script, a test, or a server component that
  // should be calling `currentWorkspace()`. Demo mode is one local user in one
  // workspace, so the first one is the only answer there is; with auth
  // configured there is a real caller to resolve and guessing would leak.
  const w = db().workspaces[0];
  if (!w || isSupabaseConfigured()) throw noWorkspace(null);
  return w;
}

/**
 * The same resolution for server components and server actions, which have
 * `cookies()` instead of a NextRequest. `next/headers` is imported lazily: the
 * /api layer and the tests import this module and must not drag it in.
 */
export async function currentWorkspace(): Promise<Workspace | undefined> {
  const user = await getSessionUser();
  if (user) ensureMember(user);
  return pickWorkspace(await workspaceCookie(), user);
}

/** The selection cookie, or undefined outside a request scope (a unit test). */
async function workspaceCookie(): Promise<string | undefined> {
  try {
    const { cookies } = await import("next/headers");
    return (await cookies()).get(WORKSPACE_COOKIE)?.value;
  } catch {
    return undefined;
  }
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
  const api = err instanceof ApiError ? err : undefined;
  if (api) return json({ error: { message: api.message, fix: api.fix } }, api.status);
  // Anything else is a bug or an environment failure, not something the
  // caller can act on from the raw message (a filesystem path, a parse
  // error). Keep the detail in the server log under the request id and give
  // the caller a fix that leads back to it.
  const requestId = currentRequestId() ?? "unknown";
  log.error("unhandled error in request", { scope: "api", requestId, error: err });
  return json(
    {
      error: {
        message: "Something went wrong on the server while handling this request.",
        fix: `Try again. If it keeps happening, quote request ${requestId} — the server log has the detail.`,
        requestId,
      },
    },
    500
  );
}

/* -------------------------------- wrapper --------------------------------- */

type RouteCtx<P> = { params: Promise<P> };

/**
 * Who is calling and which workspace they are in — worked out once, before the
 * handler runs, so `requireWorkspace()` stays a synchronous zero-argument call
 * at every one of its call sites and cannot answer differently twice in a
 * request. `ensureMember` runs first because signing in is where a user joins:
 * resolving memberships before that would 404 the invited user's first visit.
 */
async function resolveRequest(req: NextRequest): Promise<RequestState> {
  const cookie = req.cookies.get(WORKSPACE_COOKIE)?.value;
  // The Navigator's own HTTP calls carry no session — they are trusted because
  // the key never leaves this process — and act where the browser is.
  if (isNavigator(req)) {
    const all = db().workspaces;
    return { user: null, workspace: all.find((w) => w.id === cookie) ?? all[0] };
  }
  const user = await sessionUserFromRequest(req);
  let denial: MemberDenial | undefined;
  if (user) {
    const outcome = ensureMember(user);
    if ("denied" in outcome) denial = outcome.denied;
  }
  const workspace = pickWorkspace(cookie, user);
  const member =
    user && workspace
      ? db().members.find((m) => m.workspaceId === workspace.id && m.id === user.id)
      : undefined;
  return { user, workspace, member, denial };
}

/**
 * Boots the process, resolves the caller and their workspace, awaits Next 15's
 * async `params`, JSON-encodes the return value (a returned `Response` — e.g.
 * SSE — passes through) and maps thrown errors to `{ error: { message, fix? } }`.
 */
export function route<P extends Record<string, string> = Record<string, string>>(
  handler: (req: NextRequest, params: P) => Promise<unknown>
) {
  return async (req: NextRequest, ctx: RouteCtx<P>): Promise<Response> => {
    // One id per request, carried through every log line it produces and
    // handed back to the caller on a 500 so a report can be matched to a log.
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
    return withRequestId(requestId, async () => {
      try {
        await ensureBoot();
        const state = await resolveRequest(req);
        const out = await requestState.run(state, async () => {
          const params = ctx?.params ? await ctx.params : ({} as P);
          return handler(req, params);
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
 */
export const intParam = (
  req: NextRequest,
  key: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {}
): number => {
  const min = bounds.min ?? 0;
  const max = bounds.max ?? 1000;
  const raw = req.nextUrl.searchParams.get(key);
  const n = raw === null ? NaN : Math.trunc(Number(raw));
  const value = Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, value));
};
