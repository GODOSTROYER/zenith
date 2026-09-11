/**
 * The response guard: the promise that holds on every response, including the
 * ones nobody looks at.
 *
 * Two halves. The unit half drives `applyResponseGuard` directly with a
 * hostile response — the one an artifact could hypothetically become if the
 * store ever grew a header path — and checks what survives. The end-to-end
 * half walks every status the gateway can produce and asserts the same set of
 * headers on all of them.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { IDENTITIES, isolatedDataDir, removeDir } from "../_fixtures";
import {
  appHost,
  appOrigin,
  call,
  headerMap,
  makeDoubles,
  provenance,
  resolved,
  seedActiveRelease,
  seedApp,
  seedArtifactRow,
  sessionCookie,
  writeBuiltTree,
} from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-gateway-guard-");

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { FsArtifactStore } = await import("@/lib/hosted/artifacts");
const { hostedConfig } = await import("@/lib/hosted/config");
const { closeAllAppData } = await import("@/lib/hosted/data");
const {
  applyResponseGuard,
  GATEWAY_CSP,
  GATEWAY_SECURITY_HEADERS,
  handleGateway,
  isHashedAssetPath,
  resetGatewayDeps,
  resetGatewayTelemetry,
  setGatewayDepsForTests,
} = await import("@/lib/hosted/gateway");

const authority = openAuthority();
const store = new FsArtifactStore(hostedConfig().artifactDir);
const artifact = await store.put(await writeBuiltTree(DATA_DIR), provenance("job-guard"));
await seedArtifactRow(authority, artifact.digest, artifact.byteSize, artifact.fileCount);

const alpha = await seedApp(authority, { slug: "alpha" });
await seedApp(authority, { slug: "paused", state: "suspended" });
await seedActiveRelease(authority, alpha, artifact.digest);

const doubles = await makeDoubles();
const COOKIE = "guard-owner";

beforeEach(async () => {
  await resetGatewayDeps();
  await setGatewayDepsForTests(doubles.deps);
  await resetGatewayTelemetry();
  doubles.state.quotaAllowed = true;
  doubles.state.sessions.clear();
  doubles.state.sessions.set(
    COOKIE,
    await resolved(alpha, { subject: IDENTITIES.owner.subject, email: IDENTITIES.owner.email, role: "owner" })
  );
});

afterAll(async () => {
  await resetGatewayDeps();
  await closeAllAppData();
  closeAuthority();
  removeDir(DATA_DIR);
});

describe("applyResponseGuard", () => {
  it("strips a set-cookie, a location, a link and every access-control header it did not set", async () => {
    const hostile = new Response("x", {
      headers: {
        "set-cookie": "steal=1",
        location: "https://evil.example",
        link: "</evil.js>; rel=preload",
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
        "content-type": "text/plain",
      },
    });
    const guarded = await applyResponseGuard(hostile, { cache: "no-store" });
    const headers = await headerMap(guarded);

    expect(headers["set-cookie"]).toBeUndefined();
    expect(headers.location).toBeUndefined();
    expect(headers.link).toBeUndefined();
    expect(headers["access-control-allow-origin"]).toBeUndefined();
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
    // Content headers are not the guard's business and are left alone.
    expect(headers["content-type"]).toBe("text/plain");
    expect(await guarded.text()).toBe("x");
  });

  it("sets the whole security header set and the cache policy it was told", async () => {
    const guarded = await applyResponseGuard(new Response(null, { status: 204 }), {
      cache: "immutable",
      releaseId: "rel-1",
    });
    for (const [name, value] of Object.entries(GATEWAY_SECURITY_HEADERS))
      expect(guarded.headers.get(name), name).toBe(value);
    expect(guarded.headers.get("cache-control")).toBe("private, max-age=300, immutable");
    expect(guarded.headers.get("x-zenith-release")).toBe("rel-1");
    expect(guarded.headers.get("content-security-policy")).toBe(GATEWAY_CSP);
  });

  it("never leaks the ownership marker it uses to decide", async () => {
    const marked = new Response(null, {
      status: 303,
      headers: { location: "/", "x-zenith-owned": "location" },
    });
    const guarded = await applyResponseGuard(marked, { cache: "no-store" });
    expect(guarded.headers.get("location")).toBe("/");
    expect(guarded.headers.get("x-zenith-owned")).toBeNull();
  });
});

describe("isHashedAssetPath", () => {
  it("caches only names that change with their bytes", async () => {
    for (const hashed of ["assets/app-abc123.js", "assets/index-4f2a9c1b.css", "assets/chunk/vendor-9a8b7c6d.js"])
      expect(await isHashedAssetPath(hashed), hashed).toBe(true);
    for (const plain of ["index.html", "assets/logo.svg", "assets/app.js", "favicon.ico", "assets/a-b.js"])
      expect(await isHashedAssetPath(plain), plain).toBe(false);
  });
});

describe("every response the gateway returns", () => {
  const cases: { what: string; make: () => Promise<Response>; status: number }[] = [
    {
      what: "an unknown host",
      status: 404,
      make: async () => {
        const c = await call({ host: "nosuch.apps.localhost:3400" });
        return handleGateway(c.req, c.params);
      },
    },
    {
      what: "a suspended app",
      status: 423,
      make: async () => {
        const c = await call({ host: await appHost("paused") });
        return handleGateway(c.req, c.params);
      },
    },
    {
      what: "a request with no session",
      status: 401,
      make: async () => {
        const c = await call({ accept: "application/json" });
        return handleGateway(c.req, c.params);
      },
    },
    {
      what: "a cross-site write",
      status: 403,
      make: async () => {
        const c = await call({
          path: "/_zenith/data/v1/requests",
          method: "POST",
          cookie: await sessionCookie(COOKIE),
          origin: await appOrigin("beta"),
          accept: "application/json",
          body: "{}",
        });
        return handleGateway(c.req, c.params);
      },
    },
    {
      what: "a missing file",
      status: 404,
      make: async () => {
        const c = await call({ path: "/missing.js", cookie: await sessionCookie(COOKIE) });
        return handleGateway(c.req, c.params);
      },
    },
    {
      what: "a served page",
      status: 200,
      make: async () => {
        const c = await call({ path: "/", cookie: await sessionCookie(COOKIE) });
        return handleGateway(c.req, c.params);
      },
    },
    {
      what: "a served hashed asset",
      status: 200,
      make: async () => {
        const c = await call({ path: "/assets/app-abc123.js", cookie: await sessionCookie(COOKIE) });
        return handleGateway(c.req, c.params);
      },
    },
    {
      what: "a redirect to the sign-in page",
      status: 303,
      make: async () => {
        const c = await call({ accept: "text/html" });
        return handleGateway(c.req, c.params);
      },
    },
    {
      what: "a method that is not answered",
      status: 405,
      make: async () => {
        const c = await call({ method: "DELETE" });
        return handleGateway(c.req, c.params);
      },
    },
  ];

  for (const { what, make, status } of cases) {
    it(`carries the guard on ${what}`, async () => {
      const res = await make();
      expect(res.status).toBe(status);
      const headers = await headerMap(res);
      for (const [name, value] of Object.entries(GATEWAY_SECURITY_HEADERS))
        expect(headers[name], `${what} / ${name}`).toBe(value);
      expect(headers["cache-control"], what).toMatch(/^private, /);
      for (const forbidden of Object.keys(headers))
        expect(forbidden.startsWith("access-control-"), `${what} sent ${forbidden}`).toBe(false);
    });
  }

  it("marks everything except a hashed asset no-store", async () => {
    for (const { what, make } of cases) {
      const res = await make();
      const cache = res.headers.get("cache-control");
      if (what === "a served hashed asset") expect(cache).toBe("private, max-age=300, immutable");
      else expect(cache, what).toBe("private, no-store");
    }
  });

  it("lets no served artifact set a cookie", async () => {
    for (const path of ["/", "/assets/app-abc123.js", "/assets/logo.svg", "/requests/1"]) {
      const c = await call({ path, cookie: await sessionCookie(COOKIE) });
      const res = await handleGateway(c.req, c.params);
      expect(res.headers.get("set-cookie"), path).toBeNull();
    }
  });

  it("answers a 503 with the guard when the authority cannot be reached", async () => {
    closeAuthority();
    try {
      const c = await call({ path: "/" });
      const res = await handleGateway(c.req, c.params);
      expect(res.status).toBe(503);
      const headers = await headerMap(res);
      for (const [name, value] of Object.entries(GATEWAY_SECURITY_HEADERS)) expect(headers[name]).toBe(value);
      expect(headers["cache-control"]).toBe("private, no-store");
    } finally {
      openAuthority();
    }
  });
});
