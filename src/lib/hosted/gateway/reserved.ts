/**
 * The reserved routes: everything under `/_zenith/` that Zenith answers itself.
 *
 * These win over app code unconditionally. An app that ships a file at
 * `_zenith/session` never gets to serve it, because the reserved check happens
 * at step 6 of admission and the artifact lookup at step 9.
 *
 * Two of them — the sign-in page and the exchange callback — are reachable
 * without a session, because they are how a session begins. Everything else
 * here is behind the same admission as an artifact.
 */
import type { NextRequest } from "next/server";
import { hostedConfig } from "@/lib/hosted/config";
import {
  HostedError,
  TRACKER_SCHEMA_VERSION,
  type HostedApp,
  type SessionInfo,
} from "@/lib/hosted/contracts";
import { selectedHostedRuntime } from "@/lib/hosted/runtime";
import {
  admitSession,
  noteAccessDenied,
  noteAppOpened,
  resolveActiveRelease,
  unknownReservedRoute,
  type AdmittedRequest,
  type ReservedRoute,
} from "./admission";
import { assertSameOriginMutation, BROKER_LIMITS, handleBroker } from "./broker";
import { gatewayDeps } from "./deps";
import { methodNotAllowed } from "./errors";
import { gatewayHtml, gatewayJson, gatewaySeeOther } from "./guard";

/* ------------------------------ sign-in page ------------------------------ */

/**
 * One sentence per refusal the callback can bounce back with.
 *
 * The page never repeats anything the redemption said: the codes are a fixed
 * table here, so a failed exchange cannot put text of its choosing in front of
 * the next person to open the link.
 */
