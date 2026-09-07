import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ORIGIN, inspectionUrl, MAX_RESPONSE_BYTES, MAX_RESPONSE_CHUNKS, readMetadata, REQUEST_TIMEOUT_MS,
  type FetchLike,
} from "../../scripts/hosted-spike/cloudflare-client";
import { parseArgs, runPreflight, validateConfig, type SpikeConfig } from "../../scripts/hosted-spike/cloudflare-preflight";

const TOKEN = "test-token-never-a-real-credential";
const REMOTE_SECRET = "REMOTE-SENSITIVE-VALUE-DO-NOT-PRINT";
const config: SpikeConfig = {
  accountId: "a".repeat(32),
  namespace: "test-preflight",
  apps: [
    { appKey: "test-alpha", release: "test-alpha-r1", broker: "test-alpha-broker", d1Id: "11111111-1111-4111-8111-111111111111" },
    { appKey: "test-beta", release: "test-beta-r1", broker: "test-beta-broker", d1Id: "22222222-2222-4222-8222-222222222222" },
  ],
};

function args(value: SpikeConfig = config): string[] {
  return ["--account-id", value.accountId, "--namespace", value.namespace,
    ...value.apps.flatMap((app) => ["--app", `${app.appKey}:${app.release}:${app.broker}:${app.d1Id}`])];
}
const liveArgs = () => [...args(), "--live-read-only"];
const envelope = (result: unknown) => ({ success: true, errors: [], messages: [], result });
const json = (result: unknown) => Response.json(envelope(result));

type FixtureModifier = (bindings: unknown[], role: "release" | "broker", appIndex: number, endpoint: string) => unknown;
function fixtureFetch(modifier?: FixtureModifier) {
  return vi.fn<FetchLike>(async (url) => {
    const parts = new URL(url).pathname.split("/");
    const endpoint = parts.at(-1)!;
    const script = parts.at(-2);
    const index = config.apps.findIndex((app) => app.release === script || app.broker === script);
    if (index === -1) throw new Error("Unexpected selector");
    const app = config.apps[index];
    const role = app.release === script ? "release" : "broker";
    const bindings = role === "release" ? [{ type: "assets", name: "ASSETS" }]
      : [{ type: "d1", name: "DB", database_id: app.d1Id }];
    const modified = modifier ? modifier(bindings, role, index, endpoint) : bindings;
    return json(endpoint === "settings" ? { bindings: modified, tags: [REMOTE_SECRET] } : modified);
  });
}

