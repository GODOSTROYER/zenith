/**
 * Gate 2 — a second identity, with no workspace membership at all, signs in on
 * the app host through the exchange.
 *
 * The point of this gate is that app access is its own authority (PLAN-R3
 * R3-02). The recipient here holds nothing: no row in the legacy workspace
 * store, no grant, no session. An invitation is issued, accepted against a
 * verified address, and that alone is enough to open the app on its own host —
 * and it is *only* enough for that app.
 *
 * Everything is the real module: `createInvite` hashes the token and hands the
 * link over once, `acceptInvite` refuses an unverified or mismatched address,
 * `createExchange` mints the single-use code, and the app host's callback is
 * what sets the cookie the browser then carries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostedApp, SessionInfo } from "@/lib/hosted/contracts";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import {
  OUTSIDER,
  RECIPIENT,
  acceptanceEnv,
  appHost,
  appOrigin,
  call,
  closeHosted,
  cookieValueOf,
  errorBody,
  loadHosted,
  publishOrThrow,
  releaseOf,
  signIn,
  verifiedIdentity,
  type HostedModules,
} from "./_journey";

const DATA = isolatedDataDir("zenith-w10-gate02-");
acceptanceEnv(DATA);

let m: HostedModules;
let alpha: HostedApp;
let beta: HostedApp;
let alphaRelease = "";
let recipientCookie = "";
const OWNER = IDENTITIES.owner;

beforeAll(async () => {
  m = await loadHosted();
  m.authority.openAuthority();

  alpha = await m.release.createApp({
    workspaceId: WORKSPACES.one.id,
    slug: "alpha",
    name: "Alpha equipment tracker",
    createdBy: OWNER.subject,
    email: OWNER.email,
  });
  beta = await m.release.createApp({
    workspaceId: WORKSPACES.two.id,
    slug: "beta",
    name: "Beta equipment tracker",
    createdBy: OWNER.subject,
    email: OWNER.email,
  });

  alphaRelease = releaseOf(
    await publishOrThrow(m, { app: alpha, actor: OWNER.subject, source: { kind: "fixture", name: "minimal-app" } })
  ).releaseId;
  await publishOrThrow(m, {
    app: beta,
    actor: OWNER.subject,
    source: { kind: "fixture", name: "minimal-app" },
  });
}, 300_000);

afterAll(() => {
  closeHosted(m);
  removeDir(DATA);
});

/** The token out of the one place it is ever handed over in clear. */
const tokenOf = (acceptUrl: string): string => new URL(acceptUrl).searchParams.get("token") as string;

