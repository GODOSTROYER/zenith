/**
 * Admission: everything that has to be true before a byte of app code or a
 * row of app data is touched.
 *
 * The order is the contract (docs/hosted/CONTRACTS-R3.md, "App host surface"):
 *
 *   1 host → 2 app → 3 state → 4 quota → 5 authority → 6 reserved routes →
 *   7 session → 8 release → (then, and only then, artifact or broker)
 *
 * Each step throws a `HostedError`; nothing returns "maybe". This module is
 * deliberately runtime-agnostic and free of `Response` objects, because the
 * same decisions are made twice: once by `handle.ts` for the local runtime,
 * and once by `/api/hosted/policy/admit` for an edge worker that has no access
 * to the authority at all.
 */
import { authority, utcDay } from "@/lib/hosted/authority";
import { hostedConfig, slugFromHost } from "@/lib/hosted/config";
import {
  APP_SESSION_COOKIE,
  HostedError,
  type AppGrant,
  type AppSession,
  type HostedApp,
  type Release,
} from "@/lib/hosted/contracts";
import { brokerScriptName, releaseScriptName } from "@/lib/hosted/runtime/names";
import { gatewayDeps } from "./deps";
import { RefusalWithHeaders, secondsToNextUtcMidnight, unknownHost } from "./errors";

/* --------------------------------- paths ---------------------------------- */

/** The reserved routes the platform serves itself. App code never sees these. */
export type ReservedRouteId =
  | "auth.callback"
  | "auth.signin"
  | "auth.signout"
  | "session"
  | "health"
  | "data.requests";

export interface ReservedRoute {
  id: ReservedRouteId;
  /** Present for `/_zenith/data/v1/requests/:id`. */
  recordId?: string;
}

/** The prefix nothing an app publishes may occupy. */
export const RESERVED_PREFIX = "_zenith";

/**
 * The request path, normalised, or null when it is one the gateway refuses to
 * interpret at all.
 *
 * Refused: any `..` segment, a backslash, a NUL, an empty segment (a `//` in
 * the original path) and a `.` segment. Next has already percent-decoded each
 * segment, so `%2e%2e` arrives here as `..` and is caught by the same rule.
 * The result never starts with `/` and is `""` for the site root.
 */
export function normalizeAppPath(segments: readonly string[] | undefined): string | null {
  if (segments === undefined || segments.length === 0) return "";
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
    if (segment.includes("\\") || segment.includes("/") || segment.includes("\u0000")) return null;
    out.push(segment);
  }
  return out.join("/");
}

/** Which reserved route a normalised path names, or null when it names none. */
export function reservedRouteOf(path: string): ReservedRoute | null {
  const parts = path.split("/");
  if (parts[0] !== RESERVED_PREFIX) return null;
  const rest = parts.slice(1);
  const at = (i: number): string => rest[i] ?? "";
  if (rest.length === 2 && at(0) === "auth" && at(1) === "callback") return { id: "auth.callback" };
  if (rest.length === 2 && at(0) === "auth" && at(1) === "signin") return { id: "auth.signin" };
  if (rest.length === 2 && at(0) === "auth" && at(1) === "signout") return { id: "auth.signout" };
  if (rest.length === 1 && at(0) === "session") return { id: "session" };
  if (rest.length === 1 && at(0) === "health") return { id: "health" };
  if (at(0) === "data" && at(1) === "v1" && at(2) === "requests") {
    if (rest.length === 3) return { id: "data.requests" };
    if (rest.length === 4) return { id: "data.requests", recordId: at(3) };
  }
  return null;
}

/** True when this path is under the reserved prefix, matched or not. */
export const isReservedPath = (path: string): boolean =>
  path === RESERVED_PREFIX || path.startsWith(`${RESERVED_PREFIX}/`);

/** The refusal an unmatched `/_zenith/…` path gets. Never falls through to app code. */
export const unknownReservedRoute = (): HostedError =>
  new HostedError("not_found", "That is not one of this host's reserved paths.", {
    fix: "Paths under /_zenith/ are served by Zenith, not by the app. The app's own routes live outside that prefix.",
  });

/** The refusal a path the gateway will not interpret gets. Says what is wrong, not where. */
export const refusedPath = (): HostedError =>
  new HostedError("not_found", "That is not an address this app can serve.", {
    fix: "Follow the app's own links. A path containing `..`, a backslash or an empty segment is never served, whoever asks.",
  });

/* ------------------------------- authority -------------------------------- */

/**
 * Run one admission read against the control authority, converting anything it
 * cannot answer into `policy_unavailable`.
 *
 * This is the fail-closed rule in one function: a closed database, a corrupt
 * file or a sibling module that has not landed all end in 503, never in a
 * request that is admitted because the check could not run.
 */
export function authorityStep<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    // A refusal the policy itself decided (quota, forbidden, sign-in) is the
    // answer, not a failure to get one.
    if (err instanceof HostedError && err.code !== "internal") throw err;
    throw new HostedError(
      "policy_unavailable",
      `This app cannot be served right now: the control authority did not answer while ${what}.`,
      {
        fix: "Try again shortly. If it keeps happening the control service needs its data directory checked — the app's data and grants are untouched.",
      }
    );
  }
}

