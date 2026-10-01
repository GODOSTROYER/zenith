/** Adapter labels and preflight consult recorded state, never STS. */
import { afterEach, expect, it } from "vitest";
import { awsProvider } from "@/lib/providers/aws/provider";
import { primeReadinessForTests, resetReadinessCache } from "@/lib/bridge/readiness";
import { setBridgeDepsForTests } from "@/lib/bridge/deps";
import type { CloudConnection } from "@/lib/domain/types";
const conn: CloudConnection = { id: "conn", workspaceId: "ws", provider: "aws", platformConnectionId: "conn", label: "AWS", region: "us-east-1", status: "connecting", grantedPermissions: ["observe role"], createdAt: "2026-10-01" };
afterEach(() => { resetReadinessCache(); setBridgeDepsForTests(null); });
it("starts Preview, names missing checks, and becomes available only with ready cache", () => {
  resetReadinessCache(); expect(awsProvider.availability).toBe("preview"); expect(awsProvider.tagline).toContain("not been checked");
  primeReadinessForTests({ provider: "aws", ready: false, checkedAt: conn.createdAt, checks: [{ id: "drivers", ok: false, detail: "missing", fix: "Register drivers." }] });
  expect(awsProvider.tagline).toContain("registered resource drivers"); expect(awsProvider.availability).toBe("preview");
  primeReadinessForTests({ provider: "aws", ready: true, checks: [], checkedAt: conn.createdAt }); expect(awsProvider.availability).toBe("available"); expect(awsProvider.tagline).toContain("short-lived");
});
it("linked preflight reports each missing fix and recorded verification without calling credentials", async () => {
  setBridgeDepsForTests({ readiness: async () => ({ provider: "aws", ready: false, checkedAt: conn.createdAt, checks: [{ id: "temporal", ok: false, detail: "unreachable", fix: "Start Temporal." }] }), platformConnection: async () => ({ status: "pending_verification" }), credentialBroker: async () => { throw new Error("STS must not be called"); } });
  const report = await awsProvider.preflight(conn); expect(report.ok).toBe(false); expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ fix: "Start Temporal." }), expect.objectContaining({ fix: expect.stringContaining("connection.verifyAws") })]));
});
it("linked ready preflight passes but engine execution and legacy reads still refuse", async () => {
  setBridgeDepsForTests({ readiness: async () => ({ provider: "aws", ready: true, checks: [], checkedAt: conn.createdAt }), platformConnection: async () => ({ status: "verified" }) });
  expect((await awsProvider.preflight(conn)).ok).toBe(true);
  await expect(awsProvider.executeStep({} as never)).rejects.toThrow(/engine/);
  await expect(awsProvider.observe!({} as never, {} as never)).rejects.toThrow(/does not read/);
});
