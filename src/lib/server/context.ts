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
import { roleOf, type ActionContext } from "@/lib/actions/core";
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
  const outcome = ensureMember(user);
  if ("denied" in outcome)
    throw new ApiError(outcome.denied.message, 403, { fix: outcome.denied.fix });
  return { type: "user", id: outcome.member.id, name: outcome.member.name };
}

/** Every caller of a route that mutates membership passes through here. */
export async function requireAdmin(req: NextRequest): Promise<Actor> {
  const actor = await resolveActor(req);
  const role = roleOf(actor);
  if (role !== "admin")
    throw new ApiError(
      `Managing members needs the admin role and you are ${role} in this workspace.`,
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
 * Upsert the signed-in user into the workspace's member list.
 *
 * Signing up is not joining. A real user joins only as the workspace's first
 * real member, with a role the operator granted through `app_metadata.role`,
 * or by accepting an invite that names their email. Everyone else is refused
 * by name, with the admins who can invite them.
 */
export function ensureMember(user: SessionUser): { member: Member } | { denied: MemberDenial } {
  const d = db();
  const ws = d.workspaces[0];
  if (!ws)
    return {
      denied: {
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
    if (!role) return { denied: denial(user, ws.name, mine()) };
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

function denial(user: SessionUser, workspaceName: string, members: Member[]): MemberDenial {
  const admins = members.filter((m) => m.role === "admin" && !isPlaceholder(m));
  const who = user.email || user.name;
  return {
    message: `${who} is not a member of ${workspaceName}.`,
    fix: admins.length
      ? `Ask ${admins.map((a) => `${a.name} (${a.email})`).join(" or ")} to invite ${who} from Settings → Members.`
      : `No admin exists who could invite you. The operator can grant a role by setting app_metadata.role on your Supabase user (see scripts/seed-users.ts).`,
  };
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
 * Boots the process, awaits Next 15's async `params`, JSON-encodes the return
 * value (a returned `Response` — e.g. SSE — passes through) and maps thrown
 * errors to `{ error: { message, fix? } }`.
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
        const params = ctx?.params ? await ctx.params : ({} as P);
        const out = await handler(req, params);
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
