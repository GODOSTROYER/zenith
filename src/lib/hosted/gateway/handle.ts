/**
 * `handleGateway` — the app host's front door, and the security boundary a
 * recipient actually hits.
 *
 * Every request to `<slug>.<ZENITH_APP_DOMAIN>` is rewritten here by the edge
 * middleware with its Host header intact. The order below is the contract, and
 * it is the order for a reason: each step is cheaper and less trusting than
 * the one after it, and the two steps that touch anything an app produced —
 * the artifact and the broker — are last.
 *
 *   1 host          the Host header names an app host, and the route agrees
 *   2 app           a live app owns that slug
 *   3 state         suspended / recovering answer 423
 *   4 quota         every request that got this far is counted
 *   5 authority     anything the authority cannot answer is 503, never a pass
 *   6 reserved      /_zenith/* is Zenith's, always
 *   7 session       an opaque cookie, resolved live against a live grant
 *   8 release       the app's durable active-release pointer
 *   9 artifact      bytes, with HEAD, Range and ETag — all after step 7
 *  10 guard         one exit, one set of headers, on refusals too
 *
 * A denial never reaches steps 9 or 10's payload: `gatewayTelemetry` counts
 * artifact reads and broker calls, and the denial tests assert both are zero.
 */
import type { NextRequest } from "next/server";
import type { HostedApp } from "@/lib/hosted/contracts";
import {
  admitSession,
  appSessionCookieValue,
  assertAppState,
  countRequest,
  isReservedPath,
  loadApp,
  noteAccessDenied,
  noteAppOpened,
  normalizeAppPath,
  refusedPath,
  reservedRouteOf,
  resolveActiveRelease,
  resolveHost,
  unknownReservedRoute,
} from "./admission";
import { serveArtifact } from "./artifacts";
import { hostedErrorOf, methodNotAllowed, respondWithError, wantsHtml } from "./errors";
import { gatewaySeeOther } from "./guard";
import { handleReserved } from "./reserved";

/** The route parameters the rewrite produces: the encoded host, then the app path. */
export interface GatewayParams {
  host: string;
  path?: string[];
}

/** Methods an app's own files answer. Everything else is 405 with `allow`. */
const CONTENT_METHODS = ["GET", "HEAD"] as const;

/** Refusals that mean "you were turned away", as opposed to "that does not exist". */
const DENIAL_CODES = new Set([
  "sign_in_required",
  "forbidden",
  "csrf_rejected",
  "suspended",
  "recovering",
  "quota_exceeded",
]);

/**
 * Answer one app-host request.
 *
 * Returns a response for every outcome — it never throws — and every response
 * it returns has been through the guard.
 */
export async function handleGateway(req: NextRequest, params: GatewayParams): Promise<Response> {
  const html = wantsHtml(req);
  const method = req.method.toUpperCase();
  let app: HostedApp | undefined;
  let releaseId: string | undefined;
  let subject: string | undefined;

  try {
    // 1 — the Host header, and the path segment the rewrite recorded, must be
    // the same app host. A request that reached this route some other way (a
    // direct GET of /hosted-gateway/... on the control origin) carries the
    // control origin's Host and stops here.
    const { host, slug } = resolveHost(req.headers.get("host"), params.host);

    // 2
    app = loadApp(slug);

    // The path is parsed now because step 3 needs to know whether this is the
    // sign-in page, but a path the gateway refuses is not rejected until after
    // the quota has counted the request (R3-12: everything that resolved to a
    // known app host counts).
    const normalized = normalizeAppPath(params.path);
    const reserved = normalized === null ? null : reservedRouteOf(normalized);

    // 3
    assertAppState(app, { method, reserved });

    // 4 (5 is not a step of its own: `authorityStep` wraps every read above
    // and below, so a control authority that cannot answer is a 503 anywhere.)
    countRequest(app);

    if (normalized === null) throw refusedPath();

    // 6
    if (isReservedPath(normalized)) {
      if (!reserved) throw unknownReservedRoute();
      const cookieValue = appSessionCookieValue(req.headers.get("cookie"));
      return await handleReserved(req, reserved, { app, host, cookieValue });
    }

    // App content answers two methods. This is decided before admission on
    // purpose: which verbs a static file host supports is not a secret, and a
    // 401 on a DELETE would imply that signing in would make it work.
    if (!CONTENT_METHODS.includes(method as (typeof CONTENT_METHODS)[number]))
      return methodNotAllowed(CONTENT_METHODS, { wantsHtml: html, what: "An app page" });

    // 7
    const cookieValue = appSessionCookieValue(req.headers.get("cookie"));
    const { session, grant } = admitSession(app, cookieValue);
    subject = session.subject;

    // 8
    const { release, digest } = resolveActiveRelease(app);
    releaseId = release.id;
    noteAppOpened(app, session, release.id);

    // 9
    return await serveArtifact(req, normalized, { host, app, session, grant, release, digest });
  } catch (err) {
    const hosted = hostedErrorOf(err);
    if (app && hosted && DENIAL_CODES.has(hosted.code))
      noteAccessDenied(app, hosted.code, { subject, releaseId });

    // A person who followed a link should land on the page that explains how
    // to get in, not on a JSON body they cannot read. A program gets the
    // envelope, so its retry logic can tell 401 from 403.
    if (hosted?.code === "sign_in_required" && html) return gatewaySeeOther("/_zenith/auth/signin");

    return respondWithError(err, { wantsHtml: html, releaseId });
  }
}
