/**
 * Gate 3 — the denial matrix.
 *
 * Six ways of not having access — never invited, revoked, an invitation that
 * expired, a cookie minted for another app, a session ended by signing out of
 * the platform, and an app that has been suspended — crossed with the five
 * request shapes a browser or a script actually sends: an HTML navigation, a
 * hashed asset, the data API, a `HEAD`, and a byte range.
 *
 * Two things are asserted for every cell, and the second is the one that
 * matters. The status is the visible half. The invisible half is
 * `gatewayTelemetry`: `artifactServed` and `brokerInvoked` must both still be
 * zero, which is what "admission happens before any artifact or broker is
 * touched" means when it is true rather than intended.
 *
 * The last case is the control origin itself. A request that reaches
 * `/hosted-gateway/...` carrying `Host: localhost:3400` is not an app request
 * however it got there, and it is answered 404 with no stamp of any kind.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactStore, HostedApp } from "@/lib/hosted/contracts";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import {
  OUTSIDER,
  RECIPIENT,
  acceptanceEnv,
  appHost,
  appOrigin,
  call,
  closeHosted,
  errorBody,
  headerMap,
  loadHosted,
  publishOrThrow,
  releaseOf,
  signIn,
  verifiedIdentity,
  type HostedModules,
} from "./_journey";

const DATA = isolatedDataDir("zenith-w10-gate03-");
acceptanceEnv(DATA);

let m: HostedModules;
let store: ArtifactStore;
let alpha: HostedApp;
let beta: HostedApp;
let assetPath = "";
let alphaRelease = "";

const OWNER = IDENTITIES.owner;
const EDITOR = IDENTITIES.editor;
const ALPHA = appHost("alpha");
const BETA = appHost("beta");

/** Every refusal shape one caller is tried with. */
type Shape = "html" | "asset" | "api" | "head" | "range";

/** Run the five shapes and answer with the status of each, sentinel checked. */
async function matrix(host: string, cookie?: string): Promise<Record<Shape, number>> {
  await m.gateway.resetGatewayTelemetry();
  const calls: Record<Shape, ReturnType<typeof call>> = {
    html: call({ host, path: "/", cookie, accept: "text/html" }),
    asset: call({ host, path: `/${assetPath}`, cookie }),
    api: call({ host, path: "/_zenith/data/v1/requests", cookie, accept: "application/json" }),
    head: call({ host, path: "/", method: "HEAD", cookie }),
    range: call({ host, path: `/${assetPath}`, cookie, headers: { range: "bytes=0-10" } }),
  };
  const out = {} as Record<Shape, number>;
  for (const [name, one] of Object.entries(calls) as [Shape, ReturnType<typeof call>][]) {
    const res = await m.gateway.handleGateway(one.req, one.params);
    out[name] = res.status;
  }
  return out;
}

/** What a fully denied caller must see, and nothing served on the way. */
function expectDenied(statuses: Record<Shape, number>, code: 401 | 423, who: string): void {
  const htmlExpected = code === 401 ? 303 : 423;
  expect(statuses.html, `${who}: an HTML navigation`).toBe(htmlExpected);
  expect(statuses.asset, `${who}: a hashed asset`).toBe(code);
  expect(statuses.api, `${who}: the data API`).toBe(code);
  expect(statuses.head, `${who}: HEAD /`).toBe(code);
  expect(statuses.range, `${who}: a byte range`).toBe(code);
  expect(m.gateway.gatewayTelemetry.artifactServed, `${who}: artifacts read`).toBe(0);
  expect(m.gateway.gatewayTelemetry.brokerInvoked, `${who}: broker calls`).toBe(0);
}

