/**
 * The two things every ops route needs: who is asking, and how a hosted
 * refusal reaches the wire.
 *
 * `route()` (server/context) maps its own `ApiError` to `{ error: { message,
 * fix } }` and everything else to a 500. Hosted routes answer the richer
 * contract from `CONTRACTS-R3.md` — `{ error: { code, message, fix?, details? } }`
 * with the code's own status — so each handler wraps itself in `hosted()`,
 * which turns a `HostedError` into exactly that response and leaves anything
 * else for `route()` to log and report as a 500.
 *
 * ponytail: this file lives under `app/api/hosted/ops/` because that is inside
 * W8's exclusive paths, and it is imported by the four app-scoped ops routes.
 * Its natural home is a shared `src/lib/hosted/http.ts` owned by the
 * integrator, next to the gateway's own error mapping; moving it there is a
 * one-line import change in five files.
 *
 * Workstream W8 (hosted R3).
 */
import { NextResponse } from "next/server";
import { HostedError, hostedErrorBody, type Subject } from "@/lib/hosted/contracts";
import { authority } from "@/lib/hosted/authority";
import { currentRequest } from "@/lib/server/context";

/** The signed-in caller, or a `sign_in_required` refusal naming what to do. */
export function requireCaller(): { subject: Subject; email: string } {
  const user = currentRequest()?.user;
  if (!user)
    throw new HostedError("sign_in_required", "This endpoint is about a private app, so it needs a signed-in caller.", {
      fix: "Sign in to Zenith and open the app from the apps list.",
    });
  return { subject: user.id, email: user.email };
}

/**
 * The caller's live owner grant on an app, or a refusal.
 *
 * Read through the control authority, never from a claim or a cached copy
 * (decision R3-02): a revoked owner is refused here on the next request, and
 * an app id alone is not a read grant.
 */
export function requireAppOwner(appId: string): { subject: Subject; email: string } {
  const caller = requireCaller();
  const app = authority().repos.apps.get(appId);
  // A foreign id answers exactly as a missing one does, so the id space is not
  // enumerable from outside.
  if (!app) throw noSuchApp(appId);
  const grant = authority().repos.grants.activeFor(appId, caller.subject);
  if (!grant || grant.role !== "owner") throw noSuchApp(appId);
  return caller;
}

const noSuchApp = (appId: string): HostedError =>
  new HostedError("not_found", `No app you own has the id ${appId}.`, {
    fix: "Open the app from your apps list — this endpoint answers only to an owner of that app.",
  });

/** Run a handler, turning a `HostedError` into the hosted error response. */
export async function hosted(handler: () => Promise<unknown>): Promise<Response> {
  try {
    const body = await handler();
    if (body instanceof Response) return body;
    return NextResponse.json(body, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (!(error instanceof HostedError)) throw error;
    const { status, body } = hostedErrorBody(error);
    return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
  }
}

/** A bounded integer query parameter. */
export function intQuery(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  const parsed = raw === null ? NaN : Math.trunc(Number(raw));
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}
