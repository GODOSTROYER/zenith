/**
 * Crossing the origin boundary: the 60-second exchange code, the opaque app
 * session behind it, and the cookie that carries it.
 *
 * The shape R3-09 fixes. A browser signed in on the control origin never sends
 * a platform cookie to an app host, so the control origin mints a single-use
 * code bound to (app, subject, browser state) and the app host trades it for
 * its own `__Host-zenith_app` cookie. Neither value is stored: the authority
 * keeps SHA-256 of each, so a leaked database cannot be replayed as somebody's
 * session.
 *
 * Three properties worth stating plainly, because each is a hole if it slips:
 *
 *  - **Redemption is atomic and consumes on failure.** `exchanges.consume` is
 *    one conditional UPDATE, so two tabs racing the same code produce one
 *    session. A code presented with the wrong app or the wrong state is
 *    refused *and stays consumed* — replaying it against the right app must not
 *    be possible, so the mismatch is returned out of the transaction rather
 *    than thrown inside it.
 *  - **`resolveAppSession` re-reads everything, every time.** Session, grant
 *    and app state are three live reads with no cache anywhere. A revoke or a
 *    sign-out has to stop the very next request, and a cached admission is how
 *    that quietly becomes "the next request after the cache expires".
 *  - **The cookie is `__Host-`.** No `Domain` attribute, ever: `__Host-` is the
 *    prefix a browser enforces as host-only, which is what keeps one app's
 *    session off every other app host under the same registrable domain.
 *
 * ponytail: nothing here sweeps expired exchange and session rows. Neither is
 * an admission question — an expired row is already refused, by `expires_at`
 * rather than by its absence — so this is disk, not correctness, and the
 * repositories already carry `purgeExpired` for whoever owns housekeeping.
 * Worth wiring to the ops ticker once an install has been running long enough
 * for the row count to be interesting.
 *
 * Workstream W5 (hosted R3).
 */
import {
  APP_SESSION_COOKIE,
  APP_SESSION_TTL_MS,
  EXCHANGE_TTL_MS,
  HostedError,
  type AppGrant,
  type AppSession,
  type Subject,
} from "@/lib/hosted/contracts";
import { authority } from "@/lib/hosted/authority";
import { appOrigin } from "@/lib/hosted/config";
import {
  accessDenied,
  appendAccessEvent,
  isoIn,
  nowIso,
  requireApp,
  requireAppActive,
  secretValue,
  sha256Hex,
  subjectHash,
} from "./internal";

/* -------------------------------- exchanges ------------------------------- */

/** Lower and upper bound on the opaque browser state an exchange round-trips. */
export const EXCHANGE_STATE_MIN = 8;
export const EXCHANGE_STATE_MAX = 128;

/**
 * The charset the browser state is allowed to use: base64url and the shapes a
 * UUID or a random hex string take. Narrow on purpose — the value is echoed
 * into a redirect URL, and a state that needed escaping would be a state that
 * one day was not escaped.
 */
const STATE_RE = /^[A-Za-z0-9._~-]+$/;

/** Where the browser is sent to finish the hand-off, with the code and its state. */
export interface ExchangeRedirect {
  redirect: string;
}

/**
 * Mint a single-use code for an active grant and answer with the app-host
 * callback URL.
 *
 * Refuses before it mints: no live grant is `forbidden` (identical to an
 * unknown app, so app ids stay non-enumerable), and a suspended or recovering
 * app is `423` with the reason the operator gave.
 */
export function createExchange(appId: string, subject: Subject, state: string): ExchangeRedirect {
  requireExchangeState(state);
  // Grant first, app second: a stranger asking about an app that does not exist
  // must get the same answer as a stranger asking about one that does.
  const grant = activeGrantOrDeny(appId, subject);
  const app = requireApp(appId);
  requireAppActive(app);

  const code = secretValue();
  const a = authority();
  a.tx(() =>
    a.repos.exchanges.insert({
      codeHash: sha256Hex(code),
      appId,
      subject,
      grantId: grant.id,
      state,
      expiresAt: isoIn(EXCHANGE_TTL_MS),
    })
  );
  const url = new URL("/_zenith/auth/callback", appOrigin(app.slug));
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return { redirect: url.toString() };
}

