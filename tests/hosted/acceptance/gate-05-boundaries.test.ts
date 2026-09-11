/**
 * Gate 5 — no platform secret reaches a build or an artifact, the response
 * guard is on every kind of answer, cross-origin writes are refused, and the
 * limits this runtime does *not* enforce are named rather than implied.
 *
 * The secret test is done the way it has to be done to mean anything: five
 * decoy variables with values that appear nowhere else in the repository are
 * put in this process's environment **before** the build runs, and every byte
 * of the resulting artifact is then searched for them. A build that inlined an
 * environment variable would put the value in the bundle; a build that read one
 * at random would be caught by the same scan.
 *
 * The egress half is deliberately an honest negative. The local runtime serves
 * static files and runs the fixed broker in this process; it has no network
 * namespace of its own and therefore enforces no egress policy. What it does
 * have is a CSP that stops a *page* from reaching another origin, and an
 * enforcement table that says which ceilings are real here. Both are asserted;
 * neither is described as more than it is.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactStore, HostedApp } from "@/lib/hosted/contracts";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import {
  acceptanceEnv,
  appHost,
  appOrigin,
  call,
  closeHosted,
  errorBody,
  headerMap,
  loadHosted,
  publishOrThrow,
  readStoredFiles,
  releaseOf,
  signIn,
  type HostedModules,
} from "./_journey";

const DATA = isolatedDataDir("zenith-w10-gate05-");
acceptanceEnv(DATA);

/**
 * Decoys, planted before anything is imported or built.
 *
 * Each value is a nonsense string that exists nowhere else, so a hit in an
 * artifact is proof of travel rather than a coincidence of vocabulary.
 */
const DECOYS: Record<string, string> = {
  ZENITH_DECOY_SECRET: "zenith-decoy-8f31d0a2c7b94e56",
  SUPABASE_DECOY_SERVICE_ROLE: "supabase-decoy-4c1e77b9aa0d2f38",
  ZENITH_DECOY_TOKEN: "zenith-decoy-b62a95c0e14d7f83",
  E2B_DECOY_API_KEY: "e2b-decoy-19d4f8ca63b70e25",
  AWS_DECOY_SECRET_ACCESS_KEY: "aws-decoy-77b3e0916cad4528",
  NEXT_PUBLIC_DECOY: "next-public-decoy-2a6f14bd85c39e70",
};
for (const [name, value] of Object.entries(DECOYS)) process.env[name] = value;

let m: HostedModules;
let store: ArtifactStore;
let app: HostedApp;
let digest = "";
let cookie = "";
let releaseId = "";

const OWNER = IDENTITIES.owner;
const HOST = appHost("alpha");
const ORIGIN = appOrigin("alpha");

beforeAll(async () => {
  m = await loadHosted();
  m.authority.openAuthority();
  store = new m.artifacts.FsArtifactStore(m.config.hostedConfig().artifactDir);
  app = await m.release.createApp({
    workspaceId: WORKSPACES.one.id,
    slug: "alpha",
    name: "Alpha equipment tracker",
    createdBy: OWNER.subject,
    email: OWNER.email,
  });
  // The tracker fixture, because it is the one with real application code that
  // could plausibly reference an environment variable.
  const job = await publishOrThrow(m, {
    app,
    actor: OWNER.subject,
    source: { kind: "fixture", name: "tracker-app" },
  });
  ({ digest, releaseId } = releaseOf(job));
  cookie = await signIn(m, app, OWNER.subject);
}, 300_000);

afterAll(() => {
  for (const name of Object.keys(DECOYS)) delete process.env[name];
  closeHosted(m);
  removeDir(DATA);
});

