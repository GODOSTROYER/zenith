import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAgentRunRow } from "@/lib/coding-agent/store";

const source = vi.hoisted(() => ({ resolve: vi.fn(), assertLocalAccess: vi.fn() }));
vi.mock("@/lib/coding-agent/github-source", () => ({ createGithubSource: () => source }));
vi.mock("@/lib/controlplane/db/open", () => ({ platformDb: vi.fn() }));
vi.mock("@/lib/coding-agent/launcher", () => ({ temporalRunLauncher: vi.fn() }));
const { createRunSourceAccessChecker } = await import("@/lib/coding-agent/platform");

const now = Date.parse("2026-11-03T12:00:00Z");
function run(id: string, changes: Partial<CodingAgentRunRow> = {}): CodingAgentRunRow {
  return { id, workspaceId: "ws-a", createdBy: "admin", status: "completed", model: "test", task: "private task",
    source: { repository: "acme/app", commit: "a".repeat(40), repositoryId: 7, bindingId: "gsb-7", bindingVersion: 3,
      sourceIdentity: { owner: "acme", repo: "app", repositoryId: 7, commitSha: "a".repeat(40), binding: { appId: 1, installationId: 2, repositoryId: 7, version: 3 } } },
    limits: {}, usage: {}, checkpoint: {}, version: 1, workflowId: "wf", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    payloadExpiresAt: new Date(now + 60_000).toISOString(), ...changes };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); source.resolve.mockReset().mockResolvedValue({}); source.assertLocalAccess.mockReset().mockResolvedValue(undefined); });
afterEach(() => vi.useRealTimers());

describe("request-scoped analysis list verification", () => {
  it("shares provider verification for identical complete identities but checks each grant before and after it", async () => {
    const check = createRunSourceAccessChecker();
    await Promise.all([check(run("one")), check(run("two"))]);
    expect(source.resolve).toHaveBeenCalledOnce();
    expect(source.assertLocalAccess).toHaveBeenCalledTimes(4);
    await createRunSourceAccessChecker()(run("three"));
    expect(source.resolve).toHaveBeenCalledTimes(2);
  });
  it("does not reuse a grant across workspace, binding version or commit boundaries", async () => {
    const check = createRunSourceAccessChecker(), original = run("one");
    const second = run("two", { workspaceId: "ws-b" });
    const third = run("three", { source: { ...original.source as object, bindingVersion: 4 } });
    const fourth = run("four", { source: { ...original.source as object, commit: "b".repeat(40) } });
    await Promise.all([original, second, third, fourth].map(check));
    expect(source.resolve).toHaveBeenCalledTimes(4);
  });
  it.each([{ payloadPurgedAt: new Date(now).toISOString() }, { payloadExpiresAt: new Date(now - 1).toISOString() }])("refuses each unavailable run independently of a verified source: %o", async changes => {
    const check = createRunSourceAccessChecker();
    await check(run("current"));
    await expect(check(run("hidden", changes))).rejects.toMatchObject({ code: "invalid_state" });
    expect(source.resolve).toHaveBeenCalledOnce();
    expect(source.assertLocalAccess).toHaveBeenCalledTimes(2);
  });
  it("rechecks retention after a slow provider response", async () => {
    source.resolve.mockImplementation(async () => { vi.setSystemTime(now + 60_001); return {}; });
    await expect(createRunSourceAccessChecker()(run("expires"))).rejects.toMatchObject({ code: "invalid_state" });
  });
  it("a local revocation after provider verification prevents every protected return", async () => {
    let revoked = false;
    source.resolve.mockImplementation(async () => { revoked = true; return {}; });
    source.assertLocalAccess.mockImplementation(async () => { if (revoked) throw new Error("revoked"); });
    const check = createRunSourceAccessChecker();
    await expect(check(run("one"))).rejects.toThrow("revoked");
    await expect(check(run("two"))).rejects.toThrow("revoked");
    expect(source.resolve).toHaveBeenCalledOnce();
  });
});
