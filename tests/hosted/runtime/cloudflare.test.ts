/**
 * The Cloudflare adapter, with an injected `fetch`.
 *
 * These tests establish exactly one thing: the requests this adapter *would*
 * make are the ones the published API contracts describe, and its refusals
 * fire before any of them. They establish nothing about Cloudflare — no
 * account was contacted, and the seven feasibility gates in DECISIONS.md are
 * untouched by a green run here.
 *
 * Workstream W6 (hosted R3).
 */
import { afterAll, describe, expect, it } from "vitest";
import type { HostedError as HostedErrorType } from "@/lib/hosted/contracts";
import { isolatedDataDir, removeDir } from "../_fixtures";
import { provenance, seedActiveRelease, seedApp, seedArtifactRow, writeBuiltTree } from "../gateway/_helpers";

const DATA_DIR = isolatedDataDir("zenith-runtime-cloudflare-");

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { FsArtifactStore } = await import("@/lib/hosted/artifacts");
const { hostedConfig } = await import("@/lib/hosted/config");
const { closeAllAppData } = await import("@/lib/hosted/data");
const { CloudflareRuntime, brokerScriptName, isAllowedBrokerBindings, isAllowedReleaseBindings, releaseScriptName } =
  await import("@/lib/hosted/runtime");
const { HostedError } = await import("@/lib/hosted/contracts");

const authority = openAuthority();
const store = new FsArtifactStore(hostedConfig().artifactDir);
const artifact = await store.put(writeBuiltTree(DATA_DIR), provenance("job-cf"));
seedArtifactRow(authority, artifact.digest, artifact.byteSize, artifact.fileCount);

const app = seedApp(authority, { slug: "alpha" });
const release = seedActiveRelease(authority, app, artifact.digest);

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const NAMESPACE = "zenith-pilot";
const TOKEN = "a-token-value-long-enough-to-pass";
const DATABASE_ID = "11111111-1111-4111-8111-111111111111";
const SCRIPT = releaseScriptName("alpha", release.number, artifact.digest);
const BROKER = brokerScriptName("alpha");

afterAll(() => {
  closeAllAppData();
  closeAuthority();
  removeDir(DATA_DIR);
});

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: BodyInit | null;
}

/** A fetch that records every call and answers from a routing table. */
function recorder(routes: { match: RegExp; method?: string; answer: () => Response }[]): {
  sent: Sent[];
  fetch: (url: string, init: RequestInit) => Promise<Response>;
} {
  const sent: Sent[] = [];
  return {
    sent,
    async fetch(url, init) {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>))
        headers[name.toLowerCase()] = value;
      sent.push({ url, method: init.method ?? "GET", headers, body: init.body as BodyInit | null });
      const route = routes.find(
        (r) => r.match.test(url) && (r.method === undefined || r.method === (init.method ?? "GET"))
      );
      if (!route) return new Response(null, { status: 404 });
      return route.answer();
    },
  };
}

const ok = (result: unknown): Response =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const missing = (): Response => new Response(null, { status: 404 });

const runtime = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>, extra = {}) =>
  new CloudflareRuntime({
    accountId: ACCOUNT,
    namespace: NAMESPACE,
    token: TOKEN,
    fetch: fetchImpl,
    artifactStore: store,
    brokerModuleSource: "export default { async fetch() { return new Response('broker'); } };",
    ...extra,
  });

