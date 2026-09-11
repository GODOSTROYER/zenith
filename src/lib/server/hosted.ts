/**
 * The hosted /api edge: one wrapper, one body reader, one owner check.
 *
 * It sits at L5 beside `server/context.ts` rather than inside `src/lib/hosted`,
 * which is what lets it import `server/*` and `actions/core` without a cycle —
 * the three edges docs/MODULE-MAP.md listed as "known violations" were all this
 * file living in two places under `hosted/`. `hosted/access/http.ts`,
 * `hosted/release/http.ts` and the ops routes now re-export from here, so every
 * existing import path still answers.
 *
 * What was three copies and is now one:
 *
 *  - **`hostedRoute`** — `route()` plus the hosted error envelope
 *    (`{ error: { code, message, fix?, details? } }` with the code's own
 *    status). Defined in `access/http.ts`, again in `release/http.ts`, and a
 *    third time as `hosted()` under `app/api/hosted/ops/`.
 *  - **`readJsonBody`** — four readers with three different refusals.
 *  - **`requireAppOwner`** — `signedInOwner` / `verifiedOwner` / two
 *    `requireAppOwner`s. The two ways to name a caller are not
 *    interchangeable and stay a parameter:
 *      - `verify: "session"` trusts the session `route()` already resolved.
 *        Enough to *read* an app's access list.
 *      - `verify: "live"` is a round trip to the identity provider, required
 *        before anything that grants, revokes, invites, accepts or opens an app
 *        (decision R3-10). A session that was signed out still has a
 *        valid-looking JWT, and only the provider knows that.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { runAction, type ActionContext, type ActionResult, type Role } from "@/lib/actions/core";
import type { Actor } from "@/lib/domain/types";
import { roleReaches } from "@/lib/domain/roles";
import { authority } from "@/lib/hosted/authority";
import { hostedConfig } from "@/lib/hosted/config";
import {
  DEFAULT_LIMITS,
  HOSTED_STATUS,
  HostedError,
  hostedErrorBody,
  isHostedError,
  type AppGrant,
  type Availability,
  type HostedErrorCode,
  type LimitEnforcement,
  type RuntimeId,
  type Subject,
  type VerifiedIdentity,
} from "@/lib/hosted/contracts";
import { verifyRequestIdentity } from "@/lib/hosted/access/identity";
import { releaseDeps } from "@/lib/hosted/release/deps";
import type { SessionUser } from "@/lib/auth/session";
import { resolveActor, workspaceRole } from "@/lib/server/actor";
import { currentRequest, route } from "@/lib/server/request";
import { requireWorkspace } from "@/lib/server/workspace";

/** JSON with the hosted conventions: `no-store`, and the caller's chosen status. */
export const hostedJson = (data: unknown, status = 200): NextResponse =>
  NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });

/** 202 with the job, for every route that queues durable work. */
export const accepted = (body: unknown): NextResponse => hostedJson(body, 202);

/** The app role vocabulary, as a body-level schema. */
export const RoleSchema = z.enum(["owner", "editor", "viewer"]);

/* ------------------------------- the wrapper ------------------------------ */

/** How the caller behind an owner grant is established. */
export type HostedVerify = "session" | "live";

export interface HostedRouteOptions {
  /** Refuse a caller whose workspace role is below this, before the handler runs. */
  workspaceRole?: Role;
  /** Demand the owner grant on the `appId` path parameter. */
  appRole?: "owner";
  /** How that owner is established. Defaults to `"session"`. */
  verify?: HostedVerify;
  /**
   * What a caller who is not the owner is told. `"forbidden"` says the app is
   * there and they may not; `"not_found"` answers exactly as a missing app
   * does, so an app id is not a way to learn what exists. Each route keeps the
   * one it shipped.
   */
  refusal?: OwnerRefusal;
}

/**
 * What the options above settled, handed to the handler instead of re-derived.
 *
 * A field is filled in exactly when the option that produces it was asked for:
 * `actor`/`role` with `workspaceRole`, the rest with `appRole`.
 */
export interface HostedGrant {
  actor: Actor;
  role: Role;
  /** the identity-provider subject the app grant is keyed by */
  subject: Subject;
  /** the address that subject is known by, where the check learned one */
  email: string;
  grant: AppGrant;
  /** the provider's own answer, under `verify: "live"` */
  identity?: VerifiedIdentity;
}