const request = () => ({ accountId: config.accountId, namespace: config.namespace, script: config.apps[0].release, endpoint: "bindings" as const, token: TOKEN });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("offline CLI admission", () => {
  it("validates exactly two test apps without touching credentials or network", async () => {
    const fetch = vi.fn<FetchLike>(() => { throw new Error("network must not run"); });
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not run"));
    const getToken = vi.fn(() => { throw new Error("credentials must not be read"); });
    const result = await runPreflight(args(), { fetch, getToken });
    expect(result.exitCode).toBe(0);
    expect(result.evidence.localValidation.status).toBe("passed");
    expect(result.evidence.configurationReadback).toMatchObject({ status: "not-run", source: "not-run", completedRequests: 0 });
    expect(result.evidence.configurationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.evidence).toMatchObject({ tool: "hosted-spike/cloudflare-preflight", contractVersion: 1, nodeVersion: process.version });
    expect(new Date(result.evidence.startedAt).toISOString()).toBe(result.evidence.startedAt);
    expect(new Date(result.evidence.finishedAt!).toISOString()).toBe(result.evidence.finishedAt);
    expect(result.evidence.finishedAt! >= result.evidence.startedAt).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("blocks missing configuration without checking credentials or network", async () => {
    const fetch = fixtureFetch();
    const getToken = vi.fn(() => TOKEN);
    const result = await runPreflight(["--live-read-only"], { fetch, getToken });
    expect(result.exitCode).toBe(2);
    expect(result.evidence.localValidation.status).toBe("blocked");
    expect(result.evidence.configurationReadback.status).toBe("not-run");
    expect(fetch).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it.each([
    ["--base-url", "https://attacker.invalid"], ["--token", REMOTE_SECRET],
    ["--config", ".env.local"], ["--provision"], ["--live-read-only", "--live-read-only"],
    ["--account-id", config.accountId], ["--namespace", config.namespace], ["--app"],
  ])("rejects unsupported/duplicate arguments %j without echoing values", async (...extra) => {
    const fetch = fixtureFetch();
    const result = await runPreflight([...args(), ...extra], { fetch, getToken: () => TOKEN });
    expect(result.exitCode).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(REMOTE_SECRET);
  });

  it.each(["production", "test-a/../../production", "test-a%2Fproduction", "test-a?x=1", "test-a#fragment", "test-a\\b", "test-a\nsecret", "test-á", "test-a.", "test-" + "a".repeat(59)])("rejects unsafe namespace %s", (namespace) => {
    expect(() => validateConfig({ ...config, namespace })).toThrow();
  });

  it.each(["https://api.cloudflare.com", "a".repeat(31), "A".repeat(32), "../" + "a".repeat(32)])("rejects invalid account %s", (accountId) => {
    expect(() => validateConfig({ ...config, accountId })).toThrow();
  });

  it("rejects extra config fields, malformed UUIDs and arbitrary script paths", () => {
    expect(() => validateConfig({ ...config, baseURL: "https://attacker.invalid" })).toThrow();
    for (const patch of [{ d1Id: "arbitrary-db" }, { d1Id: "11111111-1111-4111-8111-11111111111A" }, { release: "test-alpha/other" }, { broker: "test-beta-broker" }, { token: TOKEN }]) {
      expect(() => validateConfig({ ...config, apps: [{ ...config.apps[0], ...patch }, config.apps[1]] })).toThrow();
    }
  });

  it("rejects duplicate/cross-app resource selectors and nested app prefixes", () => {
    const cases = [
      [config.apps[0]], [config.apps[0], config.apps[0]], [...config.apps, config.apps[0]],
      [{ ...config.apps[0], broker: config.apps[0].release }, config.apps[1]],
      [config.apps[0], { ...config.apps[1], d1Id: config.apps[0].d1Id }],
      [config.apps[0], { ...config.apps[1], release: config.apps[0].release }],
      [config.apps[0], { appKey: "test-alpha-child", release: "test-alpha-child-r1", broker: "test-alpha-child-broker", d1Id: config.apps[1].d1Id }],
    ];
    for (const apps of cases) expect(() => validateConfig({ ...config, apps })).toThrow();
  });

  it("requires exactly four fields per app and exact supported option spelling", () => {
    expect(() => parseArgs(["--app", "test-a:test-a-r1:test-a-broker"])).toThrow();
    expect(() => parseArgs(["--app", "test-a:test-a-r1:test-a-broker:uuid:extra"])).toThrow();
    expect(() => parseArgs(["--live-read-only=true", ...args()])).toThrow();
  });
});

describe("configuration-only readback", () => {
  it("makes exactly eight fixed-origin GETs, names both fixtures, and never claims runtime evidence", async () => {
    const fetch = fixtureFetch();
    const result = await runPreflight(liveArgs(), { fetch, getToken: () => TOKEN });
    expect(result.exitCode).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(8);
    const expectedUrls = config.apps.flatMap((app) => [app.release, app.broker].flatMap((script) =>
      ["bindings", "settings"].map((endpoint) => `${API_ORIGIN}/client/v4/accounts/${config.accountId}/workers/dispatch/namespaces/${config.namespace}/scripts/${script}/${endpoint}`)));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(expectedUrls);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store" });
      expect(init.body).toBeUndefined();
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, Accept: "application/json" });
    }
    expect(result.evidence.configurationReadback).toMatchObject({ status: "passed", source: "injected-test-transport", completedRequests: 8 });
    expect(result.evidence.broaderEvidence).toEqual({
      identity: "not-run", revocation: "not-run", egress: "not-run", isolation: "not-run",
      health: "not-run", build: "not-run", quotas: "not-run", immutableRelease: "not-run", d02D08Compliance: "blocked-missing-report",
    });
    const serialized = JSON.stringify(result);
    for (const sensitive of [TOKEN, REMOTE_SECRET, config.accountId, config.apps[0].d1Id]) expect(serialized).not.toContain(sensitive);
  });

  it.each([undefined, "", "short", `${TOKEN}\nInjected: header`])("blocks missing/invalid credentials before network", async (token) => {
    const fetch = fixtureFetch();
    const result = await runPreflight(liveArgs(), { fetch, getToken: () => token });
    expect(result.exitCode).toBe(2);
    expect(result.evidence.localValidation.status).toBe("passed");
    expect(result.evidence.configurationReadback).toMatchObject({ status: "blocked", source: "not-run", completedRequests: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sanitizes a credential-source error", async () => {
    const result = await runPreflight(liveArgs(), { fetch: fixtureFetch(), getToken: () => { throw new Error(REMOTE_SECRET); } });
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result)).not.toContain(REMOTE_SECRET);
  });

  it.each(["d1", "service", "dispatch_namespace", "durable_object_namespace", "mtls_certificate", "hyperdrive", "vpc_service", "secret_text", "plain_text", "json", "unknown_future_binding"])("rejects release capability %s", async (type) => {
    const fetch = fixtureFetch((bindings, role) => role === "release" ? [{ type, name: REMOTE_SECRET, text: TOKEN, database_id: config.apps[0].d1Id }] : bindings);
    const result = await runPreflight(liveArgs(), { fetch, getToken: () => TOKEN });
    expect(result.exitCode).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.evidence.configurationReadback.checks[0].code).toBe("release-binding-not-allowlisted");
    expect(JSON.stringify(result)).not.toContain(REMOTE_SECRET);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("allows an explicitly empty release binding list, without assuming ASSETS exists", async () => {
    const fetch = fixtureFetch((bindings, role) => role === "release" ? [] : bindings);
    expect((await runPreflight(liveArgs(), { fetch, getToken: () => TOKEN })).exitCode).toBe(0);
  });

  it.each([
    [{ type: "assets", name: "OTHER" }],
    [{ type: "assets", name: "ASSETS", secret: REMOTE_SECRET }],
    [{ type: "assets", name: "ASSETS" }, { type: "assets", name: "ASSETS" }],
    [null],
  ])("rejects malformed, extra or duplicate release bindings %j", async (...binding) => {
    const fetch = fixtureFetch((original, role) => role === "release" ? binding : original);
    expect((await runPreflight(liveArgs(), { fetch, getToken: () => TOKEN })).exitCode).toBe(1);
  });

  it("rejects a cross-app D1 swap without exposing either database ID", async () => {
    const fetch = fixtureFetch((bindings, role, i) => role === "broker" ? [{ type: "d1", name: "DB", database_id: config.apps[1 - i].d1Id }] : bindings);
    const result = await runPreflight(liveArgs(), { fetch, getToken: () => TOKEN });
    expect(result.exitCode).toBe(1);
    expect(result.evidence.configurationReadback.checks.at(-1)?.code).toBe("broker-database-mismatch");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain(config.apps[1].d1Id);
  });

  it.each([
    [],
    [{ type: "d1", name: "WRONG", database_id: config.apps[0].d1Id }],
    [{ type: "d1", name: "DB", id: config.apps[0].d1Id }],
    [{ type: "d1", name: "DB", database_id: config.apps[0].d1Id, id: config.apps[1].d1Id }],
    [{ type: "d1", name: "DB", database_id: config.apps[0].d1Id }, { type: "secret_text", name: "SECRET" }],
  ])("requires exactly the broker DB binding and unambiguous canonical ID %j", async (...replacement) => {
    const fetch = fixtureFetch((bindings, role) => role === "broker" ? replacement : bindings);
    expect((await runPreflight(liveArgs(), { fetch, getToken: () => TOKEN })).exitCode).toBe(1);
  });

  it("accepts the documented deprecated ID only when consistent with database_id", async () => {
    const fetch = fixtureFetch((bindings, role, i) => role === "broker" ? [{ ...(bindings[0] as object), id: config.apps[i].d1Id }] : bindings);
    expect((await runPreflight(liveArgs(), { fetch, getToken: () => TOKEN })).exitCode).toBe(0);
  });

  it("requires settings binding evidence instead of treating an omitted optional field as safe", async () => {
    const fetch = fixtureFetch((bindings, _role, _i, endpoint) => endpoint === "settings" ? undefined : bindings);
    const result = await runPreflight(liveArgs(), { fetch, getToken: () => TOKEN });
    expect(result.exitCode).toBe(2);
    expect(result.evidence.configurationReadback.checks.at(-1)?.code).toBe("binding-array-missing");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a privilege present only in settings and a changed allowed binding set", async () => {
    for (const replacement of [[], [{ type: "secret_text", name: "SECRET", text: REMOTE_SECRET }]]) {
      const fetch = fixtureFetch((bindings, _role, _i, endpoint) => endpoint === "settings" ? replacement : bindings);
      const result = await runPreflight(liveArgs(), { fetch, getToken: () => TOKEN });
      expect(result.exitCode).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain(REMOTE_SECRET);
    }
  });
});

describe("fixed REST transport bounds and sanitized failures", () => {
  it("refuses path injection and undocumented endpoints before fetch", async () => {
    const fetch = fixtureFetch();
    expect(() => inspectionUrl(config.accountId, config.namespace, "test-alpha/../secrets", "bindings")).toThrow();
    await expect(readMetadata({ ...request(), endpoint: "content" as "bindings" }, { fetch })).rejects.toMatchObject({ code: "invalid-selector" });
    await expect(readMetadata({ ...request(), token: `${TOKEN}\r\nx: y` }, { fetch })).rejects.toMatchObject({ code: "invalid-token" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[301, 1, "redirect"], [302, 1, "redirect"], [307, 1, "redirect"], [308, 1, "redirect"],
    [401, 2, "credentials-rejected"], [403, 2, "credentials-rejected"], [404, 2, "resource-unavailable"],
    [429, 2, "rate-limited"], [500, 1, "http-error"], [503, 1, "http-error"]] as const)("handles HTTP %i once without reading/printing its body", async (status, exitCode, code) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(REMOTE_SECRET)); }, cancel });
    const fetch = vi.fn<FetchLike>(async () => new Response(body, { status, headers: { Location: `https://attacker.invalid/${TOKEN}` } }));
    const result = await runPreflight(liveArgs(), { fetch, getToken: () => TOKEN });
    expect(result.exitCode).toBe(exitCode);
    expect(result.evidence.configurationReadback.checks.at(-1)?.code).toBe(code);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(REMOTE_SECRET);
  });

  it("refuses an already-redirected response even if it has status 200", async () => {
    const response = json([]);
    Object.defineProperty(response, "redirected", { value: true });
    await expect(readMetadata(request(), { fetch: async () => response })).rejects.toMatchObject({ code: "redirect" });
  });

  it.each([
    [() => new Response(REMOTE_SECRET, { headers: { "Content-Type": "text/html" } }), "unexpected-content-type"],
    [() => new Response(`{${REMOTE_SECRET}`, { headers: { "Content-Type": "application/json" } }), "invalid-json"],
    [() => Response.json({ success: false, errors: [{ message: REMOTE_SECRET }], result: [] }), "invalid-envelope"],
    [() => Response.json({ success: true, errors: [], messages: [] }), "invalid-envelope"],
    [() => Response.json({ success: true, result: [] }), "invalid-envelope"],
    [() => Response.json({ ...envelope([]), errors: [{ message: REMOTE_SECRET }] }), "api-rejected"],
  ] as const)("rejects malformed HTTP/JSON/envelope data without leaking it", async (response, code) => {
    const result = await runPreflight(liveArgs(), { fetch: async () => response(), getToken: () => TOKEN });
    expect(result.exitCode).toBe(1);
    expect(result.evidence.configurationReadback.checks.at(-1)?.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain(REMOTE_SECRET);
  });

  it("rejects invalid UTF-8 JSON instead of silently replacing bytes", async () => {
    await expect(readMetadata(request(), { fetch: async () => new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } }) })).rejects.toMatchObject({ code: "invalid-json" });
  });

  it.each(["absent", "lying-small", "declared-large"])("enforces streamed body size with %s Content-Length", async (kind) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
        controller.enqueue(new TextEncoder().encode(REMOTE_SECRET));
      }, cancel,
    }), { headers: { "Content-Type": "application/json", ...(kind === "absent" ? {} : { "Content-Length": kind === "lying-small" ? "1" : String(MAX_RESPONSE_BYTES + 1) }) } });
    await expect(readMetadata(request(), { fetch: async () => response })).rejects.toMatchObject({ code: "body-too-large" });
    expect(cancel).toHaveBeenCalled();
  });

  it("bounds both stalled response headers and stalled response bodies", async () => {
    vi.useFakeTimers();
    for (const stallBody of [false, true]) {
      let signal: AbortSignal | null | undefined;
      const cancel = vi.fn();
      const fetch: FetchLike = (_url, init) => {
        signal = init.signal;
        return stallBody ? Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "Content-Type": "application/json" } }))
          : new Promise(() => undefined);
      };
      const pending = runPreflight(liveArgs(), { fetch, getToken: () => TOKEN, timeoutMs: 25 });
      await vi.advanceTimersByTimeAsync(26);
      const result = await pending;
      expect(result.exitCode).toBe(1);
      expect(result.evidence.configurationReadback.checks.at(-1)?.code).toBe("timeout");
      expect(signal?.aborted).toBe(true);
      if (stallBody) expect(cancel).toHaveBeenCalled();
    }
  });

  it("bounds empty/tiny stream fragmentation even before timers can fire", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array()); }, cancel,
    }), { headers: { "Content-Type": "application/json" } });
    await expect(readMetadata(request(), { fetch: async () => response })).rejects.toMatchObject({ code: "body-too-fragmented" });
    expect(pulls).toBeLessThanOrEqual(MAX_RESPONSE_CHUNKS + 2);
    expect(cancel).toHaveBeenCalled();
  });

  it("supports cancellation before the first request and during response reading", async () => {
    const before = new AbortController();
    before.abort();
    const noFetch = fixtureFetch();
    expect((await runPreflight(liveArgs(), { fetch: noFetch, getToken: () => TOKEN, signal: before.signal })).exitCode).toBe(2);
    expect(noFetch).not.toHaveBeenCalled();

    const controller = new AbortController();
    const cancel = vi.fn();
    const fetch = vi.fn<FetchLike>(async () => new Response(new ReadableStream<Uint8Array>({
      start() { queueMicrotask(() => controller.abort()); }, cancel,
    }), { headers: { "Content-Type": "application/json" } }));
    const result = await runPreflight(liveArgs(), { fetch, getToken: () => TOKEN, signal: controller.signal });
    expect(result.exitCode).toBe(2);
    expect(result.evidence.configurationReadback.checks.at(-1)?.code).toBe("aborted");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
  });

  it("does not expose thrown network errors and cannot increase the deadline", async () => {
    const fetch = vi.fn<FetchLike>(async () => { throw new Error(`${TOKEN}: ${REMOTE_SECRET}`); });
    const result = await runPreflight(liveArgs(), { fetch, getToken: () => TOKEN });
    expect(result.exitCode).toBe(1);
    expect(result.evidence.configurationReadback.checks.at(-1)?.code).toBe("network");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(REMOTE_SECRET);
    await expect(readMetadata(request(), { fetch, timeoutMs: REQUEST_TIMEOUT_MS + 1 })).rejects.toMatchObject({ code: "invalid-selector" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