/** What the app host gets back when a code is redeemed. */
export interface RedeemedExchange {
  /** The opaque cookie value. Put it in `appSessionCookie`; never store it. */
  cookieValue: string;
  session: AppSession;
  grant: AppGrant;
}

/** What the caller must prove about a code it is redeeming. */
export interface RedeemOptions {
  /** The app the callback arrived on. A code minted for another app is refused. */
  appId: string;
  /** The state the browser sent back. It must equal the one the code was minted with. */
  state: string;
}

/** Why a redemption did not produce a session, decided inside the transaction. */
type RedeemDenial = "used_or_expired" | "wrong_app" | "wrong_state" | "revoked";

type RedeemOutcome =
  | { ok: true; value: RedeemedExchange }
  | { ok: false; reason: RedeemDenial }
  | { ok: false; reason: "app"; appId: string };

/**
 * Trade a code for an app session. Single use, enforced by the database.
 *
 * A mismatched app or state is refused **after** the code has been consumed:
 * the transaction commits the consumption and the refusal is raised from the
 * returned outcome, so a code that arrived at the wrong place is spent rather
 * than left to be replayed at the right one.
 */
export function redeemExchange(code: string, opts: RedeemOptions): RedeemedExchange {
  const cookieValue = secretValue();
  const sessionId = sha256Hex(cookieValue);
  const a = authority();

  const outcome = a.tx((db): RedeemOutcome => {
    const at = nowIso();
    const exchange = a.repos.exchanges.consume(sha256Hex(code), at);
    if (!exchange) return { ok: false, reason: "used_or_expired" };
    if (exchange.appId !== opts.appId) return { ok: false, reason: "wrong_app" };
    // Constant work, not a constant-time compare: both values are already
    // known to whoever holds the code, so there is nothing to time-attack.
    if (exchange.state !== opts.state) return { ok: false, reason: "wrong_state" };

    const grant = a.repos.grants.get(exchange.grantId);
    if (!grant || grant.state !== "active") return { ok: false, reason: "revoked" };

    const app = a.repos.apps.get(exchange.appId);
    if (!app || app.state !== "active") return { ok: false, reason: "app", appId: exchange.appId };

    const session = a.repos.sessions.insert({
      id: sessionId,
      appId: exchange.appId,
      subject: exchange.subject,
      grantId: grant.id,
      expiresAt: isoIn(APP_SESSION_TTL_MS),
      createdAt: at,
    });
    // The exchange records which session it produced. It cannot be set by
    // `consume`: `session_id` references `app_sessions(id)` and foreign keys are
    // immediate, so the session has to exist first.
    db.prepare("UPDATE app_exchanges SET session_id = ? WHERE code_hash = ?").run(
      session.id,
      exchange.codeHash
    );
    appendAccessEvent({
      event: "app.opened",
      workspaceId: app.workspaceId,
      appId: app.id,
      subject: session.subject,
      logicalId: session.id,
      props: { role: grant.role },
    });
    return { ok: true, value: { cookieValue, session, grant } };
  });

  if (outcome.ok) return outcome.value;
  if (outcome.reason === "app") {
    const app = authority().repos.apps.get(outcome.appId);
    if (app) requireAppActive(app);
    throw new HostedError("not_found", "That app does not exist.", {
      fix: "Check the link, or pick the app from your workspace's app list.",
    });
  }
  if (outcome.reason === "revoked") throw accessDenied("viewer");
  if (outcome.reason === "used_or_expired")
    throw new HostedError(
      "sign_in_required",
      "This sign-in link was already used or expired; open the app from Zenith again.",
      { fix: "Go back to Zenith, open the app from your app list, and you will be signed in." }
    );
  // Wrong app or wrong state: one message, because which one it was tells the
  // holder of a stolen code where the code *would* have worked.
  throw new HostedError("forbidden", "This sign-in link does not belong to this app.", {
    fix: "Open the app from Zenith rather than reusing a link — each one is minted for one app and one browser.",
  });
}