/* --------------------------------- steps ---------------------------------- */

/** Step 1: the Host header names an app host, and the route agrees with it. */
export function resolveHost(hostHeader: string | null, expected?: string): { host: string; slug: string } {
  const host = (hostHeader ?? "").trim();
  if (!host) throw unknownHost();
  if (expected !== undefined) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(expected);
    } catch {
      throw unknownHost();
    }
    if (decoded.trim().toLowerCase() !== host.toLowerCase()) throw unknownHost();
  }
  const slug = slugFromHost(host, hostedConfig().ZENITH_APP_DOMAIN);
  if (!slug) throw unknownHost();
  return { host: host.toLowerCase(), slug };
}

/** Step 2: a live app owns that slug. Deleted apps are indistinguishable from absent ones. */
export function loadApp(slug: string): HostedApp {
  const app = authorityStep("looking up the app", () => authority().repos.apps.getBySlug(slug));
  if (!app || app.state === "deleted") throw unknownHost();
  return app;
}

/** Step 3: the app is not paused. `GET /_zenith/auth/signin` still renders while suspended. */
export function assertAppState(app: HostedApp, opts: { method: string; reserved: ReservedRoute | null }): void {
  const signinPage = opts.method === "GET" && opts.reserved?.id === "auth.signin";
  if (app.state === "suspended") {
    if (signinPage) return;
    throw new HostedError(
      "suspended",
      app.stateReason
        ? `This app is paused: ${app.stateReason}`
        : "This app is paused, so it is not answering requests right now.",
      {
        fix: "An owner can resume it from its Zenith page. Nothing was deleted — the app's data, grants and releases are all still here.",
      }
    );
  }
  if (app.state === "recovering")
    throw new HostedError("recovering", "This app is coming back up after a restore and is not answering yet.", {
      fix: "Wait for the restore to finish. Access that was revoked before the restore stays revoked; an owner may have to re-approve some people.",
    });
}

/**
 * Step 4: count this request against the app's UTC day and refuse over the cap.
 *
 * PLAN-R3 R3-12: every request that reached a known app host counts, whatever
 * its outcome — a 403 costs the app a request just as a 200 does, because the
 * work of deciding it is what the counter measures.
 */
export function countRequest(app: HostedApp, now: Date = new Date()): void {
  const verdict = authorityStep("counting the request against today's quota", () =>
    gatewayDeps().admitRequest(app.id, { now })
  );
  if (verdict.allowed) return;
  throw new RefusalWithHeaders(
    new HostedError(
      "quota_exceeded",
      `This app has used all ${verdict.limit} of the requests it may serve today.`,
      {
        fix: "The count resets at 00:00 UTC. Ask Zenith to raise this app's daily request limit if it needs more.",
        details: { limit: verdict.limit, requests: verdict.counter.requests, day: verdict.counter.day },
      }
    ),
    { "retry-after": String(secondsToNextUtcMidnight(now)) }
  );
}

