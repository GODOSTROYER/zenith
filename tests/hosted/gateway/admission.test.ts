/**
 * Steps 1 to 5: which host, which app, what state, how many requests, and what
 * happens when the authority cannot answer at all.
 *
 * Every case here is a refusal, so every case also asserts the invocation
 * sentinel: a request that was turned away must not have opened an artifact or
 * called the broker, whatever else it did.
 *
 * Workstream W6 (hosted R3).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";
import {
  appHost,
  call,
  errorBody,
  makeDoubles,
  provenance,
  seedActiveRelease,
  seedApp,
  seedArtifactRow,
  writeBuiltTree,
} from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-gateway-admission-");

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { FsArtifactStore } = await import("@/lib/hosted/artifacts");
const { hostedConfig } = await import("@/lib/hosted/config");
const { closeAllAppData } = await import("@/lib/hosted/data");
const { gatewayTelemetry, handleGateway, resetGatewayDeps, resetGatewayTelemetry, setGatewayDepsForTests } =
  await import("@/lib/hosted/gateway");

let authority = openAuthority();
const store = new FsArtifactStore(hostedConfig().artifactDir);
const artifact = await store.put(writeBuiltTree(DATA_DIR), provenance("job-admission"));
seedArtifactRow(authority, artifact.digest, artifact.byteSize, artifact.fileCount);

const alpha = seedApp(authority, { slug: "alpha" });
seedApp(authority, { slug: "paused", state: "suspended" });
seedApp(authority, { slug: "restoring", state: "recovering" });
const removed = seedApp(authority, { slug: "removed" });
seedActiveRelease(authority, alpha, artifact.digest);
authority.tx(() => authority.repos.apps.update(removed.id, { state: "deleted" }));

const doubles = makeDoubles();

beforeEach(() => {
  resetGatewayDeps();
  setGatewayDepsForTests(doubles.deps);
  resetGatewayTelemetry();
  doubles.state.quotaAllowed = true;
  doubles.state.counted.length = 0;
  doubles.state.events.length = 0;
});

afterAll(() => {
  resetGatewayDeps();
  closeAllAppData();
  closeAuthority();
  removeDir(DATA_DIR);
});

/** Nothing was invoked. Asserted after every refusal in this file. */
const nothingInvoked = (): void => {
  expect(gatewayTelemetry.artifactServed).toBe(0);
  expect(gatewayTelemetry.brokerInvoked).toBe(0);
};

describe("step 1 — the host", () => {
  it("refuses a host that names no app, without saying which apps exist", async () => {
    const { req, params } = call({ host: "nosuchapp.apps.localhost:3400" });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("unknown_host");
    nothingInvoked();
  });

  it("refuses a direct request on the control origin", async () => {
    // What a curl of http://localhost:3400/hosted-gateway/alpha.apps.localhost/
    // looks like once it reaches the route: the Host header is the control
    // origin's, and no app is served on that name.
    const { req } = call({ host: "localhost:3400" });
    const res = await handleGateway(req, { host: appHost("alpha"), path: undefined });
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("unknown_host");
    nothingInvoked();
  });

  it("refuses when the Host header and the route parameter disagree", async () => {
    const { req, params } = call({ host: appHost("alpha"), paramHost: appHost("beta") });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("unknown_host");
    nothingInvoked();
  });

  it("accepts the encoded host the rewrite actually produces, and folds case", async () => {
    doubles.state.sessions.set("live", {
      session: { id: "s1", appId: alpha.id, subject: "sub", grantId: "g1", createdAt: "", expiresAt: "" },
      grant: {
        id: "g1",
        appId: alpha.id,
        subject: "sub",
        email: "o@example.test",
        role: "owner",
        state: "active",
        grantedBy: "sub",
        createdAt: "",
        updatedAt: "",
      },
    });
    const { req } = call({ host: `ALPHA.apps.localhost:3400`, cookie: "__Host-zenith_app=live" });
    const res = await handleGateway(req, { host: encodeURIComponent(appHost("alpha")), path: undefined });
    expect(res.status).toBe(200);
    doubles.state.sessions.clear();
  });
});

describe("step 2 — the app", () => {
  it("answers a deleted app exactly as it answers an unknown one", async () => {
    const { req, params } = call({ host: appHost("removed") });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("unknown_host");
    nothingInvoked();
  });
});

describe("step 3 — the app's state", () => {
  it("answers a suspended app 423, as a page for a browser", async () => {
    const { req, params } = call({ host: appHost("paused"), accept: "text/html,*/*" });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(423);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("paused");
    expect(body).not.toContain("<script");
    nothingInvoked();
  });

  it("answers a suspended app 423 as JSON for a program", async () => {
    const { req, params } = call({ host: appHost("paused"), accept: "application/json" });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(423);
    const error = await errorBody(res);
    expect(error.code).toBe("suspended");
    expect(error.fix).toContain("resume");
    nothingInvoked();
  });

  it("still renders the sign-in page of a suspended app", async () => {
    const { req, params } = call({
      host: appHost("paused"),
      path: "/_zenith/auth/signin",
      accept: "text/html",
    });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Open this app from Zenith");
  });

  it("answers a recovering app 423 with its own code", async () => {
    const { req, params } = call({ host: appHost("restoring") });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(423);
    expect((await errorBody(res)).code).toBe("recovering");
    nothingInvoked();
  });
});

describe("step 4 — the daily quota", () => {
  it("counts a request that was refused for another reason", async () => {
    const { req, params } = call({ path: "/" });
    await handleGateway(req, params);
    expect(doubles.state.counted).toEqual([alpha.id]);
  });

  it("does not count a request that never resolved to an app", async () => {
    const { req, params } = call({ host: "nosuchapp.apps.localhost:3400" });
    await handleGateway(req, params);
    expect(doubles.state.counted).toEqual([]);
  });

  it("refuses over the cap with retry-after pointing at the next UTC midnight", async () => {
    doubles.state.quotaAllowed = false;
    const { req, params } = call({ path: "/" });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(429);
    const error = await errorBody(res);
    expect(error.code).toBe("quota_exceeded");
    expect(error.details?.limit).toBe(10_000);

    const retryAfter = Number(res.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);
    nothingInvoked();
  });
});

describe("step 5 — the authority", () => {
  it("answers 503 when the control authority is not open, and never serves anyway", async () => {
    closeAuthority();
    try {
      const { req, params } = call({ path: "/" });
      const res = await handleGateway(req, params);
      expect(res.status).toBe(503);
      const error = await errorBody(res);
      expect(error.code).toBe("policy_unavailable");
      expect(error.fix).toBeTruthy();
      nothingInvoked();
    } finally {
      authority = openAuthority();
    }
  });
});

describe("paths the gateway will not interpret", () => {
  it("refuses a traversal segment", async () => {
    const { req, params } = call({ path: "/x", segments: ["..", "secret"] });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("not_found");
    nothingInvoked();
  });

  it("refuses an empty segment, a backslash and a NUL", async () => {
    for (const segments of [["", "x"], ["a\\b"], ["a b"]]) {
      const { req, params } = call({ path: "/x", segments });
      const res = await handleGateway(req, params);
      expect(res.status, segments.join("|")).toBe(404);
    }
    nothingInvoked();
  });

  it("counts those requests before refusing them", async () => {
    const { req, params } = call({ path: "/x", segments: ["..", "secret"] });
    await handleGateway(req, params);
    expect(doubles.state.counted).toEqual([alpha.id]);
  });
});