/** The `metadata` part of a multipart script upload, parsed. */
async function metadataOf(body: BodyInit | null | undefined): Promise<Record<string, unknown>> {
  const form = body as FormData;
  const part = form.get("metadata");
  const text = part instanceof Blob ? await part.text() : String(part);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("availability", () => {
  it("is blocked by name when nothing is configured", async () => {
    const blocked = await new CloudflareRuntime().availability();
    expect(blocked.available).toBe(false);
    expect(blocked.reason).toContain("ZENITH_CF_ACCOUNT_ID");
    expect(blocked.reason).toContain("ZENITH_CF_NAMESPACE");
    expect(blocked.reason).toContain("ZENITH_CF_API_TOKEN");
    expect(blocked.fix).toContain("dispatch namespace");
  });

  it("names only the input that is actually missing", async () => {
    const blocked = await new CloudflareRuntime({ accountId: ACCOUNT, namespace: NAMESPACE }).availability();
    expect(blocked.reason).toContain("ZENITH_CF_API_TOKEN");
    expect(blocked.reason).not.toContain("ZENITH_CF_ACCOUNT_ID");
  });

  it("makes no request at all while it is blocked", async () => {
    const { sent, fetch } = recorder([]);
    const blocked = new CloudflareRuntime({ fetch });
    await expect(blocked.ensureApp(app)).rejects.toBeInstanceOf(HostedError);
    expect(sent).toEqual([]);
  });
});

describe("ensureApp", () => {
  const routes = [
    { match: /\/d1\/database\?name=/, method: "GET", answer: () => ok([]) },
    { match: /\/d1\/database$/, method: "POST", answer: () => ok({ uuid: DATABASE_ID, name: "zenith-alpha" }) },
    { match: /\/scripts\/zenith-alpha-broker$/, method: "PUT", answer: () => ok({ id: BROKER }) },
  ];

  it("lists before it creates, then uploads the broker with exactly one D1 binding", async () => {
    const { sent, fetch } = recorder(routes);
    const ref = await runtime(fetch).ensureApp(app);

    expect(sent[0].url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database?name=zenith-alpha`
    );
    expect(sent[0].method).toBe("GET");
    expect(sent[0].headers.authorization).toBe(`Bearer ${TOKEN}`);

    expect(sent[1].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database`);
    expect(sent[1].method).toBe("POST");
    expect(JSON.parse(String(sent[1].body))).toEqual({ name: "zenith-alpha" });

    expect(sent[2].url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/${NAMESPACE}/scripts/${BROKER}`
    );
    expect(sent[2].method).toBe("PUT");
    const metadata = await metadataOf(sent[2].body);
    expect(metadata.main_module).toBe("broker.mjs");
    expect(metadata.bindings).toEqual([{ type: "d1", name: "DB", id: DATABASE_ID }]);
    expect(metadata.compatibility_date).toBe("2026-09-01");

    expect(ref).toEqual({
      runtime: "cloudflare",
      ref: {
        accountId: ACCOUNT,
        namespace: NAMESPACE,
        d1DatabaseId: DATABASE_ID,
        d1DatabaseName: "zenith-alpha",
        brokerScript: BROKER,
      },
    });
  });

  it("adopts a database that already exists rather than making a second one", async () => {
    const { sent, fetch } = recorder([
      {
        match: /\/d1\/database\?name=/,
        method: "GET",
        answer: () => ok([{ uuid: DATABASE_ID, name: "zenith-alpha" }]),
      },
      { match: /\/scripts\//, method: "PUT", answer: () => ok({ id: BROKER }) },
    ]);
    await runtime(fetch).ensureApp(app);
    expect(sent.filter((s) => s.method === "POST")).toEqual([]);
  });

  it("refuses to upload a broker it has not been given", async () => {
    const { sent, fetch } = recorder(routes);
    const bare = new CloudflareRuntime({ accountId: ACCOUNT, namespace: NAMESPACE, token: TOKEN, fetch });
    await expect(bare.ensureApp(app)).rejects.toMatchObject({ code: "runtime_unavailable" });
    // The database calls happened; the placeholder upload did not.
    expect(sent.some((s) => s.method === "PUT")).toBe(false);
  });
});

describe("stageCandidate", () => {
  const uploadRoutes = (tags: Response) => [
    { match: /\/tags$/, method: "GET", answer: () => tags },
    {
      match: /assets-upload-session$/,
      method: "POST",
      answer: () => ok({ jwt: "upload-jwt", buckets: [["a", "b"]] }),
    },
    { match: /workers\/assets\/upload/, method: "POST", answer: () => ok({ jwt: "completion-token" }) },
    { match: new RegExp(`/scripts/${SCRIPT}$`), method: "PUT", answer: () => ok({ id: SCRIPT }) },
    { match: /\/tags$/, method: "PUT", answer: () => ok(["zenith"]) },
  ];

  it("opens an upload session, sends the buckets, then uploads the script with only ASSETS", async () => {
    const { sent, fetch } = recorder(uploadRoutes(missing()));
    const ref = await runtime(fetch).stageCandidate(app, release, artifact);

    const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/${NAMESPACE}/scripts/${SCRIPT}`;
    expect(sent[0]).toMatchObject({ url: `${base}/tags`, method: "GET" });

    expect(sent[1].url).toBe(`${base}/assets-upload-session`);
    const manifest = (JSON.parse(String(sent[1].body)) as { manifest: Record<string, { hash: string; size: number }> })
      .manifest;
    expect(Object.keys(manifest).sort()).toEqual(["/assets/app-abc123.js", "/assets/logo.svg", "/index.html"]);
    for (const entry of Object.values(manifest)) expect(entry.hash).toMatch(/^[0-9a-f]{32}$/);

    expect(sent[2].url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/assets/upload?base64=true`
    );
    expect(sent[2].headers.authorization).toBe("Bearer upload-jwt");

    expect(sent[3]).toMatchObject({ url: base, method: "PUT" });
    const metadata = await metadataOf(sent[3].body);
    expect(metadata.bindings).toEqual([{ type: "assets", name: "ASSETS" }]);
    expect(metadata.assets).toMatchObject({ jwt: "completion-token" });
    expect(metadata.main_module).toBe("release.mjs");

    expect(sent[4]).toMatchObject({ url: `${base}/tags`, method: "PUT" });
    expect(JSON.parse(String(sent[4].body))).toContain(`digest:${artifact.digest}`);

    expect(ref).toEqual({
      runtime: "cloudflare",
      releaseId: release.id,
      ref: { script: SCRIPT, namespace: NAMESPACE, digest: artifact.digest, brokerScript: BROKER },
    });
  });

  it("refuses to replace a script of the same name carrying different bytes", async () => {
    const { sent, fetch } = recorder(uploadRoutes(ok(["zenith", "digest:" + "f".repeat(64)])));
    await expect(runtime(fetch).stageCandidate(app, release, artifact)).rejects.toMatchObject({
      code: "conflict",
    });
    // The readback happened and nothing else did: no upload, no replacement.
    expect(sent.length).toBe(1);
  });

  it("adopts an upload that already finished under the same digest", async () => {
    const { sent, fetch } = recorder(uploadRoutes(ok(["zenith", `digest:${artifact.digest}`])));
    const ref = await runtime(fetch).stageCandidate(app, release, artifact);
    expect(ref.ref.script).toBe(SCRIPT);
    expect(sent.length).toBe(1);
  });
});

describe("probeCandidate", () => {
  const candidate = {
    runtime: "cloudflare" as const,
    releaseId: release.id,
    ref: { script: SCRIPT, namespace: NAMESPACE, digest: artifact.digest, brokerScript: BROKER },
  };

  it("refuses to invent a health result it cannot obtain", async () => {
    const { sent, fetch } = recorder([]);
    const result = await runtime(fetch).probeCandidate(app, candidate);
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
    const http = result.checks.find((c) => c.id === "candidate.http");
    expect(http?.ok).toBe(false);
    expect(http?.detail).toContain("ZENITH_CF_PROBE_URL");
    expect(result.testDatabase).toBe("none (no probe was run)");
  });

  it("probes a configured URL, and still refuses to claim the data round trip", async () => {
    const { sent, fetch } = recorder([
      { match: /probe\.example/, answer: () => new Response("<!doctype html>ok", { status: 200 }) },
    ]);
    const result = await runtime(fetch, {
      probeUrlTemplate: "https://probe.example/{script}",
    }).probeCandidate(app, candidate);

    expect(sent[0].url).toBe(`https://probe.example/${SCRIPT}`);
    const http = result.checks.find((c) => c.id === "candidate.http");
    expect(http?.ok).toBe(true);
    const data = result.checks.find((c) => c.id === "data.roundTrip");
    expect(data?.ok).toBe(false);
    expect(data?.detail).toContain("has not been executed against Cloudflare");
    // One failed check is enough: the whole probe is not ok.
    expect(result.ok).toBe(false);
  });
});

describe("readBindings", () => {
  const candidate = {
    runtime: "cloudflare" as const,
    releaseId: release.id,
    ref: {
      script: SCRIPT,
      namespace: NAMESPACE,
      digest: artifact.digest,
      brokerScript: BROKER,
      d1DatabaseId: DATABASE_ID,
    },
  };

  const bindingRoutes = (releaseBindings: unknown[], brokerBindings: unknown[]) => [
    { match: new RegExp(`/scripts/${SCRIPT}/bindings$`), answer: () => ok(releaseBindings) },
    { match: new RegExp(`/scripts/${SCRIPT}/settings$`), answer: () => ok({ bindings: releaseBindings }) },
    { match: new RegExp(`/scripts/${BROKER}/bindings$`), answer: () => ok(brokerBindings) },
    { match: new RegExp(`/scripts/${BROKER}/settings$`), answer: () => ok({ bindings: brokerBindings }) },
  ];

  const goodBroker = [{ type: "d1", name: "DB", database_id: DATABASE_ID }];

  it("accepts an assets-only release and a single-DB broker, reading both endpoints", async () => {
    const { sent, fetch } = recorder(bindingRoutes([{ type: "assets", name: "ASSETS" }], goodBroker));
    const readback = await runtime(fetch).readBindings(candidate);
    expect(readback.ok).toBe(true);
    expect(readback.release).toEqual(["ASSETS (assets)"]);
    expect(readback.broker).toEqual(["DB (d1)"]);
    expect(readback.detail).toContain("not a guarantee about later changes");
    expect(sent.map((s) => s.url.split("/").pop())).toEqual(["bindings", "settings", "bindings", "settings"]);
  });

  it("accepts a release with no bindings at all", async () => {
    const { fetch } = recorder(bindingRoutes([], goodBroker));
    expect((await runtime(fetch).readBindings(candidate)).ok).toBe(true);
  });

  it("refuses an extra binding on the editable release", async () => {
    const { fetch } = recorder(
      bindingRoutes([{ type: "assets", name: "ASSETS" }, { type: "d1", name: "DB", database_id: DATABASE_ID }], goodBroker)
    );
    const readback = await runtime(fetch).readBindings(candidate);
    expect(readback.ok).toBe(false);
    expect(readback.detail).toContain("a release may have no bindings");
  });

  it("refuses a broker bound to a different database", async () => {
    const { fetch } = recorder(
      bindingRoutes([{ type: "assets", name: "ASSETS" }], [{ type: "d1", name: "DB", database_id: "22222222-2222-4222-8222-222222222222" }])
    );
    const readback = await runtime(fetch).readBindings(candidate);
    expect(readback.ok).toBe(false);
    expect(readback.detail).toContain("exactly one d1 binding called DB");
  });

  it("refuses when the two endpoints disagree", async () => {
    const { fetch } = recorder([
      { match: new RegExp(`/scripts/${SCRIPT}/bindings$`), answer: () => ok([{ type: "assets", name: "ASSETS" }]) },
      { match: new RegExp(`/scripts/${SCRIPT}/settings$`), answer: () => ok({ bindings: [] }) },
      { match: new RegExp(`/scripts/${BROKER}/bindings$`), answer: () => ok(goodBroker) },
      { match: new RegExp(`/scripts/${BROKER}/settings$`), answer: () => ok({ bindings: goodBroker }) },
    ]);
    const readback = await runtime(fetch).readBindings(candidate);
    expect(readback.ok).toBe(false);
    expect(readback.detail).toContain("disagree");
  });
});

describe("the binding allowlist itself", () => {
  it("refuses anything with an extra field, a wrong name or a wrong type", () => {
    expect(isAllowedReleaseBindings([])).toBe(true);
    expect(isAllowedReleaseBindings([{ type: "assets", name: "ASSETS" }])).toBe(true);
    expect(isAllowedReleaseBindings([{ type: "assets", name: "ASSETS", script_name: "other" }])).toBe(false);
    expect(isAllowedReleaseBindings([{ type: "assets", name: "FILES" }])).toBe(false);
    expect(isAllowedReleaseBindings([{ type: "service", name: "ASSETS" }])).toBe(false);

    expect(isAllowedBrokerBindings([{ type: "d1", name: "DB", database_id: DATABASE_ID }], DATABASE_ID)).toBe(true);
    expect(isAllowedBrokerBindings([{ type: "d1", name: "DB", id: DATABASE_ID }], DATABASE_ID)).toBe(true);
    expect(
      isAllowedBrokerBindings([{ type: "d1", name: "DB", database_id: DATABASE_ID, id: "mismatch" }], DATABASE_ID)
    ).toBe(false);
    expect(isAllowedBrokerBindings([], DATABASE_ID)).toBe(false);
    expect(
      isAllowedBrokerBindings(
        [{ type: "d1", name: "DB", database_id: DATABASE_ID }, { type: "secret_text", name: "KEY" }],
        DATABASE_ID
      )
    ).toBe(false);
  });
});

describe("cleanup", () => {
  it("deletes this app's release scripts that nothing retains", async () => {
    const old = releaseScriptName("alpha", 1, "a".repeat(64));
    const { sent, fetch } = recorder([
      {
        match: /\/scripts$/,
        method: "GET",
        answer: () => ok([{ id: SCRIPT }, { id: old }, { id: BROKER }, { id: "zenith-beta-r1-abcdef123456" }]),
      },
      { match: /\/scripts\//, method: "DELETE", answer: () => ok(null) },
    ]);
    await runtime(fetch).cleanup(app, new Set([SCRIPT]));

    const deleted = sent.filter((s) => s.method === "DELETE").map((s) => s.url.split("/").pop());
    expect(deleted).toEqual([old]);
  });
});

describe("the bounded transport", () => {
  it("refuses a redirect rather than following it", async () => {
    const { fetch } = recorder([
      { match: /d1\/database/, answer: () => new Response(null, { status: 302, headers: { location: "https://elsewhere" } }) },
    ]);
    await expect(runtime(fetch).ensureApp(app)).rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it("refuses an answer that is not JSON", async () => {
    const { fetch } = recorder([
      { match: /d1\/database/, answer: () => new Response("<html>captive portal</html>", { status: 200, headers: { "content-type": "text/html" } }) },
    ]);
    await expect(runtime(fetch).ensureApp(app)).rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it("refuses an oversized answer without reading it", async () => {
    const { fetch } = recorder([
      {
        match: /d1\/database/,
        answer: () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json", "content-length": String(1024 * 1024) },
          }),
      },
    ]);
    await expect(runtime(fetch).ensureApp(app)).rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it("turns a rejected token into a refusal that says which permissions are needed", async () => {
    const { fetch } = recorder([{ match: /d1\/database/, answer: () => new Response(null, { status: 403 }) }]);
    await runtime(fetch)
      .ensureApp(app)
      .catch((err: HostedErrorType) => {
        expect(err.code).toBe("runtime_unavailable");
        expect(err.fix).toContain("ZENITH_CF_API_TOKEN");
      });
  });
});
