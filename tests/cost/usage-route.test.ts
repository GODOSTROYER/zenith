/** HTTP boundary contracts; database/exporter storage is exercised independently with real PGlite. */
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock("@/lib/controlplane/db", async original => ({ ...await original<typeof import("@/lib/controlplane/db")>(), platformDb: mocks.db }));
import { POST } from "@/app/api/internal/metrics/route";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("trusted cost usage ingress", () => {
  const request = (body: string, token?: string) => new NextRequest("http://localhost/api/internal/metrics", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });
  it("refuses missing configuration, browser cookies and tenant credentials before reading the store", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(request("{}"))).status).toBe(503);
    const secret = randomBytes(32).toString("hex"); vi.stubEnv("CRON_SECRET", secret);
    expect((await POST(request("{}"))).status).toBe(401);
    expect((await POST(request("{}", randomBytes(32).toString("hex")))).status).toBe(401);
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it("bounds the body and rejects malformed or foreign usage under the existing internal gate", async () => {
    const secret = randomBytes(32).toString("hex"); vi.stubEnv("CRON_SECRET", secret);
    expect((await POST(request(" ".repeat(16_385), secret))).status).toBe(413);
    expect((await POST(request("{", secret))).status).toBe(400);
    const query = vi.fn(async () => []); mocks.db.mockResolvedValue({ query });
    expect((await POST(request("{}", secret))).status).toBe(400);
    const report = { kind: "postgres", workspaceId: "foreign", environmentId: "env", resourceId: "res", address: "db/main", occupiedBytes: 42, observedAt: new Date().toISOString() };
    expect((await POST(request(JSON.stringify(report), secret))).status).toBe(404);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("workspace_id=$1 and environment_id=$2"), ["foreign", "env", "res", "db/main", "postgres"]);
  });
});
