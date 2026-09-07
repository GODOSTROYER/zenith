/**
 * The origin hand-off: minting a code, spending it exactly once, and what the
 * session it produces stops being able to do.
 *
 * The redemption tests are all one question asked from different angles — what
 * happens to a code that arrives somewhere it should not. The answer this file
 * pins is that it is spent either way: a code presented with the wrong app or
 * the wrong browser state is refused *and* consumed, so it cannot then be
 * replayed at the place it would have worked.
 *
 * The session tests are the other half of R3-10: a live session has to stop
 * being live the moment the grant behind it, the app in front of it, or the
 * person's platform session goes away — with no cache in between.
 *
 * Workstream W5 (hosted R3).
 */
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir, type TestIdentity } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-access-sessions-");
process.env.ORRERY_SECRET_KEY = "3".repeat(64);

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { APP_SESSION_COOKIE, APP_SESSION_TTL_MS, EXCHANGE_TTL_MS, HostedError } = await import(
  "@/lib/hosted/contracts"
);
const { appOrigin } = await import("@/lib/hosted/config");
const {
  appSessionCookie,
  clearAppSessionCookie,
  createExchange,
  redeemExchange,
  resolveAppSession,
  resolveAppSessionDetailed,
  revokeGrant,
  terminateAppSession,
  terminateAppSessionsForApp,
  terminateAppSessionsForSubject,
} = await import("@/lib/hosted/access");
const { IDENTITIES, seedApp, seedGrant, sha256Hex, uuid } = await import("./_helpers");

const a = openAuthority();

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

