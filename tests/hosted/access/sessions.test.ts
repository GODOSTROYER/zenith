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
 */
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir, type TestIdentity } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-access-sessions-");
process.env.ZENITH_SECRET_KEY = "3".repeat(64);

const { closeAuthority, openAuthority, sqliteConnection } = await import("@/lib/hosted/authority");
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

afterAll(async () => {
  closeAuthority();
  removeDir(dataDir);
});

const refusal = async (fn: () => unknown): Promise<{ code: string; message: string }> => {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HostedError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected a refusal, and the call returned");
};

const STATE = "state-abcdef0123456789";

const app = async (slug: string) => {
  const record = await seedApp(a, { slug, name: `App ${slug}` });
  await seedGrant(a, record.id, IDENTITIES.owner, "owner");
  return record;
};

/** Mint a code and hand back the parts a callback would carry. */
const launch = async (appId: string, who: TestIdentity = IDENTITIES.viewer, state = STATE) => {
  const { redirect } = await createExchange(appId, who.subject, state);
  const url = new URL(redirect);
  return { redirect, url, code: url.searchParams.get("code") as string, state };
};

const expire = (code: string): void => {
  sqliteConnection(a)
    .prepare("UPDATE app_exchanges SET expires_at = ? WHERE code_hash = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), sha256Hex(code));
};

const setState = async (appId: string, state: "active" | "suspended" | "recovering"): Promise<void> => {
  await a.tx((repos) => repos.apps.update(appId, { state, stateReason: "for this test" }));
};

describe("minting an exchange code", () => {
  it("points at the app's own callback, carries the state, and expires in a minute", async () => {
    const target = await app("exchange-mint");
    await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    const { url, code } = await launch(target.id);

    expect(url.origin).toBe(appOrigin(target.slug));
    expect(url.pathname).toBe("/_zenith/auth/callback");
    expect(url.searchParams.get("state")).toBe(STATE);

    const stored = await a.repos.exchanges.get(sha256Hex(code));
    expect(stored).toMatchObject({ appId: target.id, subject: IDENTITIES.viewer.subject, state: STATE });
    // The code itself is nowhere in the row.
    const row = sqliteConnection(a).prepare("SELECT * FROM app_exchanges WHERE code_hash = ?").get(sha256Hex(code));
    expect(JSON.stringify(row)).not.toContain(code);
    const ttl = Date.parse(stored!.expiresAt) - Date.parse(stored!.createdAt);
    // The exchange stamps its own clock after the test read `now`, so allow a second of skew.
    expect(ttl).toBeLessThanOrEqual(EXCHANGE_TTL_MS + 1_000);
    expect(ttl).toBeGreaterThan(EXCHANGE_TTL_MS - 5_000);
  });

  it("refuses a stranger and an unknown app with the same sentence, and mints nothing", async () => {
    const target = await app("exchange-stranger");
    const stranger = await refusal(() => createExchange(target.id, IDENTITIES.stranger.subject, STATE));
    const missing = await refusal(() => createExchange(`app-${uuid()}`, IDENTITIES.stranger.subject, STATE));
    expect(stranger.code).toBe("forbidden");
    expect(stranger).toEqual(missing);
  });

  it("refuses a suspended app with 423 and says why", async () => {
    const target = await app("exchange-suspended");
    await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    await setState(target.id, "suspended");
    expect((await refusal(() => createExchange(target.id, IDENTITIES.viewer.subject, STATE))).code).toBe("suspended");
    await setState(target.id, "recovering");
    expect((await refusal(() => createExchange(target.id, IDENTITIES.viewer.subject, STATE))).code).toBe("recovering");
  });

  it("refuses a browser state that is too short, too long or not URL-safe", async () => {
    const target = await app("exchange-state");
    await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    for (const bad of ["short", "x".repeat(129), "has spaces and #"])
      expect((await refusal(() => createExchange(target.id, IDENTITIES.viewer.subject, bad))).code).toBe(
        "invalid_input"
      );
  });
});

describe("redeeming an exchange code", () => {
  it("produces one session, and refuses the second attempt", async () => {
    const target = await app("redeem-once");
    const grant = await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    const { code } = await launch(target.id);

    const redeemed = await redeemExchange(code, { appId: target.id, state: STATE });
    expect(redeemed.grant.id).toBe(grant.id);
    expect(redeemed.session).toMatchObject({ appId: target.id, subject: IDENTITIES.viewer.subject });
    expect(redeemed.session.id).toBe(sha256Hex(redeemed.cookieValue));

    const ttl = Date.parse(redeemed.session.expiresAt) - Date.parse(redeemed.session.createdAt);
    // Same skew allowance as the exchange: the session clock reads after `now`.
    expect(ttl).toBeLessThanOrEqual(APP_SESSION_TTL_MS + 1_000);
    expect(ttl).toBeGreaterThan(APP_SESSION_TTL_MS - 5_000);
    // The exchange now names the session it produced.
    expect((await a.repos.exchanges.get(sha256Hex(code)))?.sessionId).toBe(redeemed.session.id);
    expect(await a.repos.events.count({ event: "app.opened", appId: target.id })).toBe(1);

    expect((await refusal(() => redeemExchange(code, { appId: target.id, state: STATE }))).code).toBe(
      "sign_in_required"
    );
  });

  it("spends a code that arrives at the wrong app or with the wrong state", async () => {
    const alpha = await app("redeem-alpha");
    const beta = await app("redeem-beta");
    await seedGrant(a, alpha.id, IDENTITIES.viewer, "viewer");

    const wrongApp = await launch(alpha.id);
    expect((await refusal(() => redeemExchange(wrongApp.code, { appId: beta.id, state: STATE }))).code).toBe(
      "forbidden"
    );
    expect((await a.repos.exchanges.get(sha256Hex(wrongApp.code)))?.consumedAt).toBeTruthy();
    // Spent means spent: retrying at the app it was minted for gets nothing.
    expect((await refusal(() => redeemExchange(wrongApp.code, { appId: alpha.id, state: STATE }))).code).toBe(
      "sign_in_required"
    );

    const wrongState = await launch(alpha.id);
    expect(
      (await refusal(() => redeemExchange(wrongState.code, { appId: alpha.id, state: "state-999999999999" }))).code
    ).toBe("forbidden");
    expect((await a.repos.exchanges.get(sha256Hex(wrongState.code)))?.consumedAt).toBeTruthy();
    expect(await a.repos.sessions.listByApp(alpha.id)).toHaveLength(0);
  });

  it("refuses an expired code, and an unknown one, with the same sentence", async () => {
    const target = await app("redeem-expired");
    await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    const { code } = await launch(target.id);
    expire(code);

    const expired = await refusal(() => redeemExchange(code, { appId: target.id, state: STATE }));
    const unknown = await refusal(() =>
      redeemExchange(`never-issued-${uuid()}`, { appId: target.id, state: STATE })
    );
    expect(expired.code).toBe("sign_in_required");
    expect(expired).toEqual(unknown);
  });

  it("refuses when the grant was revoked between minting and redeeming", async () => {
    const target = await app("redeem-revoked");
    const grant = await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    const { code } = await launch(target.id);
    await revokeGrant(grant.id, IDENTITIES.owner.subject, "left the project");

    expect((await refusal(() => redeemExchange(code, { appId: target.id, state: STATE }))).code).toBe("forbidden");
    expect(await a.repos.sessions.listByApp(target.id, { liveOnly: true })).toHaveLength(0);
  });

  it("refuses when the app was suspended between minting and redeeming", async () => {
    const target = await app("redeem-suspended");
    await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    const { code } = await launch(target.id);
    await setState(target.id, "suspended");

    expect((await refusal(() => redeemExchange(code, { appId: target.id, state: STATE }))).code).toBe("suspended");
  });
});

describe("resolving a session", () => {
  const open = async (slug: string, who: TestIdentity = IDENTITIES.viewer) => {
    const target = await app(slug);
    const grant = await seedGrant(a, target.id, who, "viewer");
    const { code } = await launch(target.id, who);
    return { target, grant, redeemed: await redeemExchange(code, { appId: target.id, state: STATE }) };
  };

  it("answers with the live session and grant, and re-reads on every call", async () => {
    const { target, grant, redeemed } = await open("resolve-ok");
    const resolved = await resolveAppSession(redeemed.cookieValue, target.id);
    expect(resolved?.session.id).toBe(redeemed.session.id);
    expect(resolved?.grant.id).toBe(grant.id);
    expect((await resolveAppSessionDetailed(redeemed.cookieValue, target.id)).ok).toBe(true);
  });

  it("refuses the same cookie on another app", async () => {
    const { redeemed } = await open("resolve-wrong-app");
    const other = await app("resolve-other-app");
    expect(await resolveAppSession(redeemed.cookieValue, other.id)).toBeNull();
    expect(await resolveAppSessionDetailed(redeemed.cookieValue, other.id)).toEqual({
      ok: false,
      reason: "wrong_app",
    });
  });

  it("stops as soon as the grant is revoked", async () => {
    const { target, grant, redeemed } = await open("resolve-revoked");
    await revokeGrant(grant.id, IDENTITIES.owner.subject, "left the project");
    // Revoking terminated the session in the same transaction, so the first
    // reason a reader meets is that it was terminated.
    expect(await resolveAppSession(redeemed.cookieValue, target.id)).toBeNull();
    expect(await resolveAppSessionDetailed(redeemed.cookieValue, target.id)).toEqual({
      ok: false,
      reason: "terminated",
    });
    expect((await a.repos.sessions.get(redeemed.session.id))?.terminatedReason).toBe("revoked");
  });

  it("stops when the person signs out of the platform, on every app at once", async () => {
    // A subject of this test's own, so sessions other tests in this file opened
    // cannot be counted among the two this one is about.
    const who: TestIdentity = {
      subject: `55555555-5555-4555-8555-${uuid().slice(0, 12)}`,
      email: "signs-out@example.test",
      name: "Sam Signout",
    };
    const one = await open("resolve-signout-1", who);
    const two = await open("resolve-signout-2", who);

    expect(await terminateAppSessionsForSubject(who.subject, "signed_out")).toBe(2);
    expect(await resolveAppSession(one.redeemed.cookieValue, one.target.id)).toBeNull();
    expect(await resolveAppSession(two.redeemed.cookieValue, two.target.id)).toBeNull();
    expect(await resolveAppSessionDetailed(one.redeemed.cookieValue, one.target.id)).toEqual({
      ok: false,
      reason: "terminated",
    });
    // Nothing left to end, and no column of the event — the logical id
    // included — carries the subject or the address it belongs to.
    expect(await terminateAppSessionsForSubject(who.subject, "signed_out")).toBe(0);
    const events = await a.repos.events.listSince({ event: "session.terminated" });
    expect(events.length).toBeGreaterThan(0);
    expect(await events.some((e) => e.props?.scope === "subject")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(who.subject);
    expect(JSON.stringify(events)).not.toContain(who.email);
  });

  it("stops at the expiry instant, and when the app itself goes away", async () => {
    const { target, redeemed } = await open("resolve-expiry");
    sqliteConnection(a)
      .prepare("UPDATE app_sessions SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1).toISOString(), redeemed.session.id);
    expect(await resolveAppSessionDetailed(redeemed.cookieValue, target.id)).toEqual({
      ok: false,
      reason: "expired",
    });

    const other = await open("resolve-app-gone");
    await setState(other.target.id, "suspended");
    expect(await resolveAppSessionDetailed(other.redeemed.cookieValue, other.target.id)).toEqual({
      ok: false,
      reason: "app_unavailable",
    });
  });

  it("answers `missing` for an empty or unknown cookie, never a throw", async () => {
    const { target } = await open("resolve-missing");
    expect(await resolveAppSessionDetailed("", target.id)).toEqual({ ok: false, reason: "missing" });
    expect(await resolveAppSessionDetailed(`unknown-${uuid()}`, target.id)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("ends one session by its cookie, and every session on an app", async () => {
    const { target, redeemed } = await open("terminate-one");
    expect(await terminateAppSession(redeemed.cookieValue, "signed_out")).toBe(true);
    expect(await terminateAppSession(redeemed.cookieValue, "signed_out")).toBe(false);
    expect((await a.repos.sessions.get(redeemed.session.id))?.terminatedReason).toBe("signed_out");

    const bulk = await open("terminate-app");
    expect(await terminateAppSessionsForApp(bulk.target.id, "operator")).toBe(1);
    expect(await terminateAppSessionsForApp(bulk.target.id, "operator")).toBe(0);
    expect(await resolveAppSession(bulk.redeemed.cookieValue, bulk.target.id)).toBeNull();
    expect(target.id).not.toBe(bulk.target.id);
  });
});

describe("the cookie", () => {
  it("is host-only, secure, http-only and lax — and never carries a Domain", async () => {
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

  it("clears itself under the same name, with no Domain and no value", async () => {
    const header = clearAppSessionCookie();
    expect(header).toBe("__Host-zenith_app=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
    expect(header.toLowerCase()).not.toContain("domain");
  });

  it("refuses to put anything but an opaque value in the cookie", async () => {
    expect(() => appSessionCookie("bad value; Domain=evil.test", "2026-01-02T03:04:05.000Z")).toThrow(
      HostedError
    );
    expect(() => appSessionCookie("Abc-123", "not-a-date")).toThrow(HostedError);
  });
});
