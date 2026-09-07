/**
 * What the hosted control routes share: the error shape, the two role checks
 * and the reads a screen needs.
 *
 * It lives here rather than beside the routes because `src/app/api/hosted/apps`
 * may only hold route files, and because the same refusal has to read the same
 * way whether it came out of a route, an action or the job runner.
 *
 * The one thing this file really adds is the error mapping. `route()` answers
 * anything that is not an `ApiError` with a 500, which is the right default and
 * the wrong answer for a hosted refusal: a duplicate slug is a 409, a
 * suspended app is a 423, an unavailable runtime is a 503, and each of those
 * codes is what tells a caller whether to change the request, wait, or stop.
 * `hostedRoute` restores them.
 *
 * Workstream W7 (hosted R3).
 */
import { NextResponse, type NextRequest } from "next/server";
import { runAction, type ActionContext, type ActionResult, type Role } from "@/lib/actions/core";
import { authority } from "@/lib/hosted/authority";
import { hostedConfig } from "@/lib/hosted/config";
import {
  DEFAULT_LIMITS,
  HOSTED_STATUS,
  HostedError,
  hostedErrorBody,
  isHostedError,
  type Availability,
  type HostedErrorCode,
  type LimitEnforcement,
  type RuntimeId,
  type Subject,
} from "@/lib/hosted/contracts";
import { type Actor } from "@/lib/domain/types";
import { json, requireWorkspace, resolveActor, route, workspaceRole } from "@/lib/server/context";
import { releaseDeps } from "./deps";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/**
 * `route()`, plus: a `HostedError` answers with its own status and the
 * `{ error: { code, message, fix, details } }` body every hosted surface uses.
 */
export function hostedRoute<P extends Record<string, string> = Record<string, string>>(
  handler: (req: NextRequest, params: P) => Promise<unknown>
) {
  return route<P>(async (req, params) => {
    try {
      return await handler(req, params);
    } catch (err) {
      if (!isHostedError(err)) throw err;
      const { status, body } = hostedErrorBody(err);
      return json(body, status);
    }
  });
}

/** The caller, resolved once per request. */
export const actorOf = (req: NextRequest): Promise<Actor> => resolveActor(req);

/** The identity-provider subject hosted grants are keyed by. */
export const subjectOf = (actor: Actor): Subject => actor.id;

/** Refuse a caller whose workspace role is below `min`. */
export function requireWorkspaceRole(actor: Actor, min: Role): Role {
  const role = workspaceRole(actor);
  if (RANK[role] < RANK[min])
    throw new HostedError(
      "forbidden",
      `This needs the ${min} role in ${requireWorkspace().name} and you are ${role}.`,
      { fix: `Ask a workspace admin to raise your role in Settings → Members, or have them do this.` }
    );
  return role;
}

/** Refuse a caller who does not hold the app's owner grant. */
export function requireAppOwner(appId: string, actor: Actor) {
  return releaseDeps.requireAppRole(appId, subjectOf(actor), "owner");
}

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

/** Parse a JSON body, refusing anything that is not the shape the route documents. */
export async function readBody<T>(
  req: NextRequest,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } },
  fix: string
): Promise<T> {
  const raw: unknown = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
  throw new HostedError("invalid_input", `The request body is not usable: ${detail}.`, { fix });
}

/** 202 with the job, for every route that queues durable work. */
export const accepted = (body: unknown): NextResponse => json(body, 202);

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
