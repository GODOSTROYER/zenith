import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/server/errors";
import { WaitlistPreviewExpiredError } from "@/lib/waitlist/errors";
import type { WaitlistAdmissionHistory, WaitlistAdmissionPreview, WaitlistAdmissionSelection, WaitlistEntry, WaitlistPage } from "@/lib/waitlist/types";

const mocks = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  repository: vi.fn(),
  list: vi.fn(),
  preview: vi.fn(),
  admit: vi.fn(),
  admitPreview: vi.fn(),
  history: vi.fn(),
  historyDetail: vi.fn(),
}));

vi.mock("@/lib/waitlist/http", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/waitlist/http")>(),
  requireWaitlistOperator: mocks.requireOperator,
}));
vi.mock("@/lib/waitlist/repository", () => ({ waitlistRepository: mocks.repository }));
vi.mock("@/lib/server/request", () => ({
  route: () => { throw new Error("Waitlist administration must not bootstrap a workspace."); },
}));

const { GET: list } = await import("@/app/api/admin/waitlist/route");
const { POST: preview } = await import("@/app/api/admin/waitlist/preview/route");
const { POST: admit } = await import("@/app/api/admin/waitlist/admit/route");
const { GET: history } = await import("@/app/api/admin/waitlist/history/route");
const { GET: historyDetail } = await import("@/app/api/admin/waitlist/history/[requestId]/route");

const ORIGIN = "https://zenith.test";
const BASE = "/api/admin/waitlist";
const OPERATOR = "11111111-1111-4111-8111-111111111111";
const PREVIEW_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const ENTRY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operator = { id: OPERATOR, email: "operator@example.com", name: "Operator" };
const entry: WaitlistEntry = {
  id: ENTRY_ID, email: "person@example.com", name: "Person", occupation: "Engineer",
  features: ["Deployments"], useCase: "Private projects", position: 7, status: "queued",
  createdAt: "2026-09-01T00:00:00.000Z", admittedAt: null, admittedBy: null,
};
const approved: WaitlistEntry = { ...entry, status: "admitted", admittedAt: "2026-09-28T00:00:00.000Z", admittedBy: OPERATOR };
const savedPreview: WaitlistAdmissionPreview = {
  id: PREVIEW_ID, mode: "selected", count: 1, entries: [entry],
  createdAt: "2026-09-28T00:00:00.000Z", expiresAt: "2026-09-28T00:15:00.000Z",
};
const savedHistory: WaitlistAdmissionHistory = { batches: [{
  requestId: REQUEST_ID, actorId: OPERATOR, requestedCount: 2, admittedCount: 1,
  createdAt: "2026-09-28T00:00:00.000Z", mode: "selected",
}] };
const page: WaitlistPage = { entries: [entry], total: 12, queued: 9, admitted: 3, matched: 1, nextCursor: null };
const uuid = (index: number) => `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`;

function rawPost(path: string, body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body,
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return rawPost(path, JSON.stringify(body), headers);
}

function streamedPost(path: string, body: string, headers: Record<string, string> = {}): NextRequest {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 1024)
        controller.enqueue(bytes.slice(offset, offset + 1024));
      controller.close();
    },
  });
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> & { duplex: "half" } = {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: stream, duplex: "half",
  };
  return new NextRequest(`${ORIGIN}${path}`, init);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireOperator.mockResolvedValue(operator);
  mocks.repository.mockResolvedValue({
    list: mocks.list, preview: mocks.preview, admit: mocks.admit,
    admitPreview: mocks.admitPreview, history: mocks.history, historyDetail: mocks.historyDetail,
  });
  mocks.list.mockResolvedValue(page);
  mocks.preview.mockResolvedValue(savedPreview);
  mocks.admit.mockResolvedValue([approved]);
  mocks.admitPreview.mockResolvedValue({ count: 1, requestId: REQUEST_ID });
  mocks.history.mockResolvedValue(savedHistory);
  mocks.historyDetail.mockResolvedValue({ batch: savedHistory.batches[0], entries: [approved], nextOffset: null });
});