type PlainHandler<P> = (req: NextRequest, params: P) => Promise<unknown>;
type GrantHandler<P> = (req: NextRequest, params: P, grant: HostedGrant) => Promise<unknown>;

/**
 * Wrap a hosted handler: everything `route()` provides — boot, request id,
 * workspace resolution, `no-store` — plus the hosted error envelope, plus the
 * permission the route needs stated as an option rather than as its first
 * three lines. Anything that is not a `HostedError` is left to
 * `errorResponse`, which is where a bug belongs.
 */
export function hostedRoute<P extends Record<string, string> = Record<string, string>>(
  handler: PlainHandler<P>
): (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;
export function hostedRoute<P extends Record<string, string> = Record<string, string>>(
  options: HostedRouteOptions,
  handler: GrantHandler<P>
): (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;
export function hostedRoute<P extends Record<string, string> = Record<string, string>>(
  optionsOrHandler: HostedRouteOptions | PlainHandler<P>,
  maybeHandler?: GrantHandler<P>
) {
  const options: HostedRouteOptions =
    typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
  const handler = (
    typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler
  ) as GrantHandler<P>;

  return route<P>(async (req, params) => {
    try {
      return await handler(req, params, await hostedGrant(req, params, options));
    } catch (err) {
      if (!isHostedError(err)) throw err;
      const { status, body } = hostedErrorBody(err);
      return hostedJson(body, status);
    }
  });
}

/** Settle a route's declared permissions once, in the order the routes checked them. */
async function hostedGrant<P extends Record<string, string>>(
  req: NextRequest,
  params: P,
  options: HostedRouteOptions
): Promise<HostedGrant> {
  const grant = {} as HostedGrant;
  if (options.workspaceRole) {
    grant.actor = await resolveActor(req);
    grant.role = requireWorkspaceRole(grant.actor, options.workspaceRole);
  }
  if (options.appRole) {
    const owner = await requireAppOwner(params.appId, req, {
      verify: options.verify ?? "session",
      refusal: options.refusal,
      actor: grant.actor,
    });
    Object.assign(grant, owner);
  }
  return grant;
}

/* ------------------------------- who is who ------------------------------- */

/** The caller, resolved once per request. */
export const actorOf = (req: NextRequest): Promise<Actor> => resolveActor(req);

/** The identity-provider subject hosted grants are keyed by. */
export const subjectOf = (actor: Actor): Subject => actor.id;

/** Refuse a caller whose workspace role is below `min`. */
export function requireWorkspaceRole(actor: Actor, min: Role): Role {
  const role = workspaceRole(actor);
  if (!roleReaches(role, min))
    throw new HostedError(
      "forbidden",
      `This needs the ${min} role in ${requireWorkspace().name} and you are ${role}.`,
      { fix: `Ask a workspace admin to raise your role in Settings → Members, or have them do this.` }
    );
  return role;
}

/**
 * The signed-in caller, or `sign_in_required`.
 *
 * Read from the state `route()` already resolved — deliberately **not** from
 * `resolveActor()` or `requireWorkspace()`. Someone invited to an app may hold
 * no workspace membership at all, and accepting their invitation must not
 * require one.
 */
export function signedInUser(): SessionUser {
  const user = currentRequest()?.user;
  if (!user)
    throw new HostedError("sign_in_required", "You are not signed in.", {
      fix: "Sign in to Zenith and try again.",
    });
  return user;
}

/** The caller, verified live against the identity provider. Unavailable is never a pass. */
export const verifiedIdentity = (req: NextRequest): Promise<VerifiedIdentity> =>
  verifyRequestIdentity(req);

/* ------------------------------- owner check ------------------------------ */

export type OwnerRefusal = "forbidden" | "not_found";

export interface OwnerCheck {
  /** `"live"` re-asks the identity provider (R3-10); `"session"` trusts the session. */
  verify: HostedVerify;
  /** How a non-owner is refused. Defaults to `"forbidden"`. */
  refusal?: OwnerRefusal;
  /**
   * The caller a route already resolved, for `verify: "session"`. Without one
   * the session user is the caller — which is not the same thing in demo mode,
   * where there is an actor and no session.
   */
  actor?: Actor;
}

export interface AppOwner {
  subject: Subject;
  email: string;
  grant: AppGrant;
  identity?: VerifiedIdentity;
}

/**
 * The caller's owner grant on an app, or a refusal.
 *
 * Read through the control authority, never from a claim or a cached copy
 * (decision R3-02): a revoked owner is refused here on the next request, and an
 * app id alone is not a read grant.
 */
export async function requireAppOwner(
  appId: string,
  req: NextRequest,
  opts: OwnerCheck
): Promise<AppOwner> {
  const refusal = opts.refusal ?? "forbidden";
  if (opts.verify === "live") {
    const identity = await verifyRequestIdentity(req);
    return {
      subject: identity.subject,
      email: identity.email,
      grant: ownerGrant(appId, identity.subject, refusal),
      identity,
    };
  }
  if (opts.actor) {
    const subject = subjectOf(opts.actor);
    return { subject, email: "", grant: ownerGrant(appId, subject, refusal) };
  }
  const user = signedInCaller(refusal);
  return { subject: user.id, email: user.email, grant: ownerGrant(appId, user.id, refusal) };
}

/**
 * The two surfaces word their sign-in refusal for their own screen, and the
 * refusal mode is what tells them apart: the routes that keep an app id
 * unenumerable are exactly the ones that say which list to open it from.
 */
function signedInCaller(refusal: OwnerRefusal): SessionUser {
  if (refusal !== "not_found") return signedInUser();
  const user = currentRequest()?.user;
  if (!user)
    throw new HostedError(
      "sign_in_required",
      "This endpoint is about a private app, so it needs a signed-in caller.",
      { fix: "Sign in to Zenith and open the app from the apps list." }
    );
  return user;
}

function ownerGrant(appId: string, subject: Subject, refusal: OwnerRefusal): AppGrant {
  if (refusal !== "not_found") return releaseDeps.requireAppRole(appId, subject, "owner");
  // A foreign id answers exactly as a missing one does, so the id space is not
  // enumerable from outside.
  const app = authority().repos.apps.get(appId);
  if (!app) throw noSuchApp(appId);
  const grant = authority().repos.grants.activeFor(appId, subject);
  if (!grant || grant.role !== "owner") throw noSuchApp(appId);
  return grant;
}

const noSuchApp = (appId: string): HostedError =>
  new HostedError("not_found", `No app you own has the id ${appId}.`, {
    fix: "Open the app from your apps list — this endpoint answers only to an owner of that app.",
  });

/** True when this caller holds the app's owner grant. Never throws. */
export function isAppOwner(appId: string, actor: Actor): boolean {
  try {
    return releaseDeps.activeGrant(appId, subjectOf(actor))?.role === "owner";
  } catch {
    // The access module refuses rather than guesses when it cannot answer, and
    // "cannot confirm you are the owner" must read as "not the owner" here.
    return false;
  }
}

/* -------------------------------- the body -------------------------------- */

export interface ReadBodyOptions {
  /** A missing or empty body validates as `{}` rather than being refused. */
  optional?: boolean;
  /**
   * An example of the body this route wants. A route that states one is
   * documenting its own shape, so its refusal names every bad field in one
   * sentence and ends with this; a route that does not gets the generic
   * refusal, which names the first problem and lists the fields to correct.
   * Stating one also makes an unreadable body the schema's problem — it is
   * validated as `{}` and answered with the fields that are missing.
   */
  fix?: string;
}

/**
 * Parse and validate a JSON body, refusing with `invalid_input` and the field
 * that was wrong rather than a stack trace.
 */
export async function readJsonBody<T>(
  req: NextRequest,
  schema: z.ZodType<T>,
  opts: ReadBodyOptions = {}
): Promise<T> {
  return readValue(schema, await rawBody(req, opts), opts);
}

async function rawBody(req: NextRequest, opts: ReadBodyOptions): Promise<unknown> {
  // A route with its own `fix` documents the body it wants, so an unreadable
  // one is answered by the schema rather than by a second refusal.
  if (opts.fix) return (await req.json().catch(() => null)) ?? {};
  if (!opts.optional) {
    try {
      return await req.json();
    } catch {
      throw new HostedError("invalid_input", "This request needs a JSON body.", {
        fix: 'Send `content-type: application/json` and a JSON object, for example {"role":"viewer"}.',
      });
    }
  }
  // Optional: a `DELETE` that may carry `{ reason }` and may carry nothing at
  // all. Missing or empty validates as `{}`; malformed is still `invalid_input`.
  const text = (await req.text()).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HostedError("invalid_input", "This request's body is not valid JSON.", {
      fix: "Send a JSON object, or no body at all.",
    });
  }
}

function readValue<T>(schema: z.ZodType<T>, raw: unknown, opts: ReadBodyOptions): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    field: issue.path.join(".") || "(body)",
    problem: issue.message,
  }));
  if (opts.fix) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new HostedError("invalid_input", `The request body is not usable: ${detail}.`, {
      fix: opts.fix,
    });
  }
  throw new HostedError("invalid_input", `This request body is not valid: ${issues[0].problem}`, {
    fix: `Correct ${issues.map((i) => i.field).join(", ")} and send the request again.`,
    details: { issues },
  });
}