beforeAll(async () => {
  m = await loadHosted();
  m.authority.openAuthority();
  store = new m.artifacts.FsArtifactStore(m.config.hostedConfig().artifactDir);

  alpha = await m.release.createApp({
    workspaceId: WORKSPACES.one.id,
    slug: "alpha",
    name: "Alpha equipment tracker",
    createdBy: OWNER.subject,
    email: OWNER.email,
  });
  beta = await m.release.createApp({
    workspaceId: WORKSPACES.one.id,
    slug: "beta",
    name: "Beta equipment tracker",
    createdBy: OWNER.subject,
    email: OWNER.email,
  });

  const job = await publishOrThrow(m, {
    app: alpha,
    actor: OWNER.subject,
    source: { kind: "fixture", name: "minimal-app" },
  });
  alphaRelease = releaseOf(job).releaseId;
  await publishOrThrow(m, {
    app: beta,
    actor: OWNER.subject,
    source: { kind: "fixture", name: "minimal-app" },
  });

  const files = await store.list(releaseOf(job).digest);
  assetPath = files.find((file) => /^assets\/.+\.js$/.test(file.path))?.path ?? "";
  if (!assetPath) throw new Error(`the build emitted no JS asset: ${files.map((f) => f.path).join(", ")}`);
}, 300_000);

afterAll(async () => {
  await closeHosted(m);
  removeDir(DATA);
});