describe("Gate 2 — a second identity with no workspace membership", () => {
  it("starts with nothing: no workspace member row, no grant, no session", async () => {
    // Workspace membership lives in the legacy JSON store, keyed by address
    // (decision R3-02 keeps the two authorities apart). The recipient is in
    // neither: no member row anywhere, and no grant.
    const { db } = await import("@/lib/db/store");
    expect(
      db().members.filter((member) => member.email.toLowerCase() === RECIPIENT.email.toLowerCase()),
      "the recipient must hold no workspace membership in the legacy store"
    ).toEqual([]);
    expect(
      m.access.activeGrant(alpha.id, RECIPIENT.subject),
      "the recipient must hold no grant before the invitation"
    ).toBeNull();

    const cold = call({ host: appHost("alpha"), path: "/", accept: "application/json" });
    const res = await m.gateway.handleGateway(cold.req, cold.params);
    expect(res.status, "an app host refuses an unknown caller").toBe(401);
    expect((await errorBody(res)).code).toBe("sign_in_required");
  });

  it("accepts an invitation only against the verified address it names", () => {
    const issued = m.access.createInvite(
      alpha.id,
      { email: RECIPIENT.email, role: "editor" },
      OWNER.subject
    );
    const token = tokenOf(issued.acceptUrl);
    expect(issued.invite.state).toBe("pending");
    expect(issued.invite.tokenHash, "only the hash is stored").not.toBe(token);

    // Somebody else's verified address is not this invitation's address.
    expect(() => m.access.acceptInvite(token, verifiedIdentity(OUTSIDER))).toThrowError(
      /sent to a different address/
    );
    // The right address, unconfirmed, is refused in exactly the same words.
    expect(() =>
      m.access.acceptInvite(token, verifiedIdentity(RECIPIENT, { emailVerified: false }))
    ).toThrowError(/sent to a different address/);

    const accepted = m.access.acceptInvite(token, verifiedIdentity(RECIPIENT));
    expect(accepted.app.id).toBe(alpha.id);
    expect(accepted.grant.role, "the role the invitation named").toBe("editor");
    expect(accepted.grant.state).toBe("active");
    expect(accepted.grant.email).toBe(RECIPIENT.email.toLowerCase());

    // Single use: the same link cannot be redeemed twice, by anybody.
    expect(() => m.access.acceptInvite(token, verifiedIdentity(RECIPIENT))).toThrowError(
      /no longer usable/
    );
  });

  it("launches from the control origin and redeems on the app host", async () => {
    const state = `state-${uuid()}`;
    const { redirect } = m.access.createExchange(alpha.id, RECIPIENT.subject, state);
    const url = new URL(redirect);
    expect(url.host, "the launch lands on the app's own host").toBe(appHost("alpha"));
    expect(url.pathname).toBe("/_zenith/auth/callback");
    expect(url.searchParams.get("state"), "the browser's state is round-tripped").toBe(state);

    const { req, params } = call({
      host: appHost("alpha"),
      path: `${url.pathname}${url.search}`,
      accept: "text/html",
    });
    const res = await m.gateway.handleGateway(req, params);
    expect(res.status, "the callback answers a redirect to the app root").toBe(303);
    expect(res.headers.get("location")).toBe("/");

    const raw = res.headers.getSetCookie().join("\n");
    expect(raw, "the app session cookie is host-locked").toContain("__Host-zenith_app=");
    expect(raw, "Secure").toContain("Secure");
    expect(raw, "HttpOnly").toContain("HttpOnly");
    expect(raw, "SameSite=Lax").toContain("SameSite=Lax");
    expect(raw, "Path=/").toContain("Path=/");
    expect(raw, "a __Host- cookie may carry no Domain").not.toMatch(/;\s*Domain=/i);
    expect(raw, "no platform cookie is ever set on an app host").not.toMatch(/\bsb-|zenith-/);

    const value = cookieValueOf(res);
    expect(value).toBeTruthy();
    recipientCookie = `__Host-zenith_app=${value}`;

    // The code is single use: replaying the same callback bounces the browser
    // to the sign-in page with a reason code, and sets no session.
    const replay = call({
      host: appHost("alpha"),
      path: `${url.pathname}${url.search}`,
      accept: "text/html",
    });
    const second = await m.gateway.handleGateway(replay.req, replay.params);
    expect(second.status).toBe(303);
    const bounce = second.headers.get("location") ?? "";
    expect(bounce, "a spent code lands on the sign-in page, not on /").toMatch(
      /^\/_zenith\/auth\/signin\?error=/
    );
    expect(cookieValueOf(second), "a spent code must mint no session").toBeNull();

    // The page it lands on says something a person can act on, and says it from
    // the gateway's own fixed table rather than from the failure.
    const signin = call({
      host: appHost("alpha"),
      path: bounce,
      accept: "text/html",
    });
    const page = await m.gateway.handleGateway(signin.req, signin.params);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html, "the page explains where the door is").toContain("Open this app from Zenith");
    expect(html, "and links to the control origin").toContain("http://localhost:3400/apps");
    expect(html, "the page holds no credential field").not.toMatch(/<input/i);
  });

  it("binds the exchange code to this app and this browser's state", async () => {
    // A code whose state was tampered with on the way back.
    const first = new URL(m.access.createExchange(alpha.id, RECIPIENT.subject, `state-${uuid()}`).redirect);
    first.searchParams.set("state", "a-state-the-browser-never-sent");
    const tampered = call({
      host: appHost("alpha"),
      path: `${first.pathname}${first.search}`,
      accept: "text/html",
    });
    const res = await m.gateway.handleGateway(tampered.req, tampered.params);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/_zenith/auth/signin?error=forbidden");
    expect(cookieValueOf(res), "a mismatched state mints no session").toBeNull();

    // A code minted for alpha, presented on beta's host.
    const second = new URL(m.access.createExchange(alpha.id, RECIPIENT.subject, `state-${uuid()}`).redirect);
    const crossed = call({
      host: appHost("beta"),
      path: `${second.pathname}${second.search}`,
      accept: "text/html",
    });
    const wrongHost = await m.gateway.handleGateway(crossed.req, crossed.params);
    expect(wrongHost.status).toBe(303);
    expect(wrongHost.headers.get("location")).toBe("/_zenith/auth/signin?error=forbidden");
    expect(cookieValueOf(wrongHost), "a code presented on the wrong host mints no session").toBeNull();

    // And it is spent either way: a code that went to the wrong place cannot
    // then be replayed at the right one.
    const replay = call({
      host: appHost("alpha"),
      path: `${second.pathname}${second.search}`,
      accept: "text/html",
    });
    const spent = await m.gateway.handleGateway(replay.req, replay.params);
    expect(cookieValueOf(spent), "a misdirected code is consumed, not left lying around").toBeNull();
  });

  it("shows the recipient their own role on the app host", async () => {
    const { req, params } = call({
      host: appHost("alpha"),
      path: "/_zenith/session",
      cookie: recipientCookie,
      accept: "application/json",
    });
    const res = await m.gateway.handleGateway(req, params);
    expect(res.status).toBe(200);
    const info = (await res.json()) as SessionInfo;
    expect(info.subject).toBe(RECIPIENT.subject);
    expect(info.email).toBe(RECIPIENT.email.toLowerCase());
    expect(info.role, "the role the invitation granted").toBe("editor");
    expect(info.releaseId, "the session names the release serving it").toBe(alphaRelease);
    expect(info.controlOrigin).toBe("http://localhost:3400");
  });

  it("lets the recipient do the thing they were invited to do", async () => {
    const create = call({
      host: appHost("alpha"),
      path: "/_zenith/data/v1/requests",
      method: "POST",
      cookie: recipientCookie,
      origin: appOrigin("alpha"),
      accept: "application/json",
      body: JSON.stringify({ writeId: uuid(), record: { title: "Laptop stand", category: "furniture" } }),
    });
    const res = await m.gateway.handleGateway(create.req, create.params);
    expect(res.status, "an editor may create").toBe(201);
    const { record } = (await res.json()) as { record: { id: string; createdByEmail: string } };
    expect(record.createdByEmail, "the record is attributed to the recipient").toBe(
      RECIPIENT.email.toLowerCase()
    );

    const read = call({
      host: appHost("alpha"),
      path: "/_zenith/data/v1/requests",
      cookie: recipientCookie,
      accept: "application/json",
    });
    const list = (await (await m.gateway.handleGateway(read.req, read.params)).json()) as {
      items: { id: string }[];
    };
    expect(list.items.map((item) => item.id)).toContain(record.id);
  });

  it("does not let the same identity — or the same cookie — near app B", async () => {
    // The cookie is minted for alpha. On beta it resolves to nothing at all,
    // and the refusal is the one an unknown caller gets: no oracle.
    const onBeta = call({
      host: appHost("beta"),
      path: "/",
      cookie: recipientCookie,
      accept: "application/json",
    });
    m.gateway.resetGatewayTelemetry();
    const res = await m.gateway.handleGateway(onBeta.req, onBeta.params);
    expect(res.status, "app A's cookie on app B").toBe(401);
    expect((await errorBody(res)).code).toBe("sign_in_required");
    expect(m.gateway.gatewayTelemetry.artifactServed, "no artifact may be read").toBe(0);
    expect(m.gateway.gatewayTelemetry.brokerInvoked, "no broker call may happen").toBe(0);

    // And the identity cannot mint an exchange for beta either: there is no
    // grant. The refusal is word for word the one an app id that does not
    // exist gets, so app ids stay non-enumerable.
    const refusal = (appId: string): string => {
      try {
        m.access.createExchange(appId, RECIPIENT.subject, `state-${uuid()}`);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      throw new Error(`createExchange(${appId}) was expected to refuse and did not`);
    };
    const onKnownApp = refusal(beta.id);
    expect(onKnownApp).toMatch(/does not have it/);
    expect(refusal("00000000-0000-4000-8000-000000000000"), "no oracle over app ids").toBe(onKnownApp);

    // The session is still perfectly good on alpha.
    const onAlpha = call({
      host: appHost("alpha"),
      path: "/",
      cookie: recipientCookie,
      accept: "application/json",
    });
    expect((await m.gateway.handleGateway(onAlpha.req, onAlpha.params)).status).toBe(200);
  });

  it("gives the owner a session of their own, without the recipient's cookie working for them", async () => {
    const ownerCookie = await signIn(m, alpha, OWNER.subject);
    expect(ownerCookie).not.toBe(recipientCookie);

    const { req, params } = call({
      host: appHost("alpha"),
      path: "/_zenith/session",
      cookie: ownerCookie,
      accept: "application/json",
    });
    const info = (await (await m.gateway.handleGateway(req, params)).json()) as SessionInfo;
    expect(info.subject).toBe(OWNER.subject);
    expect(info.role).toBe("owner");
  });
});
