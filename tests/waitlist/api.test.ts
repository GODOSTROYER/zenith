import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SessionUser } from "@/lib/auth/session";
import type { WaitlistEntry, WaitlistPage } from "@/lib/waitlist/types";
import { ApiError } from "@/lib/server/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  repository: vi.fn(),
  join: vi.fn(),
  list: vi.fn(),
  admit: vi.fn(),
  admitted: vi.fn(),
  consumeRateLimit: vi.fn(),
}));

vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: mocks.session }));
vi.mock("@/lib/waitlist/repository", () => ({ waitlistRepository: mocks.repository }));
vi.mock("@/lib/server/request", () => ({
  route: () => { throw new Error("Waitlist routes must not bootstrap a workspace or require product admission."); },
}));

const { POST: join } = await import("@/app/api/waitlist/route");
const { GET: list } = await import("@/app/api/admin/waitlist/route");
const { POST: admit } = await import("@/app/api/admin/waitlist/admit/route");

const ORIGIN = "https://zenith.test";
const OPERATOR = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const valid = { email: "person@example.com", occupation: "Engineer", useCase: "Deploy a private project." };
const operator: SessionUser = { id: OPERATOR, email: "operator@example.com", name: "Operator" };
const entry: WaitlistEntry = {
  id: "44444444-4444-4444-8444-444444444444",
  ...valid,
  position: 7,
  status: "admitted",
  createdAt: "2026-09-01T00:00:00.000Z",
  admittedAt: "2026-09-26T00:00:00.000Z",
  admittedBy: OPERATOR,
};
const page: WaitlistPage = { entries: [entry], total: 3, queued: 2, admitted: 1, nextCursor: 7 };

function post(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

function rawPost(path: string, body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function streamedPost(body: string, headers: Record<string, string> = {}): NextRequest {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 1024)
        controller.enqueue(bytes.slice(offset, offset + 1024));
      controller.close();
    },
  });
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> & { duplex: "half" } = {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: stream,
    duplex: "half",
  };
  return new NextRequest(`${ORIGIN}/api/waitlist`, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ZENITH_WAITLIST_ENABLED", "1");
  vi.stubEnv("ZENITH_WAITLIST_GATE_ENABLED", "0");
  vi.stubEnv("ZENITH_WAITLIST_ADMIN_IDS", OPERATOR);
  vi.stubEnv("ZENITH_WAITLIST_EXISTING_USERS_BEFORE", undefined);
  vi.stubEnv("ZENITH_WAITLIST_RATE_LIMIT_SECRET", "test-waitlist-rate-limit-secret-0123456789");
  vi.stubEnv("ZENITH_WAITLIST_TRUSTED_IP_HEADER", undefined);
  mocks.session.mockResolvedValue(operator);
  mocks.repository.mockResolvedValue({
    join: mocks.join,
    list: mocks.list,
    admit: mocks.admit,
    admitted: mocks.admitted,
    consumeRateLimit: mocks.consumeRateLimit,
  });
  mocks.join.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue(page);
  mocks.admit.mockResolvedValue([entry]);
  mocks.consumeRateLimit.mockResolvedValue(true);
});

afterEach(() => vi.unstubAllEnvs());