describe("admin authorization boundary", () => {
  const routes = [
    { name: "list", handle: list, request: () => new NextRequest(`${ORIGIN}${BASE}?limit=invalid`) },
    { name: "history", handle: history, request: () => new NextRequest(`${ORIGIN}${BASE}/history?limit=invalid`) },
    { name: "preview", handle: preview, request: () => rawPost(`${BASE}/preview`, "broken", { origin: "https://attacker.test", "content-type": "text/plain" }) },
    { name: "admit", handle: admit, request: () => rawPost(`${BASE}/admit`, "broken", { origin: "https://attacker.test", "content-type": "text/plain" }) },
  ];
  for (const route of routes) {
    it.each([401, 403])(`returns authorization status %s before parsing or storage for ${route.name}`, async (status) => {
      mocks.requireOperator.mockRejectedValue(new ApiError("Operator access required.", status));
      const request = route.request();
      const response = await route.handle(request);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.requireOperator).toHaveBeenCalledExactlyOnceWith(request);
      expect(request.bodyUsed).toBe(false);
      expect(mocks.repository).not.toHaveBeenCalled();
    });
  }
});

describe("approval previews", () => {
  const selections: WaitlistAdmissionSelection[] = [
    { mode: "selected", entryIds: [ENTRY_ID] }, { mode: "next", count: 1 },
    { mode: "next", count: 1000 }, { mode: "all" },
  ];
  it.each(selections)("passes %j and the verified actor, returning the preview directly", async (selection) => {
    const result = { ...savedPreview, mode: selection.mode };
    mocks.preview.mockResolvedValue(result);
    const request = post(`${BASE}/preview`, selection);
    const response = await preview(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(result);
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(selection, OPERATOR);
    expect(mocks.requireOperator.mock.invocationCallOrder[0]).toBeLessThan(mocks.repository.mock.invocationCallOrder[0]);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.admitPreview).not.toHaveBeenCalled();
  });

  it("accepts a full selection of 1000 unique UUIDs and canonicalizes their case", async () => {
    const entryIds = [ENTRY_ID.toUpperCase(), ...Array.from({ length: 999 }, (_, index) => uuid(index))];
    expect((await preview(post(`${BASE}/preview`, { mode: "selected", entryIds }))).status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith({ mode: "selected", entryIds: [ENTRY_ID, ...entryIds.slice(1)] }, OPERATOR);
  });

  it("returns a 100-person preview slice while preserving the full selection count", async () => {
    const result = { ...savedPreview, mode: "all" as const, count: 50000,
      entries: Array.from({ length: 100 }, (_, index) => ({ ...entry, id: uuid(index), position: index + 1 })),
    };
    mocks.preview.mockResolvedValue(result);
    const response = await preview(post(`${BASE}/preview`, { mode: "all" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith({ mode: "all" }, OPERATOR);
  });

  it("returns an empty saved selection when storage finds no queued people", async () => {
    const empty = { ...savedPreview, count: 0, entries: [] };
    mocks.preview.mockResolvedValue(empty);
    const response = await preview(post(`${BASE}/preview`, { mode: "all" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(empty);
  });

  it.each([
    { name: "missing mode", body: {} },
    { name: "unknown mode", body: { mode: "unknown" } },
    { name: "missing selection", body: { mode: "selected" } },
    { name: "empty selection", body: { mode: "selected", entryIds: [] } },
    { name: "invalid UUID", body: { mode: "selected", entryIds: ["not-a-uuid"] } },
    { name: "duplicate IDs", body: { mode: "selected", entryIds: [ENTRY_ID, ENTRY_ID] } },
    { name: "case-insensitive duplicate IDs", body: { mode: "selected", entryIds: [ENTRY_ID, ENTRY_ID.toUpperCase()] } },
    { name: "more than 1000 IDs", body: { mode: "selected", entryIds: Array.from({ length: 1001 }, (_, index) => uuid(index)) } },
    { name: "non-array IDs", body: { mode: "selected", entryIds: ENTRY_ID } },
    { name: "null ID", body: { mode: "selected", entryIds: [null] } },
    { name: "zero count", body: { mode: "next", count: 0 } },
    { name: "oversized count", body: { mode: "next", count: 1001 } },
    { name: "fractional count", body: { mode: "next", count: 1.5 } },
    { name: "string count", body: { mode: "next", count: "1" } },
    { name: "missing count", body: { mode: "next" } },
    { name: "mixed selected and next fields", body: { mode: "selected", entryIds: [ENTRY_ID], count: 1 } },
    { name: "extra all fields", body: { mode: "all", entryIds: [ENTRY_ID] } },
    { name: "caller-supplied actor", body: { mode: "all", actorId: OPERATOR } },
    { name: "null body", body: null },
  ])("rejects $name before opening storage", async ({ body }) => {
    expect((await preview(post(`${BASE}/preview`, body))).status).toBe(400);
    expect(mocks.repository).not.toHaveBeenCalled();
  });
});

describe("admin mutation transport", () => {
  const mutations = [
    { name: "preview", path: `${BASE}/preview`, handle: preview, body: { mode: "all" } },
    { name: "admit", path: `${BASE}/admit`, handle: admit, body: { previewId: PREVIEW_ID, requestId: REQUEST_ID } },
  ];
  for (const mutation of mutations) {
    it.each(["https://attacker.test", "null", "https://zenith.test.attacker.test"])(`rejects ${mutation.name} from origin %s`, async (origin) => {
      const request = post(mutation.path, mutation.body, { origin });
      expect((await mutation.handle(request)).status).toBe(403);
      expect(request.bodyUsed).toBe(false);
      expect(mocks.repository).not.toHaveBeenCalled();
    });

    it(`rejects cross-site fetch metadata for ${mutation.name} even with the matching Origin`, async () => {
      expect((await mutation.handle(post(mutation.path, mutation.body, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
      expect(mocks.repository).not.toHaveBeenCalled();
    });

    it.each(["text/plain", "application/x-www-form-urlencoded", ""])(`requires JSON media type for ${mutation.name} instead of %s`, async (contentType) => {
      expect((await mutation.handle(post(mutation.path, mutation.body, { "content-type": contentType }))).status).toBe(415);
      expect(mocks.repository).not.toHaveBeenCalled();
    });

    it(`rejects malformed JSON for ${mutation.name}`, async () => {
      expect((await mutation.handle(rawPost(mutation.path, "{broken"))).status).toBe(400);
      expect(mocks.repository).not.toHaveBeenCalled();
    });

    it(`accepts JSON with charset and no Origin for ${mutation.name}`, async () => {
      const request = new NextRequest(`${ORIGIN}${mutation.path}`, {
        method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(mutation.body),
      });
      expect((await mutation.handle(request)).status).toBe(200);
    });
  }

  it.each([undefined, "1", "65536"])("enforces actual preview bytes despite Content-Length %s", async (length) => {
    const headers: Record<string, string> = length === undefined ? {} : { "content-length": length };
    const body = JSON.stringify({ mode: "all" }).padEnd(65537, " ");
    expect((await preview(streamedPost(`${BASE}/preview`, body, headers))).status).toBe(413);
    expect(mocks.repository).not.toHaveBeenCalled();
  });

  it("counts UTF-8 bytes toward the preview cap", async () => {
    const body = JSON.stringify({ mode: "all", extra: "€".repeat(22000) });
    expect(body.length).toBeLessThan(65536);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(65536);
    expect((await preview(streamedPost(`${BASE}/preview`, body))).status).toBe(413);
    expect(mocks.repository).not.toHaveBeenCalled();
  });

  it("accepts exactly 65536 preview bytes", async () => {
    const body = JSON.stringify({ mode: "all" }).padEnd(65536, " ");
    expect((await preview(streamedPost(`${BASE}/preview`, body, { "content-length": "65536" }))).status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith({ mode: "all" }, OPERATOR);
  });

  it("rejects a declared oversized preview before consuming its body", async () => {
    const request = rawPost(`${BASE}/preview`, JSON.stringify({ mode: "all" }), { "content-length": "65537" });
    expect((await preview(request)).status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    expect(mocks.repository).not.toHaveBeenCalled();
  });

  it("retains the 8192-byte limit for preview confirmation", async () => {
    const body = JSON.stringify({ previewId: PREVIEW_ID, requestId: REQUEST_ID });
    expect((await admit(streamedPost(`${BASE}/admit`, body.padEnd(8192, " ")))).status).toBe(200);
    mocks.repository.mockClear();
    mocks.admitPreview.mockClear();
    expect((await admit(streamedPost(`${BASE}/admit`, body.padEnd(8193, " "), { "content-length": "1" }))).status).toBe(413);
    expect(mocks.repository).not.toHaveBeenCalled();
    expect(mocks.admitPreview).not.toHaveBeenCalled();
  });
});

describe("preview confirmation and legacy admission", () => {
  it("forwards the saved preview, verified actor and request ID only to preview admission", async () => {
    const response = await admit(post(`${BASE}/admit`, { previewId: PREVIEW_ID, requestId: REQUEST_ID }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ count: 1, requestId: REQUEST_ID });
    expect(mocks.admitPreview).toHaveBeenCalledExactlyOnceWith(PREVIEW_ID, OPERATOR, REQUEST_ID);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("returns a compact confirmation for a large approval without loading admitted people", async () => {
    mocks.admitPreview.mockResolvedValue({ count: 50000, requestId: REQUEST_ID });
    const response = await admit(post(`${BASE}/admit`, { previewId: PREVIEW_ID, requestId: REQUEST_ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 50000, requestId: REQUEST_ID });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.historyDetail).not.toHaveBeenCalled();
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("continues routing legacy count requests to FIFO admission", async () => {
    const response = await admit(post(`${BASE}/admit`, { count: 2, requestId: REQUEST_ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ admitted: [approved], count: 1 });
    expect(mocks.admit).toHaveBeenCalledExactlyOnceWith(2, OPERATOR, REQUEST_ID);
    expect(mocks.admitPreview).not.toHaveBeenCalled();
  });

  it.each([
    { previewId: PREVIEW_ID },
    { previewId: "not-a-uuid", requestId: REQUEST_ID },
    { previewId: PREVIEW_ID, requestId: "not-a-uuid" },
    { previewId: PREVIEW_ID, requestId: REQUEST_ID, count: 1 },
    { previewId: PREVIEW_ID, requestId: REQUEST_ID, actorId: OPERATOR },
    { previewId: PREVIEW_ID, requestId: REQUEST_ID, entryIds: [ENTRY_ID] },
    { previewId: null, requestId: REQUEST_ID },
  ])("rejects invalid or mixed confirmation fields: %j", async (body) => {
    expect((await admit(post(`${BASE}/admit`, body))).status).toBe(400);
    expect(mocks.repository).not.toHaveBeenCalled();
  });

  it("preserves the actionable preview-expiry code for refreshing the confirmation", async () => {
    mocks.admitPreview.mockRejectedValue(new WaitlistPreviewExpiredError());
    const response = await admit(post(`${BASE}/admit`, { previewId: PREVIEW_ID, requestId: REQUEST_ID }));
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: {
      message: "This approval preview expired. Review a new preview before approving.", code: "preview_expired",
    } });
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it.each([
    [404, "Approval preview was not found."],
    [409, "This preview belongs to another operator."],
    [409, "This request ID was used for another approval."],
    [503, "Waitlist storage is unavailable."],
  ])("preserves storage status %s and its actionable message", async (status, message) => {
    mocks.admitPreview.mockRejectedValue(new ApiError(message, status));
    const response = await admit(post(`${BASE}/admit`, { previewId: PREVIEW_ID, requestId: REQUEST_ID }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { message } });
  });
});

describe("approval history and search", () => {
  it.each([undefined, "1", "100"])("returns uncached history with limit %s", async (limit) => {
    const query = limit === undefined ? "" : `?limit=${limit}`;
    const response = await history(new NextRequest(`${ORIGIN}${BASE}/history${query}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(savedHistory);
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith({ limit: limit === undefined ? 50 : Number(limit) });
    expect(mocks.requireOperator.mock.invocationCallOrder[0]).toBeLessThan(mocks.repository.mock.invocationCallOrder[0]);
  });

  it.each(["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=1e2", "limit=", "limit=50&limit=50", "after=1", "actorId=someone"])("rejects malformed or extra history query %s", async (query) => {
    expect((await history(new NextRequest(`${ORIGIN}${BASE}/history?${query}`))).status).toBe(400);
    expect(mocks.repository).not.toHaveBeenCalled();
  });

  it("forwards literal search characters alongside status and cursor and returns the matched total", async () => {
    const query = new URLSearchParams({ q: "  Dev_100%+team@example.com  ", status: "queued", after: "7", limit: "25" });
    const response = await list(new NextRequest(`${ORIGIN}${BASE}?${query}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(page);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith({ q: "Dev_100%+team@example.com", status: "queued", after: 7, limit: 25 });
  });

  it.each([`q=${"a".repeat(255)}`, "q=one&q=two", "limit=10&limit=20", "unexpected=1"])("rejects an invalid search query %s", async (query) => {
    expect((await list(new NextRequest(`${ORIGIN}${BASE}?${query}`))).status).toBe(400);
    expect(mocks.repository).not.toHaveBeenCalled();
  });

  it("preserves preview selection errors and history unavailability", async () => {
    mocks.preview.mockRejectedValue(new ApiError("A selected person was not found.", 400));
    const selectionResponse = await preview(post(`${BASE}/preview`, { mode: "selected", entryIds: [ENTRY_ID] }));
    expect(selectionResponse.status).toBe(400);
    expect(await selectionResponse.json()).toEqual({ error: { message: "A selected person was not found." } });
    mocks.history.mockRejectedValue(new ApiError("Waitlist storage is unavailable.", 503));
    const historyResponse = await history(new NextRequest(`${ORIGIN}${BASE}/history`));
    expect(historyResponse.status).toBe(503);
    expect(await historyResponse.json()).toEqual({ error: { message: "Waitlist storage is unavailable." } });
  });
});

describe("approval history detail", () => {
  it.each([401, 403])("returns authorization status %s before reading route parameters, query or storage", async (status) => {
    mocks.requireOperator.mockRejectedValue(new ApiError("Operator access required.", status));
    const readParams = vi.fn(() => Promise.resolve({ requestId: REQUEST_ID }));
    const context = { get params() { return readParams(); } };
    const request = new NextRequest(`${ORIGIN}${BASE}/history/${REQUEST_ID}?offset=invalid&limit=101`);
    const response = await historyDetail(request, context);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requireOperator).toHaveBeenCalledExactlyOnceWith(request);
    expect(readParams).not.toHaveBeenCalled();
    expect(mocks.repository).not.toHaveBeenCalled();
    expect(mocks.historyDetail).not.toHaveBeenCalled();
  });

  it("returns saved batch metadata and the first page uncached with default bounds", async () => {
    const request = new NextRequest(`${ORIGIN}${BASE}/history/${REQUEST_ID}`);
    const response = await historyDetail(request, { params: Promise.resolve({ requestId: REQUEST_ID }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ batch: savedHistory.batches[0], entries: [approved], nextOffset: null });
    expect(mocks.historyDetail).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, { offset: 0, limit: 100 });
    expect(mocks.requireOperator.mock.invocationCallOrder[0]).toBeLessThan(mocks.repository.mock.invocationCallOrder[0]);
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each([
    { offset: 0, limit: 1 }, { offset: 100, limit: 100 }, { offset: 250, limit: 25 },
  ])("forwards explicit detail pagination %j and preserves the next offset", async ({ offset, limit }) => {
    const result = {
      batch: { ...savedHistory.batches[0], requestedCount: 50000, admittedCount: 50000 },
      entries: Array.from({ length: limit }, (_, index) => ({ ...approved, id: uuid(offset + index), position: offset + index + 1 })),
      nextOffset: offset + limit,
    };
    mocks.historyDetail.mockResolvedValue(result);
    const request = new NextRequest(`${ORIGIN}${BASE}/history/${REQUEST_ID}?offset=${offset}&limit=${limit}`);
    const response = await historyDetail(request, { params: Promise.resolve({ requestId: REQUEST_ID }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(result);
    expect(mocks.historyDetail).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, { offset, limit });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each([
    "offset=-1", "offset=1.5", "offset=1e2", "offset=9007199254740992", "offset=", "offset=1tail",
    "limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=1e2", "limit=", "limit=1tail",
    "offset=0&offset=0", "limit=100&limit=100", "q=person", "entryIds=someone", "unexpected=1",
  ])("rejects malformed or additional detail query %s before storage", async (query) => {
    const request = new NextRequest(`${ORIGIN}${BASE}/history/${REQUEST_ID}?${query}`);
    const response = await historyDetail(request, { params: Promise.resolve({ requestId: REQUEST_ID }) });
    expect(response.status).toBe(400);
    expect(mocks.repository).not.toHaveBeenCalled();
    expect(mocks.historyDetail).not.toHaveBeenCalled();
  });

  it("preserves the uncached missing-batch response", async () => {
    mocks.historyDetail.mockRejectedValue(new ApiError("Approval batch was not found.", 404));
    const response = await historyDetail(new NextRequest(`${ORIGIN}${BASE}/history/${REQUEST_ID}`), {
      params: Promise.resolve({ requestId: REQUEST_ID }),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { message: "Approval batch was not found." } });
    expect(mocks.historyDetail).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, { offset: 0, limit: 100 });
  });

  it("preserves actionable storage failures for the selected approval", async () => {
    mocks.historyDetail.mockRejectedValue(new ApiError("Waitlist storage is unavailable.", 503));
    const response = await historyDetail(new NextRequest(`${ORIGIN}${BASE}/history/${REQUEST_ID}`), {
      params: Promise.resolve({ requestId: REQUEST_ID }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { message: "Waitlist storage is unavailable." } });
  });
});