/* -------------------------------- sessions -------------------------------- */

/** Why a cookie did not resolve to a live session. */
export type AppSessionDenial =
  | "missing"
  | "expired"
  | "terminated"
  | "wrong_app"
  | "revoked"
  | "app_unavailable";

/** The live session and grant, or the reason there is none. */
export type ResolvedAppSession =
  | { ok: true; session: AppSession; grant: AppGrant }
  | { ok: false; reason: AppSessionDenial };

/**
 * Resolve a cookie against this app, with the reason when it does not.
 *
 * Every read is live and nothing is memoised. The gateway maps the reason to
 * its own status; this never decides one, and never answers "ok" on a value it
 * could not check.
 */
export function resolveAppSessionDetailed(cookieValue: string, appId: string): ResolvedAppSession {
  if (!cookieValue || !cookieValue.trim()) return { ok: false, reason: "missing" };
  const a = authority();
  const session = a.repos.sessions.get(sha256Hex(cookieValue));
  if (!session) return { ok: false, reason: "missing" };
  if (session.appId !== appId) return { ok: false, reason: "wrong_app" };
  if (session.terminatedAt) return { ok: false, reason: "terminated" };
  // Fixed-width ISO strings: lexicographic comparison is chronological, and the
  // expiry instant itself counts as expired.
  if (session.expiresAt <= nowIso()) return { ok: false, reason: "expired" };

  const grant = a.repos.grants.get(session.grantId);
  if (!grant || grant.state !== "active") return { ok: false, reason: "revoked" };

  const app = a.repos.apps.get(session.appId);
  if (!app || app.state !== "active") return { ok: false, reason: "app_unavailable" };

  return { ok: true, session, grant };
}

/** Live session + live grant for a cookie value on this app, or null. Never cached. */
export function resolveAppSession(
  cookieValue: string,
  appId: string
): { session: AppSession; grant: AppGrant } | null {
  const resolved = resolveAppSessionDetailed(cookieValue, appId);
  return resolved.ok ? { session: resolved.session, grant: resolved.grant } : null;
}

/** End one session by its cookie value. False when there was no live session to end. */
export function terminateAppSession(
  cookieValue: string,
  reason: NonNullable<AppSession["terminatedReason"]>
): boolean {
  if (!cookieValue || !cookieValue.trim()) return false;
  const id = sha256Hex(cookieValue);
  const a = authority();
  return a.tx(() => {
    const session = a.repos.sessions.get(id);
    if (!session || session.terminatedAt) return false;
    if (!a.repos.sessions.terminate(id, reason)) return false;
    const app = a.repos.apps.get(session.appId);
    if (app)
      appendAccessEvent({
        event: "session.terminated",
        workspaceId: app.workspaceId,
        appId: app.id,
        subject: session.subject,
        logicalId: session.id,
        props: { reason, scope: "session" },
      });
    return true;
  });
}

/**
 * End every live app session this person holds, on every app, and answer with
 * how many ended.
 *
 * This is the call platform sign-out makes **before** it responds (R3-10): the
 * platform session going away has to take the app sessions with it, or a signed
 * -out browser keeps its app tabs.
 */