describe("Gate 3 — who is turned away, and how far they get", () => {
  it("serves an admitted owner, so the matrix below is measuring denial and not absence", async () => {
    const cookie = await signIn(m, alpha, OWNER.subject);
    await m.gateway.resetGatewayTelemetry();
    const statuses = await matrix(ALPHA, cookie);
    expect(statuses.html, "an admitted HTML navigation").toBe(200);
    expect(statuses.asset).toBe(200);
    expect(statuses.api).toBe(200);
    expect(statuses.head).toBe(200);
    expect(statuses.range, "a byte range on a hashed asset").toBe(206);
    expect(m.gateway.gatewayTelemetry.artifactServed, "the admitted caller did read artifacts").toBeGreaterThan(0);
  });

  it("turns away somebody who was never invited", async () => {
    expectDenied(await matrix(ALPHA), 401, "no cookie at all");

    // A cookie-shaped value that names no session is the same answer.
    expectDenied(
      await matrix(ALPHA, `__Host-zenith_app=${"f".repeat(43)}`),
      401,
      "a fabricated cookie"
    );
  });

  it("turns away a revoked grant holder, and the cookie they were holding", async () => {
    const grant = await m.access.grantDirect(
      alpha.id,
      { subject: OUTSIDER.subject, email: OUTSIDER.email, role: "editor" },
      OWNER.subject
    );
    const cookie = await signIn(m, alpha, OUTSIDER.subject);
    expect((await matrix(ALPHA, cookie)).html, "before the revocation").toBe(200);

    await m.access.revokeGrant(grant.id, OWNER.subject, "left the pilot", { appId: alpha.id });
    expectDenied(await matrix(ALPHA, cookie), 401, "a revoked grant");

    // The revocation is durable and the session row is closed, not just ignored.
    const a = m.authority.authority();
    expect(await a.repos.grants.activeFor(alpha.id, OUTSIDER.subject), "no active grant remains").toBeNull();
    expect(
      await m.access.resolveAppSessionDetailed(cookie.split("=")[1], alpha.id),
      "the session resolves to a reason, never to ok"
    ).toMatchObject({ ok: false });
  });

  it("turns away an invitation that expired before it was opened", async () => {
    const issued = await m.access.createInvite(
      alpha.id,
      { email: RECIPIENT.email, role: "editor" },
      OWNER.subject
    );
    const token = new URL(issued.acceptUrl).searchParams.get("token") as string;

    // Move the invitation's own expiry into the past — the only thing a test
    // can honestly do about a 48-hour window without waiting two days.
    m.authority
      .sqliteConnection(m.authority.authority())
      .prepare("UPDATE app_invites SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), issued.invite.id);

    await expect(m.access.acceptInvite(token, verifiedIdentity(RECIPIENT))).rejects.toThrowError(
      /no longer usable/
    );
    expect(
      await m.access.activeGrant(alpha.id, RECIPIENT.subject),
      "an expired invitation grants nothing"
    ).toBeNull();
    expectDenied(await matrix(ALPHA), 401, "an expired invitation");
  });

  it("turns away a cookie minted for the other app, with no hint that it is valid elsewhere", async () => {
    const onBeta = await signIn(m, beta, OWNER.subject);
    expect((await matrix(BETA, onBeta)).html, "the cookie works where it was minted").toBe(200);
    expectDenied(await matrix(ALPHA, onBeta), 401, "beta's cookie on alpha");

    // Word for word the answer a caller with no cookie gets.
    const stranger = call({ host: ALPHA, path: "/", accept: "application/json" });
    const wrongApp = call({ host: ALPHA, path: "/", cookie: onBeta, accept: "application/json" });
    const a = await errorBody(await m.gateway.handleGateway(stranger.req, stranger.params));
    const b = await errorBody(await m.gateway.handleGateway(wrongApp.req, wrongApp.params));
    expect(b).toEqual(a);
  });

  it("turns away a session the platform ended when the person signed out", async () => {
    const cookie = await signIn(m, alpha, OWNER.subject);
    expect((await matrix(ALPHA, cookie)).html).toBe(200);

    const ended = await m.access.terminateAppSessionsForSubject(OWNER.subject, "signed_out");
    expect(ended, "signing out of the platform ends app sessions").toBeGreaterThan(0);
    expectDenied(await matrix(ALPHA, cookie), 401, "a terminated session");
  });

  it("does not let a conditional request answer 304 before admission", async () => {
    // `If-None-Match: *` matches any representation. A gateway that answered it
    // from the cache layer would confirm the file exists to somebody it has not
    // admitted, and would do it without a body — which is the shape of leak
    // that is easiest to miss.
    m.gateway.resetGatewayTelemetry();
    const conditional = call({
      host: ALPHA,
      path: `/${assetPath}`,
      headers: { "if-none-match": "*" },
    });
    const res = await m.gateway.handleGateway(conditional.req, conditional.params);
    expect(res.status, "a conditional request from a stranger").toBe(401);
    expect(m.gateway.gatewayTelemetry.artifactServed).toBe(0);
  });

  it("ends only the sessions it was asked to end", async () => {
    // The editor holds access to both apps, and signs out of alpha.
    await m.access.grantDirect(alpha.id, { subject: EDITOR.subject, email: EDITOR.email, role: "editor" }, OWNER.subject);
    await m.access.grantDirect(beta.id, { subject: EDITOR.subject, email: EDITOR.email, role: "editor" }, OWNER.subject);
    const onAlpha = await signIn(m, alpha, EDITOR.subject);
    const onBeta = await signIn(m, beta, EDITOR.subject);

    const out = call({
      host: ALPHA,
      path: "/_zenith/auth/signout",
      method: "POST",
      cookie: onAlpha,
      origin: appOrigin("alpha"),
      accept: "application/json",
    });
    const res = await m.gateway.handleGateway(out.req, out.params);
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie"), "the browser is told to drop the cookie").toContain("Max-Age=0");

    expect((await matrix(ALPHA, onAlpha)).html, "signed out of alpha").toBe(303);
    const stillOnBeta = call({ host: BETA, path: "/", cookie: onBeta, accept: "application/json" });
    expect(
      (await m.gateway.handleGateway(stillOnBeta.req, stillOnBeta.params)).status,
      "signing out of one app is not signing out of another"
    ).toBe(200);

    // Platform sign-out is the one that takes everything.
    const ended = await m.access.terminateAppSessionsForSubject(EDITOR.subject, "signed_out");
    expect(ended, "the remaining app session ends with the platform session").toBeGreaterThan(0);
    const afterPlatform = call({ host: BETA, path: "/", cookie: onBeta, accept: "application/json" });
    expect((await m.gateway.handleGateway(afterPlatform.req, afterPlatform.params)).status).toBe(401);
  });

  it("turns away everybody while the app is suspended, and says so as 423", async () => {
    const cookie = await signIn(m, beta, OWNER.subject);
    const job = await m.release.admitSuspend({
      jobId: uuid(),
      appId: beta.id,
      workspaceId: beta.workspaceId,
      actor: OWNER.subject,
      reason: "paused for the acceptance run",
    });
    const finished = await m.release.runJobOnce(job.job.id);
    expect(finished.status, `suspend job: ${finished.error ?? ""}`).toBe("succeeded");
    expect((await m.authority.authority().repos.apps.get(beta.id))?.state).toBe("suspended");

    expectDenied(await matrix(BETA, cookie), 423, "a suspended app");

    const refused = call({ host: BETA, path: "/", cookie, accept: "application/json" });
    const body = await errorBody(await m.gateway.handleGateway(refused.req, refused.params));
    expect(body.code).toBe("suspended");
    expect(body.message, "the refusal repeats the operator's reason").toContain(
      "paused for the acceptance run"
    );
    expect(body.fix, "and says nothing was destroyed").toMatch(/data, grants and releases/);

    // The sign-in page is the one thing a suspended app still renders, so a
    // person who followed a link is not left on a bare error.
    const page = call({ host: BETA, path: "/_zenith/auth/signin", accept: "text/html" });
    expect((await m.gateway.handleGateway(page.req, page.params)).status).toBe(200);
  });

  /* ---------------------------- the control origin ---------------------- */

  it("answers a direct control-origin request to the gateway path with 404 and no stamp", async () => {
    await m.gateway.resetGatewayTelemetry();
    const direct = call({
      host: "localhost:3400",
      paramHost: appHost("alpha"),
      path: "/",
      accept: "text/html",
    });
    const res = await m.gateway.handleGateway(direct.req, direct.params);
    expect(res.status, "the control origin is not an app host").toBe(404);
    expect(res.headers.get("x-zenith-release"), "no release attribution on an unknown host").toBeNull();
    expect(m.gateway.gatewayTelemetry.artifactServed).toBe(0);
    expect(m.gateway.gatewayTelemetry.brokerInvoked).toBe(0);

    // The same when the two disagree the other way round.
    const mismatched = call({ host: appHost("alpha"), paramHost: appHost("beta"), path: "/" });
    expect(
      (await m.gateway.handleGateway(mismatched.req, mismatched.params)).status,
      "Host and route parameter must be the same host"
    ).toBe(404);

    // And for a host that is under the app domain but names no app.
    const nobody = call({ host: appHost("nosuchapp"), path: "/" });
    expect((await m.gateway.handleGateway(nobody.req, nobody.params)).status).toBe(404);
  });

  it("puts the security headers on refusals too, not only on what it serves", async () => {
    const denied = call({ host: ALPHA, path: "/", accept: "application/json" });
    const res = await m.gateway.handleGateway(denied.req, denied.params);
    const headers = headerMap(res);
    expect(res.status).toBe(401);
    expect(headers["content-security-policy"], "CSP on a refusal").toBe(m.gateway.GATEWAY_CSP);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(headers["set-cookie"], "a refusal sets nothing").toBeUndefined();
  });

  it("does not charge an app for traffic that was never its own", async () => {
    const day = m.authority.utcDay();
    const before = (await m.authority.authority().repos.quotas.get(alpha.id, day)).requests;
    for (const host of [appHost("nosuchapp"), "localhost:3400", "evil.example"]) {
      const one = call({ host, path: "/", accept: "application/json" });
      expect((await m.gateway.handleGateway(one.req, one.params)).status, host).toBe(404);
    }
    expect(
      (await m.authority.authority().repos.quotas.get(alpha.id, day)).requests,
      "a request that resolved to no app is nobody's traffic"
    ).toBe(before);
  });

  it("recorded every one of those denials against the app, and counted them as traffic", async () => {
    const a = m.authority.authority();
    const denials = (
      await a.repos.events.listSince({ appId: alpha.id, event: "access.denied" }, { limit: 500 })
    ).length;
    expect(denials, "each refusal is an event an owner can see").toBeGreaterThan(0);

    const counter = await a.repos.quotas.get(alpha.id, m.authority.utcDay());
    expect(
      counter.requests,
      "R3-12: every request that reached a known app host counts, whatever its outcome"
    ).toBeGreaterThan(denials);
  });

  it("kept the release pointer untouched throughout", async () => {
    expect((await m.authority.authority().repos.apps.get(alpha.id))?.activeReleaseId).toBe(alphaRelease);
  });
});