/* ---------------------------- reads a screen needs -------------------------- */

/** What this install's runtime is, and whether it can actually run. */
export async function runtimeStatus(): Promise<{
  id: RuntimeId;
  label: string;
  availability: Availability;
  enforcement: LimitEnforcement | null;
}> {
  const configured = hostedConfig().ZENITH_RUNTIME;
  try {
    const runtime = releaseDeps.runtime();
    return {
      id: runtime.id,
      label: runtime.label,
      availability: await runtime.availability(),
      enforcement: runtime.enforcement,
    };
  } catch (err) {
    // Naming the configured runtime and why it cannot answer beats reporting a
    // runtime that is not there, and beats inventing an enforcement table that
    // claims limits nothing is applying.
    return {
      id: configured,
      label: configured,
      availability: {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
        fix: err instanceof HostedError ? err.fix : undefined,
      },
      enforcement: null,
    };
  }
}

/** The limits every hosted screen displays, alongside who enforces them. */
export const limitsBlock = () => DEFAULT_LIMITS;

/** Grants and invitations on an app, read straight from the authority. */
export function ownerOnlyBlock(appId: string) {
  const a = authority();
  return { grants: a.repos.grants.listByApp(appId), invites: a.repos.invites.listByApp(appId) };
}

/* ------------------------------ hosted actions ----------------------------- */