describe("Gate 5 — secrets, headers, CSRF and the limits that are not enforced here", () => {
  it("carried none of the six decoy variables into the build output", () => {
    const files = readStoredFiles(m.config.hostedConfig().artifactDir, digest);
    expect(files.length, "the artifact must actually have files to search").toBeGreaterThan(2);

    const hits: string[] = [];
    for (const file of files) {
      const text = file.bytes.toString("latin1");
      for (const [name, value] of Object.entries(DECOYS))
        if (text.includes(value)) hits.push(`${file.path} contains ${name}`);
      // The one real secret this process holds is checked by value too.
      if (text.includes("1".repeat(64))) hits.push(`${file.path} contains ZENITH_SECRET_KEY`);
    }
    expect(hits, `expected no secret in the artifact, found: ${hits.join("; ")}`).toEqual([]);
  });

  it("did not carry the variables' names either, so nothing can read them at runtime", () => {
    const files = readStoredFiles(m.config.hostedConfig().artifactDir, digest);
    const names = Object.keys(DECOYS);
    const hits = files.flatMap((file) => {
      const text = file.bytes.toString("latin1");
      return names.filter((name) => text.includes(name)).map((name) => `${file.path}: ${name}`);
    });
    expect(hits, `variable names found in the artifact: ${hits.join("; ")}`).toEqual([]);
  });

  it("hands the build child no variable with a forbidden prefix", () => {
    const child = m.build.buildChildEnv();
    expect(m.build.secretEnvKeys(Object.keys(child)), "the child environment").toEqual([]);
    expect(Object.keys(child).sort(), "and it is only PATH and an emptied NODE_OPTIONS").toEqual([
      "NODE_OPTIONS",
      "PATH",
    ]);
    expect(child.NODE_OPTIONS, "an inherited --require would be code injection").toBe("");
  });

  it("records the boundary the build actually had, rather than implying one", () => {
    const provenance = m.authority.authority().repos.artifacts.get(digest)?.provenance;
    expect(provenance?.builtBy).toBe("recipe-local");
    expect(provenance?.buildBoundary, "the runner names what it is not").toContain(
      "not a hostile-code sandbox"
    );
    expect(provenance?.buildBoundary).toContain("separate child process");
  });

  /* ------------------------------- headers ------------------------------- */

  it("puts the same security headers on every kind of response", async () => {
    const files = await store.list(digest);
    const asset = files.find((file) => /^assets\/.+\.js$/.test(file.path))?.path as string;

    const cases: { name: string; options: Parameters<typeof call>[0]; status: number }[] = [
      { name: "HTML page", options: { host: HOST, path: "/", cookie, accept: "text/html" }, status: 200 },
      { name: "hashed asset", options: { host: HOST, path: `/${asset}`, cookie }, status: 200 },
      {
        name: "reserved JSON",
        options: { host: HOST, path: "/_zenith/session", cookie, accept: "application/json" },
        status: 200,
      },
      {
        name: "range",
        options: { host: HOST, path: `/${asset}`, cookie, headers: { range: "bytes=0-9" } },
        status: 206,
      },
      {
        name: "unsatisfiable range",
        options: { host: HOST, path: `/${asset}`, cookie, headers: { range: "bytes=99-1" } },
        status: 416,
      },
      { name: "401", options: { host: HOST, path: "/", accept: "application/json" }, status: 401 },
      {
        name: "404 (unknown app path)",
        options: { host: HOST, path: "/nothing/here.txt", cookie, accept: "application/json" },
        status: 404,
      },
      {
        name: "404 (unknown host)",
        options: { host: "localhost:3400", paramHost: HOST, path: "/", accept: "application/json" },
        status: 404,
      },
      {
        name: "405",
        options: { host: HOST, path: "/", method: "DELETE", cookie, accept: "application/json" },
        status: 405,
      },
    ];

    for (const one of cases) {
      const built = call(one.options);
      const res = await m.gateway.handleGateway(built.req, built.params);
      expect(res.status, `${one.name} status`).toBe(one.status);
      const headers = headerMap(res);
      for (const [name, value] of Object.entries(m.gateway.GATEWAY_SECURITY_HEADERS))
        expect(headers[name], `${one.name} is missing ${name}`).toBe(value);
      expect(headers["cache-control"], `${one.name} cache-control`).toBeTruthy();
    }
  });

  it("states the content policy the contract names, including the one concession", () => {
    const csp = m.gateway.GATEWAY_CSP;
    for (const directive of [
      "default-src 'self'",
      "connect-src 'self'",
      "script-src 'self'",
      "img-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ])
      expect(csp, `CSP must carry ${directive}`).toContain(directive);
    // Named rather than hidden: the recipe emits inline React styles.
    expect(csp, "the one relaxation, stated").toContain("style-src 'self' 'unsafe-inline'");
    expect(csp, "scripts are never relaxed").not.toMatch(/script-src[^;]*unsafe/);
  });

  it("caches only what is safe to cache", async () => {
    const files = await store.list(digest);
    const hashed = files.find((file) => /^assets\/.+-[0-9A-Za-z_-]{6,}\.js$/.test(file.path))?.path as string;

    const page = call({ host: HOST, path: "/", cookie, accept: "text/html" });
    expect((await m.gateway.handleGateway(page.req, page.params)).headers.get("cache-control")).toBe(
      "private, no-store"
    );
    const asset = call({ host: HOST, path: `/${hashed}`, cookie });
    expect((await m.gateway.handleGateway(asset.req, asset.params)).headers.get("cache-control")).toBe(
      "private, max-age=300, immutable"
    );
    const unhashed = call({ host: HOST, path: "/favicon.svg", cookie });
    const res = await m.gateway.handleGateway(unhashed.req, unhashed.params);
    expect(res.status, "the fixture ships an unhashed favicon").toBe(200);
    expect(res.headers.get("cache-control"), "an unhashed file may not be cached").toBe(
      "private, no-store"
    );
  });

  /* --------------------------------- CSRF -------------------------------- */

  it("refuses a write that does not carry this app's own origin", async () => {
    const body = () => JSON.stringify({ writeId: uuid(), record: { title: "X", category: "laptop" } });
    const attempts: { name: string; origin?: string; headers?: Record<string, string> }[] = [
      { name: "no Origin at all" },
      { name: "a foreign origin", origin: "https://evil.example" },
      { name: "a sibling app's origin", origin: appOrigin("beta") },
      { name: "the control origin", origin: "http://localhost:3400" },
      { name: "the right origin on https", origin: "https://alpha.apps.localhost:3400" },
      {
        name: "the right origin with Sec-Fetch-Site: cross-site",
        origin: ORIGIN,
        headers: { "sec-fetch-site": "cross-site" },
      },
    ];

    for (const attempt of attempts) {
      m.gateway.resetGatewayTelemetry();
      const one = call({
        host: HOST,
        path: "/_zenith/data/v1/requests",
        method: "POST",
        cookie,
        accept: "application/json",
        body: body(),
        ...(attempt.origin === undefined ? {} : { origin: attempt.origin }),
        ...(attempt.headers === undefined ? {} : { headers: attempt.headers }),
      });
      const res = await m.gateway.handleGateway(one.req, one.params);
      expect(res.status, `${attempt.name} must be refused`).toBe(403);
      expect((await errorBody(res)).code, `${attempt.name} code`).toBe("csrf_rejected");
      expect(
        m.gateway.gatewayTelemetry.brokerInvoked,
        `${attempt.name} must not reach the store`
      ).toBe(0);
    }

    // The same request from the app's own page is accepted, so the refusals
    // above are the check working and not the route being broken.
    const good = call({
      host: HOST,
      path: "/_zenith/data/v1/requests",
      method: "POST",
      cookie,
      origin: ORIGIN,
      accept: "application/json",
      body: body(),
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect((await m.gateway.handleGateway(good.req, good.params)).status).toBe(201);
  });

  it("requires the same origin proof to sign out", async () => {
    const foreign = call({
      host: HOST,
      path: "/_zenith/auth/signout",
      method: "POST",
      cookie,
      origin: "https://evil.example",
      accept: "application/json",
    });
    const res = await m.gateway.handleGateway(foreign.req, foreign.params);
    expect(res.status).toBe(403);
    // And the session survives an attempt that was refused.
    const still = call({ host: HOST, path: "/", cookie, accept: "application/json" });
    expect((await m.gateway.handleGateway(still.req, still.params)).status).toBe(200);
  });

  it("never reads a platform cookie on an app host", async () => {
    const withPlatformCookies = call({
      host: HOST,
      path: "/_zenith/session",
      cookie: "sb-access-token=forged; sb-refresh-token=forged; zenith-session=forged",
      accept: "application/json",
    });
    const res = await m.gateway.handleGateway(withPlatformCookies.req, withPlatformCookies.params);
    expect(res.status, "a platform cookie is not an app session").toBe(401);
    expect((await errorBody(res)).code).toBe("sign_in_required");
  });

  /* -------------------------------- egress -------------------------------- */

  it("says plainly which limits this runtime does not enforce", () => {
    const local = m.quota.enforcementFor("local");
    expect(local.requestCpuMs, "CPU milliseconds on the local runtime").toBe("not_enforced");
    expect(local.outboundSubrequests, "outbound subrequests on the local runtime").toBe("not_enforced");
    expect(m.quota.ENFORCEMENT_LABELS.not_enforced).toBe(
      "Not enforced by this runtime — shown because it applies on Cloudflare."
    );
    // The same ceilings are the provider's on Cloudflare, and reported as such.
    expect(m.quota.enforcementFor("cloudflare").outboundSubrequests).toBe("provider");

    // What the local runtime does enforce, it enforces.
    expect(local.bodyBytes).toBe("enforced");
    expect(local.requestsPerDay).toBe("enforced");
    expect(local.storageBytes).toBe("enforced");
    expect(local.buildTimeoutMs).toBe("enforced");
  });

  it("labels the local runtime as a single machine rather than a sandbox", () => {
    const runtime = m.runtime.selectedHostedRuntime();
    expect(runtime.id).toBe("local");
    expect(runtime.label, "the label must not imply isolation it does not have").toContain(
      "single host"
    );
    expect(runtime.enforcement.outboundSubrequests).toBe("not_enforced");
  });

  it("attributes everything it served to the release that served it", async () => {
    const one = call({ host: HOST, path: "/", cookie, accept: "text/html" });
    const res = await m.gateway.handleGateway(one.req, one.params);
    expect(res.headers.get("x-zenith-release")).toBe(releaseId);
  });
});