export function terminateAppSessionsForSubject(
  subject: Subject,
  reason: NonNullable<AppSession["terminatedReason"]>
): number {
  const a = authority();
  return a.tx((db) => {
    // Which workspaces are affected has to be read before the update, because
    // afterwards there are no live rows left to read it from.
    const rows = db
      .prepare("SELECT DISTINCT app_id FROM app_sessions WHERE subject = ? AND terminated_at IS NULL")
      .all(subject);
    const workspaces = new Set<string>();
    for (const row of rows) {
      const appId = typeof row.app_id === "string" ? row.app_id : undefined;
      const app = appId ? a.repos.apps.get(appId) : null;
      if (app) workspaces.add(app.workspaceId);
    }

    const at = nowIso();
    const ended = a.repos.sessions.terminateBySubject(subject, reason, at);
    if (ended === 0) return 0;

    // One event per affected workspace, because `workspace_id` is NOT NULL and
    // a person's sessions can span two. The logical id is `<subject>:<at>` with
    // the subject **hashed**: `hosted_events` holds no subject id or email in
    // any column, and a logical id built from the raw subject would put one
    // there — see the note in `authority/repos/events.ts`. Hashing changes
    // nothing about dedupe, which is all this id is for.
    const who = subjectHash(subject);
    const list = [...workspaces];
    for (const workspaceId of list)
      appendAccessEvent({
        event: "session.terminated",
        workspaceId,
        subject,
        logicalId: list.length === 1 ? `${who}:${at}` : `${who}:${at}:${workspaceId}`,
        props: { reason, scope: "subject", ended },
      });
    return ended;
  });
}

/** End every live session on one app — suspension, recovery, an operator. */
export function terminateAppSessionsForApp(
  appId: string,
  reason: NonNullable<AppSession["terminatedReason"]>
): number {
  const a = authority();
  return a.tx(() => {
    const at = nowIso();
    const ended = a.repos.sessions.terminateByApp(appId, reason, at);
    if (ended === 0) return 0;
    const app = a.repos.apps.get(appId);
    if (app)
      appendAccessEvent({
        event: "session.terminated",
        workspaceId: app.workspaceId,
        appId: app.id,
        logicalId: `${appId}:${at}`,
        props: { reason, scope: "app", ended },
      });
    return ended;
  });
}

/* --------------------------------- cookie --------------------------------- */

/** The characters a cookie value may hold here. base64url satisfies it by construction. */
const COOKIE_VALUE_RE = /^[A-Za-z0-9._~-]+$/;

/**
 * The `Set-Cookie` value for an app session.
 *
 * `__Host-` is not decoration: the prefix is refused by the browser unless the
 * cookie is Secure, `Path=/` and — the part that matters here — carries **no**
 * `Domain`. That makes it host-only, so `alpha.apps.example.com` cannot receive
 * or set `beta.apps.example.com`'s session. `SameSite=Lax` lets the top-level
 * redirect out of the control origin arrive with the cookie already set.
 */
export function appSessionCookie(value: string, expiresAt: string): string {
  if (!COOKIE_VALUE_RE.test(value))
    throw new HostedError("internal", "An app session cookie value contained characters it cannot carry.", {
      fix: "App session values come from `secretValue()` (base64url). Nothing else may be put in this cookie.",
    });
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime()))
    throw new HostedError("internal", `"${expiresAt}" is not a timestamp an app session can expire at.`, {
      fix: "Pass the session's `expiresAt` from the authority, which is always ISO-8601 UTC.",
    });
  return `${APP_SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}`;
}

/** The `Set-Cookie` value that removes the app session cookie. Same name, no `Domain`. */
export function clearAppSessionCookie(): string {
  return `${APP_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/* -------------------------------- internals ------------------------------- */

function requireExchangeState(state: string): void {
  const bad = (why: string): never => {
    throw new HostedError("invalid_input", `The browser state for this launch ${why}.`, {
      fix: `Send a random value of ${EXCHANGE_STATE_MIN}–${EXCHANGE_STATE_MAX} characters using letters, digits and any of . _ ~ - (a UUID works).`,
    });
  };
  if (typeof state !== "string" || state.length < EXCHANGE_STATE_MIN)
    return void bad(`is shorter than ${EXCHANGE_STATE_MIN} characters`);
  if (state.length > EXCHANGE_STATE_MAX)
    return void bad(`is longer than ${EXCHANGE_STATE_MAX} characters`);
  if (!STATE_RE.test(state)) return void bad("contains characters that cannot travel in a URL unescaped");
}

/** The live grant, or the one shared denial. Used where "no grant" must not differ from "no app". */
function activeGrantOrDeny(appId: string, subject: Subject): AppGrant {
  const grant = authority().repos.grants.activeFor(appId, subject);
  if (!grant) throw accessDenied("viewer");
  return grant;
}