/** The opaque app-session cookie on this request, or null. Platform cookies are never read. */
export function appSessionCookieValue(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== APP_SESSION_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/** The refusal an unadmitted request gets. Identical for "no cookie" and "wrong app". */
export const signInRequired = (): HostedError =>
  new HostedError("sign_in_required", "You are not signed in to this app.", {
    fix: "Open the app from your Zenith apps page; that link signs you in on this address.",
  });

/**
 * Step 7: a live session for **this** app, held by a live grant.
 *
 * A cookie minted for another app resolves to null here rather than to a 403.
 * That is deliberate: telling a caller "that is a valid session, just not for
 * this app" confirms the other app exists and that the holder has access to
 * it. The two cases are not distinguishable from outside, by design.
 */
export function admitSession(app: HostedApp, cookieValue: string | null): { session: AppSession; grant: AppGrant } {
  if (!cookieValue) throw signInRequired();
  const resolved = authorityStep("checking your session", () =>
    gatewayDeps().resolveAppSession(cookieValue, app.id)
  );
  if (!resolved) throw signInRequired();
  return resolved;
}

/** Step 8: the app's durable active-release pointer, and the artifact it names. */
export function resolveActiveRelease(app: HostedApp): { release: Release; digest: string } {
  const release = authorityStep("looking up the active release", () =>
    app.activeReleaseId ? authority().repos.releases.get(app.activeReleaseId) : null
  );
  if (!release || release.status !== "active" || release.appId !== app.id)
    throw new HostedError("not_found", "This app has no published version yet, so there is nothing to serve.", {
      fix: "Publish a release first: open the app in Zenith and publish its source.",
    });
  return { release, digest: release.artifactDigest };
}

/* --------------------------------- events --------------------------------- */

/**
 * Record that a recipient opened this app today. Deduplicated on
 * `<session>:<utc-day>`, so a single-page app that makes forty requests in an
 * afternoon is one opening, not forty.
 *
 * Never throws: an analytics row is not worth failing a request over.
 */
export function noteAppOpened(app: HostedApp, session: AppSession, releaseId?: string): void {
  try {
    gatewayDeps().recordEvent({
      event: "app.opened",
      workspaceId: app.workspaceId,
      appId: app.id,
      subject: session.subject,
      releaseId,
      outcome: "ok",
      logicalId: `${session.id}:${utcDay()}`,
    });
  } catch {
    /* events are observation, never admission */
  }
}

/** Record a denial for the activation scorecard. Never throws. */
export function noteAccessDenied(
  app: HostedApp,
  code: string,
  opts: { subject?: string; releaseId?: string; path?: string } = {}
): void {
  try {
    gatewayDeps().recordEvent({
      event: "access.denied",
      workspaceId: app.workspaceId,
      appId: app.id,
      subject: opts.subject,
      releaseId: opts.releaseId,
      outcome: "denied",
      props: { code },
    });
  } catch {
    /* events are observation, never admission */
  }
}

/* ----------------------------- shared decision ---------------------------- */

/** What an edge worker asks the control service about one request. */
export interface AdmissionInput {
  host: string;
  method: string;
  /** Request path with its leading slash, query already removed by the caller. */
  path: string;
  cookie?: string;
  origin?: string;
  now?: Date;
}

/** What the control service answers. `deny` never carries a release or a session. */
export interface AdmissionDecision {
  decision: "serve" | "deny";
  status: number;
  code?: string;
  /** Present only on `serve`, and only when a release is what would be served. */
  release?: { id: string; digest: string; number: number; script: string };
  session?: { subject: string; email: string; role: string };
  /**
   * Set when the path is one Zenith serves itself. The caller must not dispatch
   * app code for it — `data.requests` goes to the app's broker, everything else
   * is answered by the control service.
   */
  reserved?: ReservedRouteId;
  retryAfter?: number;
}

/** The refusal a cross-site mutation gets, wherever the check runs. */
export const csrfRejected = (): HostedError =>
  new HostedError("csrf_rejected", "This change did not come from this app, so it was refused.", {
    fix: "Make the change from the app's own page rather than from another site or a saved copy of the form.",
  });

/**
 * Steps 1–8 for a caller that is not the local gateway — the Cloudflare edge
 * worker, through `/api/hosted/policy/admit`.
 *
 * Everything is decided here; the worker only obeys. That is what makes the
 * two runtimes share one admission rather than two implementations that drift.
 */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const now = input.now ?? new Date();
  try {
    const { slug } = resolveHost(input.host);
    const app = loadApp(slug);

    const rawPath = input.path.split("?")[0] ?? "/";
    const normalized = normalizeAppPath(
      rawPath === "/" ? [] : rawPath.replace(/^\/+/, "").split("/")
    );
    const reserved = normalized === null ? null : reservedRouteOf(normalized);

    assertAppState(app, { method: input.method, reserved });
    countRequest(app, now);

    if (normalized === null) throw unknownReservedRoute();
    if (isReservedPath(normalized) && !reserved) throw unknownReservedRoute();

    // The two routes a recipient reaches *before* they have a session.
    if (reserved?.id === "auth.signin" || reserved?.id === "auth.callback")
      return { decision: "serve", status: 200, reserved: reserved.id };

    const { session, grant } = admitSession(app, input.cookie ?? null);

    // A mutation through the broker must carry this app's own Origin. The edge
    // asks us rather than re-deriving the rule, so both runtimes refuse the
    // same requests.
    if (reserved?.id === "data.requests" && (input.method === "POST" || input.method === "PATCH")) {
      const expected = `${hostedConfig().ZENITH_APP_SCHEME}://${input.host.toLowerCase()}`;
      if ((input.origin ?? "").trim().toLowerCase() !== expected) throw csrfRejected();
    }

    const { release, digest } = resolveActiveRelease(app);
    noteAppOpened(app, session, release.id);
    return {
      decision: "serve",
      status: 200,
      release: {
        id: release.id,
        digest,
        number: release.number,
        script:
          reserved?.id === "data.requests"
            ? brokerScriptName(app.slug)
            : releaseScriptName(app.slug, release.number, digest),
      },
      session: { subject: session.subject, email: grant.email, role: grant.role },
      reserved: reserved?.id,
    };
  } catch (err) {
    const carried = err instanceof RefusalWithHeaders ? err.error : err;
    if (carried instanceof HostedError) {
      const retry = err instanceof RefusalWithHeaders ? Number(err.headers["retry-after"]) : NaN;
      return {
        decision: "deny",
        status: carried.status,
        code: carried.code,
        ...(Number.isFinite(retry) ? { retryAfter: retry } : {}),
      };
    }
    return { decision: "deny", status: 503, code: "policy_unavailable" };
  }
}

/* -------------------------- the admitted request -------------------------- */

/**
 * What every reserved route below `session` and every artifact response is
 * built from. Assembling it is the whole job of steps 1–8; nothing downstream
 * re-checks any of it, and nothing downstream may be reached without it.
 */
export interface AdmittedRequest {
  /** The Host header, lowercased, port included. The app's own origin authority. */
  host: string;
  app: HostedApp;
  session: AppSession;
  grant: AppGrant;
  release: Release;
  digest: string;
}
