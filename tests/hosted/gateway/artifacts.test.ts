/**
 * Step 9: serving the bytes — and every way a careless gateway hands them to
 * someone it already refused.
 *
 * `HEAD`, `Range` and a conditional request are all implemented on the far
 * side of admission, so each of them is tested twice here: once admitted (it
 * works) and once not (it is a 401 with the sentinel at zero).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { IDENTITIES, isolatedDataDir, removeDir } from "../_fixtures";
import {
  BUILT_FILES,
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

const DATA_DIR = isolatedDataDir("zenith-gateway-artifacts-");

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { FsArtifactStore } = await import("@/lib/hosted/artifacts");
const { hostedConfig } = await import("@/lib/hosted/config");
const { closeAllAppData } = await import("@/lib/hosted/data");
const { gatewayTelemetry, handleGateway, resetGatewayDeps, resetGatewayTelemetry, setGatewayDepsForTests } =
  await import("@/lib/hosted/gateway");

const authority = openAuthority();
const store = new FsArtifactStore(hostedConfig().artifactDir);
const artifact = await store.put(writeBuiltTree(DATA_DIR), provenance("job-artifacts"));
seedArtifactRow(authority, artifact.digest, artifact.byteSize, artifact.fileCount);

const alpha = seedApp(authority, { slug: "alpha" });
const release = seedActiveRelease(authority, alpha, artifact.digest);

const doubles = makeDoubles();
const COOKIE = "live-owner";

beforeEach(() => {
  resetGatewayDeps();
  setGatewayDepsForTests(doubles.deps);
  resetGatewayTelemetry();
  doubles.state.sessions.clear();
  doubles.state.sessions.set(
    COOKIE,
    resolved(alpha, { subject: IDENTITIES.owner.subject, email: IDENTITIES.owner.email, role: "owner" })
  );
});

afterAll(() => {
  resetGatewayDeps();
  closeAllAppData();
  closeAuthority();
  removeDir(DATA_DIR);
});

/** An admitted call. */
const admitted = (path: string, extra: Parameters<typeof call>[0] = {}) =>
  call({ path, cookie: sessionCookie(COOKIE), ...extra });

const scriptEtag = async (): Promise<string> => {
  const files = await store.list(artifact.digest);
  const file = files.find((f) => f.path === "assets/app-abc123.js");
  return `"${file?.sha256}"`;
};

describe("the page", () => {
  it("serves index.html at the root, guarded and attributed", async () => {
    const { req, params } = admitted("/");
    const res = await handleGateway(req, params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-zenith-release")).toBe(release.id);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(BUILT_FILES["index.html"]);
    expect(gatewayTelemetry.artifactServed).toBe(1);
  });

  it("falls back to index.html for an app route with no extension", async () => {
    const { req, params } = admitted("/requests/123");
    const res = await handleGateway(req, params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(BUILT_FILES["index.html"]);
  });
});

describe("assets", () => {
  it("serves a hashed script with its own type and a cacheable policy", async () => {
    const { req, params } = admitted("/assets/app-abc123.js");
    const res = await handleGateway(req, params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300, immutable");
    expect(res.headers.get("etag")).toBe(await scriptEtag());
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe(BUILT_FILES["assets/app-abc123.js"]);
  });

  it("does not let an unhashed asset be cached under a name that can change", async () => {
    const { req, params } = admitted("/assets/logo.svg");
    const res = await handleGateway(req, params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 404 for a file this release does not contain", async () => {
    const { req, params } = admitted("/missing.js");
    const res = await handleGateway(req, params);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe("not_found");
    expect(gatewayTelemetry.artifactServed).toBe(0);
  });

  it("answers 404 for a traversal, admitted or not", async () => {
    const { req, params } = admitted("/x", { segments: ["..", "secret"] });
    expect((await handleGateway(req, params)).status).toBe(404);
    expect(gatewayTelemetry.artifactServed).toBe(0);
  });
});

describe("HEAD", () => {
  it("answers the headers of the file and no body", async () => {
    const { req, params } = admitted("/assets/app-abc123.js", { method: "HEAD" });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(res.headers.get("content-length")).toBe(String(BUILT_FILES["assets/app-abc123.js"].length));
    expect(await res.text()).toBe("");
  });

  it("is refused without a session, like any other read", async () => {
    const { req, params } = call({ path: "/assets/app-abc123.js", method: "HEAD" });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(401);
    expect(gatewayTelemetry.artifactServed).toBe(0);
  });
});

describe("Range", () => {
  const script = BUILT_FILES["assets/app-abc123.js"];

  it("answers a single byte range with 206 and the exact slice", async () => {
    const { req, params } = admitted("/assets/app-abc123.js", { headers: { range: "bytes=0-4" } });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-4/${script.length}`);
    expect(res.headers.get("content-length")).toBe("5");
    expect(await res.text()).toBe(script.slice(0, 5));
  });

  it("answers a suffix range from the end", async () => {
    const { req, params } = admitted("/assets/app-abc123.js", { headers: { range: "bytes=-6" } });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(206);
    expect(await res.text()).toBe(script.slice(-6));
  });

  it("answers 416 for a range past the end, and for a multi-range request", async () => {
    for (const range of [`bytes=${script.length + 10}-`, "bytes=0-2,5-7", "items=0-1", "bytes=-0"]) {
      const { req, params } = admitted("/assets/app-abc123.js", { headers: { range } });
      const res = await handleGateway(req, params);
      expect(res.status, range).toBe(416);
      expect(res.headers.get("content-range"), range).toBe(`bytes */${script.length}`);
      expect(await res.text()).toBe("");
    }
  });

  it("is refused without a session", async () => {
    const { req, params } = call({ path: "/assets/app-abc123.js", headers: { range: "bytes=0-4" } });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(401);
    expect(gatewayTelemetry.artifactServed).toBe(0);
  });
});

describe("conditional requests", () => {
  it("answers 304 when the caller already holds these exact bytes", async () => {
    const etag = await scriptEtag();
    const { req, params } = admitted("/assets/app-abc123.js", {
      headers: { "if-none-match": etag },
    });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  it("accepts a weak tag and a list, and ignores a tag for other bytes", async () => {
    const etag = await scriptEtag();
    const weak = admitted("/assets/app-abc123.js", { headers: { "if-none-match": `W/${etag}` } });
    expect((await handleGateway(weak.req, weak.params)).status).toBe(304);

    const list = admitted("/assets/app-abc123.js", {
      headers: { "if-none-match": `"other", ${etag}` },
    });
    expect((await handleGateway(list.req, list.params)).status).toBe(304);

    const other = admitted("/assets/app-abc123.js", { headers: { "if-none-match": '"nope"' } });
    expect((await handleGateway(other.req, other.params)).status).toBe(200);
  });

  it("is refused without a session", async () => {
    const { req, params } = call({
      path: "/assets/app-abc123.js",
      headers: { "if-none-match": await scriptEtag() },
    });
    const res = await handleGateway(req, params);
    expect(res.status).toBe(401);
    expect(gatewayTelemetry.artifactServed).toBe(0);
  });
});