const SIGN_IN_MESSAGES: Record<string, string> = {
  sign_in_required: "Your session has ended.",
  forbidden: "Your access to this app has changed, so that link no longer works.",
  not_found: "That sign-in link has already been used, or it expired.",
  conflict: "That sign-in link has already been used.",
  invalid_input: "That sign-in link was incomplete.",
  csrf_rejected: "That sign-in link did not come from Zenith.",
  suspended: "This app is paused right now.",
  recovering: "This app is coming back up after a restore.",
  quota_exceeded: "This app has reached its request limit for today.",
  policy_unavailable: "The service that checks access is not answering right now.",
  internal: "Something went wrong while signing you in.",
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The sign-in page.
 *
 * There are no credentials on it and there is no script in it. The whole point
 * of an app host is that it never sees a platform credential, so the page's
 * only job is to say where the door is: the control origin's apps list, which
 * mints the single-use exchange code that lands back on this host.
 */
export function signInPage(app: HostedApp, errorCode?: string): string {
  const controlOrigin = hostedConfig().ZENITH_CONTROL_ORIGIN.replace(/\/+$/, "");
  const notice =
    errorCode && Object.prototype.hasOwnProperty.call(SIGN_IN_MESSAGES, errorCode)
      ? SIGN_IN_MESSAGES[errorCode]
      : errorCode
        ? "That sign-in link did not work."
        : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open ${escapeHtml(app.name)} from Zenith</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #f6f7f9; color: #14171f; padding: 24px; }
  main { max-width: 30rem; background: #fff; border: 1px solid #e3e6ec; border-radius: 12px; padding: 28px; }
  h1 { font-size: 1.2rem; margin: 0 0 12px; }
  p { margin: 0 0 12px; }
  .notice { color: #8a3d2f; }
  a.go { display: inline-block; margin-top: 6px; padding: 10px 16px; border-radius: 8px;
         background: #1f2937; color: #fff; text-decoration: none; }
  a.go:focus-visible { outline: 3px solid #6f8bd0; outline-offset: 2px; }
  small { color: #5a6172; }
  @media (prefers-color-scheme: dark) {
    body { background: #101319; color: #e8eaf0; }
    main { background: #171b23; border-color: #262b36; }
    .notice { color: #f0a58f; }
    a.go { background: #e8eaf0; color: #14171f; }
    small { color: #98a0b0; }
  }
</style>
</head>
<body>
<main>
  <h1>Open this app from Zenith</h1>
  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
  <p>${escapeHtml(app.name)} is a private app. Zenith signs you in when you open it from your apps list; there is nothing to type in here.</p>
  <p><a class="go" href="${escapeHtml(controlOrigin)}/apps">Go to your Zenith apps</a></p>
  <p><small>If you cannot see this app there, ask its owner to invite you.</small></p>
</main>
</body>
</html>
`;
}

/* --------------------------------- routes --------------------------------- */

/** `GET /_zenith/auth/signin` — reachable while suspended, and without a session. */
function signIn(req: NextRequest, app: HostedApp): Response {
  if (req.method !== "GET")
    return methodNotAllowed(["GET"], { wantsHtml: false, what: "The sign-in page" });
  const error = new URL(req.url).searchParams.get("error");
  return gatewayHtml(signInPage(app, error ?? undefined));
}

/**
 * `GET /_zenith/auth/callback?code&state` — the one place a session is created.
 *
 * Redemption is atomic and single-use in the access module (W5). Anything it
 * refuses becomes a bounce to the sign-in page carrying only the *code*: the
 * message that goes in front of the recipient comes from the fixed table
 * above, never from the failure.
 */
async function authCallback(req: NextRequest, app: HostedApp): Promise<Response> {
  if (req.method !== "GET")
    return methodNotAllowed(["GET"], { wantsHtml: false, what: "The sign-in callback" });
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const bounce = (reason: string): Response =>
    gatewaySeeOther(`/_zenith/auth/signin?error=${encodeURIComponent(reason)}`);

  if (!code || !state) return bounce("invalid_input");
  try {
    const deps = gatewayDeps();
    const { cookieValue, session } = await deps.redeemExchange(code, { appId: app.id, state });
    return gatewaySeeOther("/", { setCookie: deps.appSessionCookie(cookieValue, session.expiresAt) });
  } catch (err) {
    await noteAccessDenied(app, err instanceof HostedError ? err.code : "internal");
    return bounce(err instanceof HostedError ? err.code : "internal");
  }
}

/** `POST /_zenith/auth/signout` — terminate the session, clear the cookie, show the door. */
async function signOut(req: NextRequest, host: string, cookieValue: string | null): Promise<Response> {
  if (req.method !== "POST")
    return methodNotAllowed(["POST"], { wantsHtml: false, what: "Signing out" });
  // Sign-out changes state, so it needs the same origin proof a write does.
  // It carries no body worth parsing, so no content type is required.
  assertSameOriginMutation(req, host, { requireJsonContentType: false });
  if (cookieValue) {
    try {
      await gatewayDeps().terminateAppSession(cookieValue, "signed_out");
    } catch {
      // The cookie is cleared either way: a session the authority cannot reach
      // must not stay in the browser looking valid.
    }
  }
  return gatewaySeeOther("/_zenith/auth/signin", {
    setCookie: gatewayDeps().clearAppSessionCookie(),
  });
}

/** `GET /_zenith/session` — who the recipient is, and the bounds their app must respect. */
function sessionInfo(req: NextRequest, admitted: AdmittedRequest): Response {
  if (req.method !== "GET")
    return methodNotAllowed(["GET"], { wantsHtml: false, what: "The session endpoint" });
  const body: SessionInfo = {
    subject: admitted.session.subject,
    email: admitted.grant.email,
    role: admitted.grant.role,
    app: { id: admitted.app.id, slug: admitted.app.slug, name: admitted.app.name },
    controlOrigin: hostedConfig().ZENITH_CONTROL_ORIGIN.replace(/\/+$/, ""),
    releaseId: admitted.release.id,
    schemaVersion: TRACKER_SCHEMA_VERSION,
    limits: { listMax: BROKER_LIMITS.listMax, bodyBytes: BROKER_LIMITS.bodyBytes },
    expiresAt: admitted.session.expiresAt,
  };
  return gatewayJson(body, { releaseId: admitted.release.id });
}

/** What `GET /_zenith/health` answers. `simulated` is false and stays false. */
export interface GatewayHealth {
  simulated: false;
  release: { id: string; number: number; digest: string };
  app: { slug: string; state: string };
  runtime: { id: string; label: string };
  checks: { id: string; ok: boolean; detail: string }[];
}

/**
 * `GET /_zenith/health` — real probes, run now, attributed to the release that
 * answered. Any role may read it: it carries no customer data, and a recipient
 * who cannot tell "the app is down" from "I am locked out" files the wrong
 * complaint.
 */
async function health(req: NextRequest, admitted: AdmittedRequest): Promise<Response> {
  if (req.method !== "GET")
    return methodNotAllowed(["GET"], { wantsHtml: false, what: "The health endpoint" });
  const checks: GatewayHealth["checks"] = [];

  const verdict = await gatewayDeps().artifactStore().verify(admitted.digest);
  checks.push({ id: "artifact.verified", ok: verdict.ok, detail: verdict.detail });

  try {
    const store = gatewayDeps().openAppData(admitted.app.id).store;
    const version = await store.schemaVersion(admitted.app.id);
    checks.push({
      id: "data.schemaVersion",
      ok: version === TRACKER_SCHEMA_VERSION,
      detail: `This app's data is at tracker schema version ${version}; the running contract is version ${TRACKER_SCHEMA_VERSION}.`,
    });
  } catch (err) {
    checks.push({
      id: "data.schemaVersion",
      ok: false,
      detail: err instanceof Error ? err.message : "The app's database did not answer.",
    });
  }

  let runtime = { id: hostedConfig().ZENITH_RUNTIME as string, label: "" };
  try {
    const selected = selectedHostedRuntime();
    runtime = { id: selected.id, label: selected.label };
    checks.push({ id: "runtime.available", ok: true, detail: selected.label });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "The runtime is not available.";
    runtime = { id: runtime.id, label: detail };
    checks.push({ id: "runtime.available", ok: false, detail });
  }

  const body: GatewayHealth = {
    simulated: false,
    release: {
      id: admitted.release.id,
      number: admitted.release.number,
      digest: admitted.digest,
    },
    app: { slug: admitted.app.slug, state: admitted.app.state },
    runtime,
    checks,
  };
  return gatewayJson(body, { releaseId: admitted.release.id });
}

/* ------------------------------- the router ------------------------------- */

/** Everything a reserved handler may need that admission has already decided. */
export interface ReservedContext {
  app: HostedApp;
  host: string;
  /** The opaque app-session cookie on this request, or null. */
  cookieValue: string | null;
}

/**
 * Answer one reserved route.
 *
 * Routes that need a session admit it here rather than in `handle.ts`, so the
 * contract's order (reserved routes at 6, session at 7, release at 8) is what
 * the code actually does.
 */
export async function handleReserved(
  req: NextRequest,
  route: ReservedRoute,
  ctx: ReservedContext
): Promise<Response> {
  switch (route.id) {
    case "auth.signin":
      return signIn(req, ctx.app);
    case "auth.callback":
      return authCallback(req, ctx.app);
    case "auth.signout":
      return signOut(req, ctx.host, ctx.cookieValue);
    default:
      break;
  }

  const { session, grant } = await admitSession(ctx.app, ctx.cookieValue);
  const { release, digest } = await resolveActiveRelease(ctx.app);
  const admitted: AdmittedRequest = { host: ctx.host, app: ctx.app, session, grant, release, digest };
  await noteAppOpened(ctx.app, session, release.id);

  switch (route.id) {
    case "session":
      return sessionInfo(req, admitted);
    case "health":
      return health(req, admitted);
    case "data.requests":
      return handleBroker(req, route, admitted);
    default:
      throw unknownReservedRoute();
  }
}