const refusal = (fn: () => unknown): { code: string; message: string } => {
  try {
    fn();
  } catch (err) {
    if (err instanceof HostedError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected a refusal, and the call returned");
};

const STATE = "state-abcdef0123456789";

const app = (slug: string) => {
  const record = seedApp(a, { slug, name: `App ${slug}` });
  seedGrant(a, record.id, IDENTITIES.owner, "owner");
  return record;
};

/** Mint a code and hand back the parts a callback would carry. */
const launch = (appId: string, who: TestIdentity = IDENTITIES.viewer, state = STATE) => {
  const { redirect } = createExchange(appId, who.subject, state);
  const url = new URL(redirect);
  return { redirect, url, code: url.searchParams.get("code") as string, state };
};

const expire = (code: string): void => {
  a.db
    .prepare("UPDATE app_exchanges SET expires_at = ? WHERE code_hash = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), sha256Hex(code));
};

const setState = (appId: string, state: "active" | "suspended" | "recovering"): void => {
  a.tx(() => a.repos.apps.update(appId, { state, stateReason: "for this test" }));
};

describe("minting an exchange code", () => {
  it("points at the app's own callback, carries the state, and expires in a minute", () => {
    const target = app("exchange-mint");
    seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    const { url, code } = launch(target.id);

    expect(url.origin).toBe(appOrigin(target.slug));
    expect(url.pathname).toBe("/_zenith/auth/callback");
    expect(url.searchParams.get("state")).toBe(STATE);

    const stored = a.repos.exchanges.get(sha256Hex(code));
    expect(stored).toMatchObject({ appId: target.id, subject: IDENTITIES.viewer.subject, state: STATE });
    // The code itself is nowhere in the row.
    const row = a.db.prepare("SELECT * FROM app_exchanges WHERE code_hash = ?").get(sha256Hex(code));
    expect(JSON.stringify(row)).not.toContain(code);
    const ttl = Date.parse(stored!.expiresAt) - Date.parse(stored!.createdAt);
    expect(ttl).toBeLessThanOrEqual(EXCHANGE_TTL_MS);
    expect(ttl).toBeGreaterThan(EXCHANGE_TTL_MS - 5_000);
  });

  it("refuses a stranger and an unknown app with the same sentence, and mints nothing", () => {
    const target = app("exchange-stranger");
    const stranger = refusal(() => createExchange(target.id, IDENTITIES.stranger.subject, STATE));
    const missing = refusal(() => createExchange(`app-${uuid()}`, IDENTITIES.stranger.subject, STATE));
    expect(stranger.code).toBe("forbidden");
    expect(stranger).toEqual(missing);
  });

  it("refuses a suspended app with 423 and says why", () => {
    const target = app("exchange-suspended");
    seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    setState(target.id, "suspended");
    expect(refusal(() => createExchange(target.id, IDENTITIES.viewer.subject, STATE)).code).toBe("suspended");
    setState(target.id, "recovering");
    expect(refusal(() => createExchange(target.id, IDENTITIES.viewer.subject, STATE)).code).toBe("recovering");
  });

  it("refuses a browser state that is too short, too long or not URL-safe", () => {
    const target = app("exchange-state");
    seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    for (const bad of ["short", "x".repeat(129), "has spaces and #"])
      expect(refusal(() => createExchange(target.id, IDENTITIES.viewer.subject, bad)).code).toBe(
        "invalid_input"
      );
  });
});

describe("redeeming an exchange code", () => {
  it("produces one session, and refuses the second attempt", () => {
    const target = app("redeem-once");
    const grant = seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    const { code } = launch(target.id);

    const redeemed = redeemExchange(code, { appId: target.id, state: STATE });
    expect(redeemed.grant.id).toBe(grant.id);
    expect(redeemed.session).toMatchObject({ appId: target.id, subject: IDENTITIES.viewer.subject });
    expect(redeemed.session.id).toBe(sha256Hex(redeemed.cookieValue));

    const ttl = Date.parse(redeemed.session.expiresAt) - Date.parse(redeemed.session.createdAt);
    expect(ttl).toBeLessThanOrEqual(APP_SESSION_TTL_MS);
    expect(ttl).toBeGreaterThan(APP_SESSION_TTL_MS - 5_000);
    // The exchange now names the session it produced.
    expect(a.repos.exchanges.get(sha256Hex(code))?.sessionId).toBe(redeemed.session.id);
    expect(a.repos.events.count({ event: "app.opened", appId: target.id })).toBe(1);

    expect(refusal(() => redeemExchange(code, { appId: target.id, state: STATE })).code).toBe(
      "sign_in_required"
    );
  });

  it("spends a code that arrives at the wrong app or with the wrong state", () => {
    const alpha = app("redeem-alpha");
    const beta = app("redeem-beta");
    seedGrant(a, alpha.id, IDENTITIES.viewer, "viewer");

    const wrongApp = launch(alpha.id);
    expect(refusal(() => redeemExchange(wrongApp.code, { appId: beta.id, state: STATE })).code).toBe(
      "forbidden"
    );
    expect(a.repos.exchanges.get(sha256Hex(wrongApp.code))?.consumedAt).toBeTruthy();
    // Spent means spent: retrying at the app it was minted for gets nothing.
    expect(refusal(() => redeemExchange(wrongApp.code, { appId: alpha.id, state: STATE })).code).toBe(
      "sign_in_required"
    );

    const wrongState = launch(alpha.id);
    expect(
      refusal(() => redeemExchange(wrongState.code, { appId: alpha.id, state: "state-999999999999" })).code
    ).toBe("forbidden");
    expect(a.repos.exchanges.get(sha256Hex(wrongState.code))?.consumedAt).toBeTruthy();
    expect(a.repos.sessions.listByApp(alpha.id)).toHaveLength(0);
  });

  it("refuses an expired code, and an unknown one, with the same sentence", () => {
    const target = app("redeem-expired");
    seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    const { code } = launch(target.id);
    expire(code);

    const expired = refusal(() => redeemExchange(code, { appId: target.id, state: STATE }));
    const unknown = refusal(() =>
      redeemExchange(`never-issued-${uuid()}`, { appId: target.id, state: STATE })
    );
    expect(expired.code).toBe("sign_in_required");
    expect(expired).toEqual(unknown);
  });

  it("refuses when the grant was revoked between minting and redeeming", () => {
    const target = app("redeem-revoked");
    const grant = seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    const { code } = launch(target.id);
    revokeGrant(grant.id, IDENTITIES.owner.subject, "left the project");

    expect(refusal(() => redeemExchange(code, { appId: target.id, state: STATE })).code).toBe("forbidden");
    expect(a.repos.sessions.listByApp(target.id, { liveOnly: true })).toHaveLength(0);
  });

  it("refuses when the app was suspended between minting and redeeming", () => {
    const target = app("redeem-suspended");
    seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    const { code } = launch(target.id);
    setState(target.id, "suspended");

    expect(refusal(() => redeemExchange(code, { appId: target.id, state: STATE })).code).toBe("suspended");
  });
});

describe("resolving a session", () => {
  const open = (slug: string, who: TestIdentity = IDENTITIES.viewer) => {
    const target = app(slug);
    const grant = seedGrant(a, target.id, who, "viewer");
    const { code } = launch(target.id, who);
    return { target, grant, redeemed: redeemExchange(code, { appId: target.id, state: STATE }) };
  };

  it("answers with the live session and grant, and re-reads on every call", () => {
    const { target, grant, redeemed } = open("resolve-ok");
    const resolved = resolveAppSession(redeemed.cookieValue, target.id);
    expect(resolved?.session.id).toBe(redeemed.session.id);
    expect(resolved?.grant.id).toBe(grant.id);
    expect(resolveAppSessionDetailed(redeemed.cookieValue, target.id).ok).toBe(true);
  });

  it("refuses the same cookie on another app", () => {
    const { redeemed } = open("resolve-wrong-app");
    const other = app("resolve-other-app");
    expect(resolveAppSession(redeemed.cookieValue, other.id)).toBeNull();
    expect(resolveAppSessionDetailed(redeemed.cookieValue, other.id)).toEqual({
      ok: false,
      reason: "wrong_app",
    });
  });

  it("stops as soon as the grant is revoked", () => {
    const { target, grant, redeemed } = open("resolve-revoked");
    revokeGrant(grant.id, IDENTITIES.owner.subject, "left the project");
    // Revoking terminated the session in the same transaction, so the first
    // reason a reader meets is that it was terminated.
    expect(resolveAppSession(redeemed.cookieValue, target.id)).toBeNull();
    expect(resolveAppSessionDetailed(redeemed.cookieValue, target.id)).toEqual({
      ok: false,
      reason: "terminated",
    });
    expect(a.repos.sessions.get(redeemed.session.id)?.terminatedReason).toBe("revoked");
  });

  it("stops when the person signs out of the platform, on every app at once", () => {
    // A subject of this test's own, so sessions other tests in this file opened
    // cannot be counted among the two this one is about.
    const who: TestIdentity = {
      subject: `55555555-5555-4555-8555-${uuid().slice(0, 12)}`,
      email: "signs-out@example.test",
      name: "Sam Signout",
    };
    const one = open("resolve-signout-1", who);
    const two = open("resolve-signout-2", who);

    expect(terminateAppSessionsForSubject(who.subject, "signed_out")).toBe(2);
    expect(resolveAppSession(one.redeemed.cookieValue, one.target.id)).toBeNull();
    expect(resolveAppSession(two.redeemed.cookieValue, two.target.id)).toBeNull();
    expect(resolveAppSessionDetailed(one.redeemed.cookieValue, one.target.id)).toEqual({
      ok: false,
      reason: "terminated",
    });
    // Nothing left to end, and no column of the event — the logical id
    // included — carries the subject or the address it belongs to.
    expect(terminateAppSessionsForSubject(who.subject, "signed_out")).toBe(0);
    const events = a.repos.events.listSince({ event: "session.terminated" });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.props?.scope === "subject")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(who.subject);
    expect(JSON.stringify(events)).not.toContain(who.email);
  });

  it("stops at the expiry instant, and when the app itself goes away", () => {
    const { target, redeemed } = open("resolve-expiry");
    a.db
      .prepare("UPDATE app_sessions SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1).toISOString(), redeemed.session.id);
    expect(resolveAppSessionDetailed(redeemed.cookieValue, target.id)).toEqual({
      ok: false,
      reason: "expired",
    });

    const other = open("resolve-app-gone");
    setState(other.target.id, "suspended");
    expect(resolveAppSessionDetailed(other.redeemed.cookieValue, other.target.id)).toEqual({
      ok: false,
      reason: "app_unavailable",
    });
  });

  it("answers `missing` for an empty or unknown cookie, never a throw", () => {
    const { target } = open("resolve-missing");
    expect(resolveAppSessionDetailed("", target.id)).toEqual({ ok: false, reason: "missing" });
    expect(resolveAppSessionDetailed(`unknown-${uuid()}`, target.id)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("ends one session by its cookie, and every session on an app", () => {
    const { target, redeemed } = open("terminate-one");
    expect(terminateAppSession(redeemed.cookieValue, "signed_out")).toBe(true);
    expect(terminateAppSession(redeemed.cookieValue, "signed_out")).toBe(false);
    expect(a.repos.sessions.get(redeemed.session.id)?.terminatedReason).toBe("signed_out");

    const bulk = open("terminate-app");
    expect(terminateAppSessionsForApp(bulk.target.id, "operator")).toBe(1);
    expect(terminateAppSessionsForApp(bulk.target.id, "operator")).toBe(0);
    expect(resolveAppSession(bulk.redeemed.cookieValue, bulk.target.id)).toBeNull();
    expect(target.id).not.toBe(bulk.target.id);
  });
});

describe("the cookie", () => {
  it("is host-only, secure, http-only and lax — and never carries a Domain", () => {
    const expiresAt = "2026-01-02T03:04:05.000Z";
    const header = appSessionCookie("Abc-123_xyz", expiresAt);

    expect(header).toBe(
      `__Host-zenith_app=Abc-123_xyz; Path=/; Secure; HttpOnly; SameSite=Lax; Expires=${new Date(
        expiresAt
      ).toUTCString()}`
    );
    expect(header.startsWith(`${APP_SESSION_COOKIE}=`)).toBe(true);
    expect(header.toLowerCase()).not.toContain("domain");
    for (const attribute of ["; Path=/", "; Secure", "; HttpOnly", "; SameSite=Lax"])
      expect(header).toContain(attribute);
  });

  it("clears itself under the same name, with no Domain and no value", () => {
    const header = clearAppSessionCookie();
    expect(header).toBe("__Host-zenith_app=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
    expect(header.toLowerCase()).not.toContain("domain");
  });

  it("refuses to put anything but an opaque value in the cookie", () => {
    expect(() => appSessionCookie("bad value; Domain=evil.test", "2026-01-02T03:04:05.000Z")).toThrow(
      HostedError
    );
    expect(() => appSessionCookie("Abc-123", "not-a-date")).toThrow(HostedError);
  });
});
