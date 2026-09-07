/**
 * Step 7: who is allowed in.
 *
 * The three ways in are all doubles of W5's access module, because W5 owns
 * that decision — but the *consequences* are the gateway's, and they are what
 * this file pins down: a browser is sent to the page that explains how to get
 * in, a program gets a code it can branch on, and a session belonging to
 * another app is indistinguishable from no session at all.
 *
 * Workstream W6 (hosted R3).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { IDENTITIES, isolatedDataDir, removeDir } from "../_fixtures";
import {
  appHost,
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

const DATA_DIR = isolatedDataDir("zenith-gateway-session-");

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { FsArtifactStore } = await import("@/lib/hosted/artifacts");
const { hostedConfig } = await import("@/lib/hosted/config");
const { closeAllAppData } = await import("@/lib/hosted/data");
const { gatewayTelemetry, handleGateway, resetGatewayDeps, resetGatewayTelemetry, setGatewayDepsForTests } =
  await import("@/lib/hosted/gateway");

const authority = openAuthority();
const store = new FsArtifactStore(hostedConfig().artifactDir);
const artifact = await store.put(writeBuiltTree(DATA_DIR), provenance("job-session"));
seedArtifactRow(authority, artifact.digest, artifact.byteSize, artifact.fileCount);

const alpha = seedApp(authority, { slug: "alpha" });
const beta = seedApp(authority, { slug: "beta" });
const unpublished = seedApp(authority, { slug: "unpublished" });
seedActiveRelease(authority, alpha, artifact.digest);
seedActiveRelease(authority, beta, artifact.digest);

const doubles = makeDoubles();

/** A live owner session on alpha, and a live owner session on beta. */
const ALPHA_COOKIE = "cookie-for-alpha";
const BETA_COOKIE = "cookie-for-beta";
const REVOKED_COOKIE = "cookie-that-was-revoked";

beforeEach(() => {
  resetGatewayDeps();
  setGatewayDepsForTests(doubles.deps);
  resetGatewayTelemetry();
  doubles.state.events.length = 0;
  doubles.state.sessions.clear();
  doubles.state.sessions.set(
    ALPHA_COOKIE,
    resolved(alpha, { subject: IDENTITIES.owner.subject, email: IDENTITIES.owner.email, role: "owner" })
  );
  doubles.state.sessions.set(
    BETA_COOKIE,
    resolved(beta, { subject: IDENTITIES.editor.subject, email: IDENTITIES.editor.email, role: "editor" })
  );
});

afterAll(() => {
  resetGatewayDeps();
  closeAllAppData();
  closeAuthority();
  removeDir(DATA_DIR);
});

const nothingInvoked = (): void => {
  expect(gatewayTelemetry.artifactServed).toBe(0);
  expect(gatewayTelemetry.brokerInvoked).toBe(0);
};

describe("no session", () => {
  it("sends a browser to the sign-in page", async () => {
    const { req, params } = call({ accept: "text/html,application/xhtml+xml" });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/_zenith/auth/signin");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    nothingInvoked();
  });

  it("answers a program 401 with a code it can branch on", async () => {
    const { req, params } = call({ accept: "application/json", path: "/assets/app-abc123.js" });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(401);
    const error = await errorBody(res);
    expect(error.code).toBe("sign_in_required");
    expect(error.fix).toContain("Zenith");
    nothingInvoked();
  });

  it("records the denial as an event", async () => {
    const { req, params } = call({});
    await handleGateway(req, params);
    expect(doubles.state.events.map((e) => e.event)).toContain("access.denied");
    expect(doubles.state.events.find((e) => e.event === "access.denied")?.outcome).toBe("denied");
  });
});

describe("a session that is not for this app", () => {
  it("refuses beta's cookie on alpha, and says nothing about beta", async () => {
    const { req, params } = call({ cookie: sessionCookie(BETA_COOKIE) });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(401);
    const error = await errorBody(res);
    // Deliberately identical to the no-cookie refusal: a 403 here would
    // confirm that the cookie is valid somewhere, and that beta exists.
    expect(error.code).toBe("sign_in_required");
    expect(error.message).toBe("You are not signed in to this app.");
    nothingInvoked();
  });

  it("admits the same cookie on the app it was minted for", async () => {
    const { req, params } = call({ host: appHost("beta"), cookie: sessionCookie(BETA_COOKIE) });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(200);
    expect(gatewayTelemetry.artifactServed).toBe(1);
  });
});

describe("a session the authority no longer honours", () => {
  it("refuses as soon as the access module answers null", async () => {
    // What a revoked grant looks like from here: the cookie is unchanged in
    // the browser and the resolution simply stops succeeding.
    const { req: before, params } = call({ cookie: sessionCookie(ALPHA_COOKIE) });
    expect((await handleGateway(before, params)).status).toBe(200);

    doubles.state.sessions.delete(ALPHA_COOKIE);
    resetGatewayTelemetry();

    const { req: after } = call({ cookie: sessionCookie(REVOKED_COOKIE) });
    const res = await handleGateway(after, params);
    expect(res.status).toBe(401);
    nothingInvoked();
  });

  it("ignores a cookie of some other name", async () => {
    const { req, params } = call({ cookie: `sb-access-token=platform-secret; other=1` });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(401);
    nothingInvoked();
  });
});

describe("step 8 — the release", () => {
  it("answers 404 with a fix when the app has never been published", async () => {
    doubles.state.sessions.set(
      "cookie-for-unpublished",
      resolved(unpublished, {
        subject: IDENTITIES.owner.subject,
        email: IDENTITIES.owner.email,
        role: "owner",
      })
    );
    const { req, params } = call({
      host: appHost("unpublished"),
      cookie: sessionCookie("cookie-for-unpublished"),
    });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(404);
    const error = await errorBody(res);
    expect(error.code).toBe("not_found");
    expect(error.fix).toContain("Publish a release first");
    nothingInvoked();
  });
});

describe("methods app content does not answer", () => {
  it("refuses PUT, DELETE and OPTIONS with allow, without asking for a session", async () => {
    for (const method of ["PUT", "DELETE", "OPTIONS"]) {
      const { req, params } = call({ method });
      const res = await handleGateway(req, params);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET, HEAD");
      expect(res.headers.get("access-control-allow-origin"), method).toBeNull();
      expect(res.headers.get("access-control-allow-methods"), method).toBeNull();
    }
    nothingInvoked();
  });
});
