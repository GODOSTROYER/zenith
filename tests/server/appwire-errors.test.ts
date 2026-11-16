/** Request-boundary logging with the real errorResponse/logger and synthetic secrets. */
import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/server/errors";
import { assertNoCredentialLeak } from "@/lib/credentials/redact";

vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/db/store", () => ({ isPostgres: () => false }));
vi.mock("@/lib/db/request-snapshot", () => ({ runWithSnapshot: async (_: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/actions/core", () => ({ withActionOutcomes: async (fn: (outcomes: { commit: () => void }) => Promise<unknown>) => fn({ commit: () => undefined }) }));
vi.mock("@/lib/server/actor", () => ({ resolveRequest: async () => ({ user: null }), routeGrant: vi.fn() }));
import { route, safeRequestError } from "@/lib/server/request";

const password = "synthetic-db-password-1749";
const access = "AKIAIOSFODNN7EXAMPLE";
const token = `za_${"a".repeat(43)}`;
const secretText = `upstream postgres://admin:${password}@database.test/app ${access} Authorization: Bearer ${token}`;
const ctx = { params: Promise.resolve({}) };
let sink: MockInstance<typeof process.stderr.write>;

beforeEach(() => { sink = vi.spyOn(process.stderr, "write").mockImplementation(() => true); });
afterEach(() => { sink.mockRestore(); });
const logged = () => sink.mock.calls.map((call) => String(call[0])).join("");

describe("route error diagnostic boundaries", () => {
  it("redacts credentials in messages, names and stacks before logging a 500", async () => {
    const error = new Error(secretText, { cause: { password } });
    error.name = `Upstream ${token}`;
    const original = { name: error.name, message: error.message, stack: error.stack };
    const response = await route(async () => { throw error; })(new NextRequest("https://zenith.test/api/test", { headers: { "x-request-id": "appwire-security" } }), ctx);
    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe("appwire-security");
    expect(sink).toHaveBeenCalledOnce();
    assertNoCredentialLeak([logged(), await response.json()], { secrets: [password, access, token] });
    expect(logged()).toContain("[REDACTED");
    expect({ name: error.name, message: error.message, stack: error.stack }).toEqual(original);
  });

  it("bounds every diagnostic field after redaction", () => {
    const error = new Error("word ".repeat(4000));
    error.name = "name ".repeat(100);
    error.stack = "frame ".repeat(4000);
    const safe = safeRequestError(error) as { name: string; message: string; stack: string };
    expect(safe.name.length).toBeLessThanOrEqual(140);
    expect(safe.message.length).toBeLessThanOrEqual(2060);
    expect(safe.stack.length).toBeLessThanOrEqual(8204);
    expect(safe.message).toContain("[truncated]");
  });

  it("redacts a secret that spans a truncation boundary", () => {
    const safe = safeRequestError(new Error(`${"!".repeat(2030)}postgres://user:${password}@db.test`));
    assertNoCredentialLeak(safe, { secrets: [password] });
  });

  it.each([secretText, { password, toJSON: () => ({ password }) }, null, 17])("does not serialize non-Error thrown values (%#)", async (error) => {
    const response = await route(async () => { throw error; })(new NextRequest("https://zenith.test/api/test"), ctx);
    expect(response.status).toBe(500);
    assertNoCredentialLeak([logged(), await response.json()], { secrets: [password, access, token] });
    expect(logged()).toContain("NonErrorThrown");
  });

  it("keeps explicit API statuses and fixes while redacting their messages", async () => {
    const response = await route(async () => { throw new ApiError(secretText, 503, { fix: `password=${password}` }); })(new NextRequest("https://zenith.test/api/test"), ctx);
    expect(response.status).toBe(503);
    assertNoCredentialLeak(await response.json(), { secrets: [password, access, token] });
    expect(sink).not.toHaveBeenCalled();
  });

  it("refuses credential-looking correlation ids before logs and responses", async () => {
    const response = await route(async () => { throw new Error("failed"); })(new NextRequest("https://zenith.test/api/test", { headers: { "x-request-id": token } }), ctx);
    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).not.toBe(token);
    assertNoCredentialLeak([logged(), await response.json()], { secrets: [token] });
  });
});