describe("public waitlist intake", () => {
  it("returns 404 without loading identity or storage when intake is disabled", async () => {
    vi.stubEnv("ZENITH_WAITLIST_ENABLED", "0");
    const response = await join(post("/api/waitlist", valid));
    expect(response.status).toBe(404);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.repository).not.toHaveBeenCalled();
  });

  it("normalizes submissions and gives duplicates the same private, uncached response", async () => {
    const responses = [
      await join(post("/api/waitlist", { email: "  Person@Example.COM  ", occupation: " Engineer ", useCase: " Deploy a private project. " })),
      await join(post("/api/waitlist", valid)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ accepted: true });
    }
    expect(mocks.join.mock.calls).toEqual([[valid], [valid]]);
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("accepts JSON media types with charset and nonbrowser requests without Origin", async () => {
    const response = await join(rawPost("/api/waitlist", JSON.stringify(valid), { "content-type": "application/json; charset=utf-8" }));
    expect(response.status).toBe(202);
  });

  it.each(["https://attacker.test", "null", "https://zenith.test.attacker.test"])("rejects cross-origin requests from %s", async (origin) => {
    expect((await join(post("/api/waitlist", valid, { origin }))).status).toBe(403);
    expect(mocks.repository).not.toHaveBeenCalled();
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", ""])("requires JSON Content-Type instead of %s", async (contentType) => {
    expect((await join(post("/api/waitlist", valid, { "content-type": contentType }))).status).toBe(415);
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it("returns a client error for malformed JSON", async () => {
    expect((await join(rawPost("/api/waitlist", "{broken"))).status).toBe(400);
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it.each([
    { ...valid, email: "invalid" },
    { ...valid, email: `${"a".repeat(245)}@example.com` },
    { ...valid, occupation: "   " },
    { ...valid, occupation: "x".repeat(121) },
    { ...valid, useCase: "\n\t" },
    { ...valid, useCase: "x".repeat(2001) },
    { ...valid, status: "admitted" },
    { ...valid, admittedBy: OPERATOR },
    { email: valid.email, occupation: valid.occupation },
    null,
  ])("rejects invalid or additional fields: %j", async (body) => {
    expect((await join(post("/api/waitlist", body))).status).toBe(400);
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it.each([undefined, "1", "8192"])("caps actual streamed bytes despite Content-Length %s", async (length) => {
    const headers: Record<string, string> = length === undefined ? {} : { "content-length": length };
    const response = await join(streamedPost(JSON.stringify(valid).padEnd(8193, " "), headers));
    expect(response.status).toBe(413);
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it("enforces the body cap in bytes, including multibyte text", async () => {
    const response = await join(streamedPost(JSON.stringify({ ...valid, useCase: "€".repeat(3000) })));
    expect(response.status).toBe(413);
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it("accepts a body at the exact 8192-byte boundary", async () => {
    expect((await join(streamedPost(JSON.stringify(valid).padEnd(8192, " ")))).status).toBe(202);
    expect(mocks.join).toHaveBeenCalledWith(valid);
  });

  it("applies the global limit and keeps spoofed untrusted headers in one conservative client bucket", async () => {
    expect((await join(post("/api/waitlist", valid, { "x-forwarded-for": "203.0.113.8" }))).status).toBe(202);
    expect((await join(post("/api/waitlist", valid, { "x-forwarded-for": "198.51.100.9" }))).status).toBe(202);
    const globalCalls = mocks.consumeRateLimit.mock.calls.filter((call) => call[1] === 1000);
    const clientCalls = mocks.consumeRateLimit.mock.calls.filter((call) => call[1] === 10);
    expect(globalCalls).toHaveLength(2);
    expect(globalCalls[0]).toEqual([expect.any(String), 1000, 3600]);
    expect(globalCalls[1]).toEqual(globalCalls[0]);
    expect(clientCalls).toHaveLength(2);
    expect(clientCalls[0]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/), 10, 3600]);
    expect(clientCalls[1]).toEqual(clientCalls[0]);
  });

  it("hashes trusted client addresses with the configured secret before persisting rate keys", async () => {
    vi.stubEnv("ZENITH_WAITLIST_TRUSTED_IP_HEADER", "x-real-ip");
    const headers = { "x-real-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.9" };
    expect((await join(post("/api/waitlist", valid, headers))).status).toBe(202);
    expect((await join(post("/api/waitlist", valid, headers))).status).toBe(202);
    let clientCalls = mocks.consumeRateLimit.mock.calls.filter((call) => call[1] === 10);
    expect(clientCalls).toHaveLength(2);
    expect(clientCalls[0][0]).toBe(clientCalls[1][0]);
    expect(clientCalls[0][0]).toMatch(/[a-f0-9]{64}/);
    expect(clientCalls[0][2]).toBe(3600);
    expect(JSON.stringify(mocks.consumeRateLimit.mock.calls)).not.toContain("203.0.113.8");
    expect(JSON.stringify(mocks.consumeRateLimit.mock.calls)).not.toContain("198.51.100.9");

    vi.stubEnv("ZENITH_WAITLIST_RATE_LIMIT_SECRET", "a-different-waitlist-rate-limit-secret-0123456789");
    expect((await join(post("/api/waitlist", valid, headers))).status).toBe(202);
    clientCalls = mocks.consumeRateLimit.mock.calls.filter((call) => call[1] === 10);
    expect(clientCalls[2][0]).not.toBe(clientCalls[0][0]);
  });

  it.each(["global", "client"])("returns a retry delay when the %s limit is exhausted", async (scope) => {
    vi.stubEnv("ZENITH_WAITLIST_TRUSTED_IP_HEADER", "x-real-ip");
    mocks.consumeRateLimit.mockImplementation(async (_key: string, limit: number) => scope === "global" ? limit !== 1000 : limit !== 10);
    const response = await join(post("/api/waitlist", valid, { "x-real-ip": "203.0.113.8" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(mocks.join).not.toHaveBeenCalled();
  });
});

describe("waitlist operator authorization", () => {
  it.each(["list", "admit"])("requires a session before parsing or storage for %s", async (route) => {
    mocks.session.mockResolvedValue(null);
    const request = route === "list"
      ? new NextRequest(`${ORIGIN}/api/admin/waitlist?limit=invalid`)
      : rawPost("/api/admin/waitlist/admit", "broken", { origin: "https://attacker.test", "content-type": "text/plain" });
    const response = await (route === "list" ? list(request) : admit(request));
    expect(response.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(mocks.repository).not.toHaveBeenCalled();
  });

  it.each(["list", "admit"])("denies an ordinary workspace admin before storage for %s", async (route) => {
    mocks.session.mockResolvedValue({ id: OTHER_USER, email: operator.email, name: "Workspace admin", role: "admin" });
    const request = route === "list"
      ? new NextRequest(`${ORIGIN}/api/admin/waitlist`)
      : post("/api/admin/waitlist/admit", { count: 1, requestId: REQUEST_ID });
    const response = await (route === "list" ? list(request) : admit(request));
    expect(response.status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(mocks.repository).not.toHaveBeenCalled();
  });
});

describe("operator waitlist listing", () => {
  it("returns the page uncached with a default bounded limit", async () => {
    const response = await list(new NextRequest(`${ORIGIN}/api/admin/waitlist`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(page);
    expect(mocks.list).toHaveBeenCalledWith({ limit: 100 });
    expect(mocks.session.mock.invocationCallOrder[0]).toBeLessThan(mocks.repository.mock.invocationCallOrder[0]);
  });

  it.each(["queued", "admitted"])("passes valid %s filtering and cursor parameters to storage", async (status) => {
    expect((await list(new NextRequest(`${ORIGIN}/api/admin/waitlist?status=${status}&after=0&limit=200`))).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ status, after: 0, limit: 200 });
  });

  it.each([
    "status=unknown", "status=", "after=-1", "after=1.5", "after=1e3", "after=7trailing",
    "after=9007199254740992", "after=", "limit=0", "limit=201", "limit=1.5", "limit=1e2", "limit=",
  ])("rejects malformed query parameters: %s", async (query) => {
    expect((await list(new NextRequest(`${ORIGIN}/api/admin/waitlist?${query}`))).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("preserves actionable storage errors through the API error mapper", async () => {
    mocks.list.mockRejectedValue(new ApiError("Waitlist storage is unavailable.", 503));
    const response = await list(new NextRequest(`${ORIGIN}/api/admin/waitlist`));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { message: "Waitlist storage is unavailable." } });
  });
});

describe("operator FIFO batch admission", () => {
  it.each([1, 1000])("passes the verified actor and idempotency key for a batch of %s", async (count) => {
    const response = await admit(post("/api/admin/waitlist/admit", { count, requestId: REQUEST_ID }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ admitted: [entry], count: 1 });
    expect(mocks.admit).toHaveBeenCalledExactlyOnceWith(count, OPERATOR, REQUEST_ID);
    expect(mocks.session.mock.invocationCallOrder[0]).toBeLessThan(mocks.repository.mock.invocationCallOrder[0]);
  });

  it.each([
    { count: 0, requestId: REQUEST_ID },
    { count: 1001, requestId: REQUEST_ID },
    { count: 1.5, requestId: REQUEST_ID },
    { count: "1", requestId: REQUEST_ID },
    { count: 1 },
    { count: 1, requestId: "not-a-uuid" },
    { count: 1, requestId: REQUEST_ID, actorId: OTHER_USER },
  ])("rejects invalid admission requests: %j", async (body) => {
    expect((await admit(post("/api/admin/waitlist/admit", body))).status).toBe(400);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin admission before a batch can be applied", async () => {
    const response = await admit(post("/api/admin/waitlist/admit", { count: 1, requestId: REQUEST_ID }, { origin: "https://attacker.test" }));
    expect(response.status).toBe(403);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("requires JSON for admission requests", async () => {
    const response = await admit(post("/api/admin/waitlist/admit", { count: 1, requestId: REQUEST_ID }, { "content-type": "text/plain" }));
    expect(response.status).toBe(415);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("caps admission body bytes even when Content-Length understates the size", async () => {
    const response = await admit(rawPost("/api/admin/waitlist/admit", JSON.stringify({ count: 1, requestId: REQUEST_ID }).padEnd(8193, " "), { "content-length": "1" }));
    expect(response.status).toBe(413);
    expect(mocks.admit).not.toHaveBeenCalled();
  });
});
