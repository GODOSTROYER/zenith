/** Exercise the production verification adapter and real SQL repository using
 * a fake SQL transport. Metadata only: no cloud credentials or live checks. */
import { afterEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/controlplane/db", async (original) => ({ ...await original<typeof import("@/lib/controlplane/db")>(), platformDb: async () => transport }));
import { placementReads } from "@/lib/placement/recommend";

afterEach(() => vi.clearAllMocks());
describe("stored placement verification", () => {
  it("uses workspace-scoped SELECTs and accepts only verified, non-revoked records", async () => {
    transport.query.mockResolvedValue(["verified", "pending_verification", "failed", "revoked"].map((status, i) => ({ id: `conn-${i}`, workspace_id: "ws-a", legacy_connection_id: null,
      config: { provider: "aws", mode: "oidc_web_identity", accountId: "123456789012", observeRoleArn: "arn:aws:iam::123456789012:role/private-observe-marker" }, status,
      verified_at: status === "verified" ? "2026-09-30T00:00:00Z" : null, verification_detail: "private-verification-marker", created_by: "bob", created_at: "2026-09-30T00:00:00Z", revoked_at: status === "revoked" ? "2026-09-30T00:00:00Z" : null })));
    const result = await placementReads.connections("ws-a");
    expect(transport.query).toHaveBeenCalledWith(expect.stringContaining("where workspace_id = $1"), ["ws-a", null, false]);
    expect(transport.query.mock.calls[0][0].trim().toLowerCase().startsWith("select ")).toBe(true);
    expect(result.map((c) => c.verified)).toEqual([true, false, false, false]);
    expect(JSON.stringify(result)).not.toContain("private-observe-marker"); expect(JSON.stringify(result)).not.toContain("private-verification-marker");
  });
  it("fails closed on store outages without exposing database error text", async () => {
    transport.query.mockRejectedValue(new Error("private-database-location-marker"));
    await expect(placementReads.connections("ws-a")).rejects.toMatchObject({ code: "platform_store_unavailable", message: "Connection verification metadata could not be read." });
  });
});
