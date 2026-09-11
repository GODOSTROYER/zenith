/**
 * The reserved routes: how a session starts, what it can read about itself,
 * and how it ends.
 *
 * The two routes reachable without a session — the sign-in page and the
 * exchange callback — are the only doors into a private app, so they get the
 * most attention here: the page must render with no script under the gateway's
 * own CSP, and a failed redemption must bounce with a code and nothing else.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { IDENTITIES, isolatedDataDir, removeDir } from "../_fixtures";
import type { SessionInfo } from "@/lib/hosted/contracts";
import {
  CONTROL_ORIGIN,
  appOrigin,
  call,
  errorBody,
  makeDoubles,
  provenance,
  resolved,
  seedActiveRelease,
  seedApp,
  seedArtifactRow,
  sessionCookie,
  writeBuiltTree,
} from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-gateway-reserved-");

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { FsArtifactStore } = await import("@/lib/hosted/artifacts");
const { hostedConfig } = await import("@/lib/hosted/config");
const { closeAllAppData } = await import("@/lib/hosted/data");
const { gatewayTelemetry, handleGateway, resetGatewayDeps, resetGatewayTelemetry, setGatewayDepsForTests } =
  await import("@/lib/hosted/gateway");

const authority = openAuthority();
const store = new FsArtifactStore(hostedConfig().artifactDir);
const artifact = await store.put(writeBuiltTree(DATA_DIR), provenance("job-reserved"));
seedArtifactRow(authority, artifact.digest, artifact.byteSize, artifact.fileCount);

const alpha = seedApp(authority, { slug: "alpha", name: "Alpha equipment tracker" });
const release = seedActiveRelease(authority, alpha, artifact.digest);

const doubles = makeDoubles();
const OWNER_COOKIE = "cookie-owner";
const ORIGIN = appOrigin("alpha");

beforeEach(() => {
  resetGatewayDeps();
  setGatewayDepsForTests(doubles.deps);
  resetGatewayTelemetry();
  doubles.state.events.length = 0;
  doubles.state.terminated.length = 0;
  doubles.state.sessions.clear();
  doubles.state.exchanges.clear();
  doubles.state.sessions.set(
    OWNER_COOKIE,
    resolved(alpha, { subject: IDENTITIES.owner.subject, email: IDENTITIES.owner.email, role: "owner" })
  );
});

afterAll(() => {
  resetGatewayDeps();
  closeAllAppData();
  closeAuthority();
  removeDir(DATA_DIR);
});

describe("the sign-in page", () => {
  it("renders with no script, and links to the control origin's apps list", async () => {
    const { req, params } = call({ path: "/_zenith/auth/signin", accept: "text/html" });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const html = await res.text();
    expect(html).toContain("Open this app from Zenith");
    expect(html).toContain(`href="${CONTROL_ORIGIN}/apps"`);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("<input");
    expect(gatewayTelemetry.artifactServed).toBe(0);
  });

  it("says one sentence about a code it recognises, and stays vague about one it does not", async () => {
    const known = call({ path: "/_zenith/auth/signin?error=forbidden", accept: "text/html" });
    expect(await (await handleGateway(known.req, known.params)).text()).toContain(
      "Your access to this app has changed"
    );

    const invented = call({
      path: "/_zenith/auth/signin?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
      accept: "text/html",
    });
    const html = await (await handleGateway(invented.req, invented.params)).text();
    expect(html).toContain("That sign-in link did not work.");
    expect(html).not.toContain("<script>alert");
  });
});

describe("the exchange callback", () => {
  it("sets the __Host- cookie and sends the browser to the app root", async () => {
    doubles.state.exchanges.set("good-code", {
      state: "browser-state",
      appId: alpha.id,
      cookieValue: "brand-new-session",
      expiresAt: new Date("2026-09-07T21:00:00.000Z").toISOString(),
    });
    const { req, params } = call({
      path: "/_zenith/auth/callback?code=good-code&state=browser-state",
      accept: "text/html",
    });
    const res = await handleGateway(req, params);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-zenith_app=brand-new-session");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("bounces a code it cannot redeem back to the page, with only the code", async () => {
    const { req, params } = call({
      path: "/_zenith/auth/callback?code=stale&state=browser-state",
      accept: "text/html",
    });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/_zenith/auth/signin?error=not_found");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(doubles.state.events.map((e) => e.event)).toContain("access.denied");
  });

  it("bounces a callback whose state does not match the exchange", async () => {
    doubles.state.exchanges.set("code-2", {
      state: "the-real-state",
      appId: alpha.id,
      cookieValue: "unused",
      expiresAt: new Date("2026-09-07T21:00:00.000Z").toISOString(),
    });
    const { req, params } = call({
      path: "/_zenith/auth/callback?code=code-2&state=someone-elses-state",
      accept: "text/html",
    });
    const res = await handleGateway(req, params);
    expect(res.headers.get("location")).toBe("/_zenith/auth/signin?error=forbidden");
  });

  it("bounces a callback with no code at all", async () => {
    const { req, params } = call({ path: "/_zenith/auth/callback", accept: "text/html" });
    const res = await handleGateway(req, params);
    expect(res.headers.get("location")).toBe("/_zenith/auth/signin?error=invalid_input");
  });
});

describe("signing out", () => {
  it("refuses a cross-site sign-out", async () => {
    const { req, params } = call({
      path: "/_zenith/auth/signout",
      method: "POST",
      cookie: sessionCookie(OWNER_COOKIE),
    });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(403);
    expect((await errorBody(res)).code).toBe("csrf_rejected");
    expect(doubles.state.terminated).toEqual([]);
  });

  it("terminates the session and clears the cookie from the app's own page", async () => {
    const { req, params } = call({
      path: "/_zenith/auth/signout",
      method: "POST",
      origin: ORIGIN,
      cookie: sessionCookie(OWNER_COOKIE),
    });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/_zenith/auth/signin");
    expect(doubles.state.terminated).toEqual([OWNER_COOKIE]);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-zenith_app=;");
    expect(cookie).toContain("Max-Age=0");
  });

  it("answers 405 with allow for a GET", async () => {
    const { req, params } = call({ path: "/_zenith/auth/signout", origin: ORIGIN });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("the session document", () => {
  it("says who the recipient is, where they came from and what the bounds are", async () => {
    const { req, params } = call({
      path: "/_zenith/session",
      accept: "application/json",
      cookie: sessionCookie(OWNER_COOKIE),
    });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(200);

    const info = (await res.json()) as SessionInfo;
    expect(info.subject).toBe(IDENTITIES.owner.subject);
    expect(info.email).toBe(IDENTITIES.owner.email);
    expect(info.role).toBe("owner");
    expect(info.app).toEqual({ id: alpha.id, slug: "alpha", name: "Alpha equipment tracker" });
    expect(info.controlOrigin).toBe(CONTROL_ORIGIN);
    expect(info.releaseId).toBe(release.id);
    expect(info.schemaVersion).toBe(1);
    expect(info.limits).toEqual({ listMax: 100, bodyBytes: 1_048_576 });
    expect(info.expiresAt).toBe("2026-09-07T21:00:00.000Z");
    expect(res.headers.get("x-zenith-release")).toBe(release.id);
  });

  it("needs a session, like everything else behind admission", async () => {
    const { req, params } = call({ path: "/_zenith/session", accept: "application/json" });
    expect((await handleGateway(req, params)).status).toBe(401);
  });

  it("records the opening once per session and day", async () => {
    for (let i = 0; i < 3; i++) {
      const { req, params } = call({
        path: "/_zenith/session",
        accept: "application/json",
        cookie: sessionCookie(OWNER_COOKIE),
      });
      await handleGateway(req, params);
    }
    const opened = doubles.state.events.filter((e) => e.event === "app.opened");
    expect(opened.length).toBe(3);
    // The gateway hands the same logical id every time; de-duplication is the
    // events module's job (W8), and this is the key it gets to do it with.
    expect(new Set(opened.map((e) => e.logicalId)).size).toBe(1);
  });
});

describe("health", () => {
  it("reports real checks, attributed to the release that answered", async () => {
    const { req, params } = call({
      path: "/_zenith/health",
      accept: "application/json",
      cookie: sessionCookie(OWNER_COOKIE),
    });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      simulated: boolean;
      release: { id: string; number: number; digest: string };
      app: { slug: string; state: string };
      runtime: { id: string; label: string };
      checks: { id: string; ok: boolean; detail: string }[];
    };
    expect(body.simulated).toBe(false);
    expect(body.release).toEqual({ id: release.id, number: release.number, digest: artifact.digest });
    expect(body.app).toEqual({ slug: "alpha", state: "active" });
    expect(body.runtime.id).toBe("local");
    expect(body.runtime.label).toContain("no CPU/subrequest limits");

    const byId = Object.fromEntries(body.checks.map((c) => [c.id, c]));
    expect(byId["artifact.verified"].ok).toBe(true);
    expect(byId["data.schemaVersion"].ok).toBe(true);
    expect(byId["data.schemaVersion"].detail).toContain("schema version 1");
    expect(byId["runtime.available"].ok).toBe(true);
  });
});