/**
 * The refusal an action flattened, rebuilt as the `HostedError` it started as.
 *
 * `runAction` turns a thrown error into `{ ok: false, error: string }`, which
 * is right for the UI and lossy for HTTP: a duplicate slug is a 409 and an
 * unknown app is a 404, and both would otherwise reach the caller as a 500.
 * The hosted actions carry the code through in `data.hosted`; this is the
 * other half of that arrangement.
 */
export function hostedErrorFromResult(result: ActionResult): HostedError {
  const carried = (result.data as { hosted?: Record<string, unknown> } | undefined)?.hosted;
  const code = typeof carried?.code === "string" ? carried.code : undefined;
  if (code && code in HOSTED_STATUS)
    return new HostedError(code as HostedErrorCode, String(carried?.message ?? result.summary), {
      fix: typeof carried?.fix === "string" ? carried.fix : undefined,
      details: carried?.details as Record<string, unknown> | undefined,
    });
  return new HostedError("invalid_input", result.summary, { fix: result.error });
}

/**
 * Run a hosted action's execute and answer with its refusal's own status.
 *
 * Deliberately without `runAction`'s `idempotencyKey`. That cache is an
 * in-process ten-minute replay window keyed by actor and action; hosted jobs
 * have a durable one keyed by the client's job id, which survives a restart
 * *and* refuses the same id carrying different content. Handing the same job id
 * to both would let the weaker mechanism answer first — returning the earlier
 * success for a request that the authority would have refused with
 * `idempotency_conflict`, which is the one answer this surface must never
 * invent.
 */
export async function executeHosted(
  actionId: string,
  ctx: ActionContext,
  input: unknown
): Promise<ActionResult> {
  const { result } = await runAction(actionId, ctx, input, { mode: "execute" });
  if (!result)
    throw new HostedError("internal", `The ${actionId} action returned no result.`, {
      fix: "Try again. If it keeps happening, quote the request id from the response headers.",
    });
  if (!result.ok) throw hostedErrorFromResult(result);
  return result;
}
