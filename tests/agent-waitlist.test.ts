import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "@/lib/agent-access/security";
import { tempDataDir } from "./_support/data-dir";

const state = vi.hoisted(() => ({
  enabled: true,
  postgres: false,
  admit: vi.fn(async (_user: { id: string; email: string }): Promise<void> => {}),
  snapshot: vi.fn(async () => undefined),
  credential: undefined as Credential | undefined,
}));
vi.mock("@/lib/waitlist/access", () => ({
  waitlistGateEnabled: () => state.enabled,
  requireWaitlistAccess: state.admit,
}));
vi.mock("@/lib/db/store", async (original) => ({
  ...await original<typeof import("@/lib/db/store")>(),
  isPostgres: () => state.postgres,
}));
vi.mock("@/lib/db/postgres-store", async (original) => ({
  ...await original<typeof import("@/lib/db/postgres-store")>(),
  pgClient: () => ({}),
  loadSnapshot: state.snapshot,
}));
vi.mock("@/lib/agent-access/authority", () => ({
  credentialAuthority: () => ({
    kind: "postgres",
    ready: async () => {},
    verify: async () => state.credential,
  }),
}));
vi.mock("@/lib/agent-access/control/capabilities", async (original) => ({
  ...await original<typeof import("@/lib/agent-access/control/capabilities")>(),
  requireControl: async () => {},
}));

tempDataDir("zenith-agent-waitlist-");
delete process.env.ZENITH_STORE;
process.env.ZENITH_AGENT_READER = "1";
process.env.ZENITH_AGENT_ORIGIN = "https://zenith.test";

const { resetDb } = await import("@/lib/db/store");
const { inAgentScope } = await import("@/lib/agent-access/control/runtime");
const { agentReader } = await import("@/lib/agent-access/zenith-reader");
const { requireAgentWaitlistAccess } = await import("@/lib/agent-access/waitlist");
const principal = () => ({ ...state.credential!, integrationId: state.credential!.id });
const request = () => new Request("https://zenith.test/api/agent/v1/mcp", {
  method: "POST",
  headers: {
    authorization: `Bearer za_${"A".repeat(43)}`,
    "x-zenith-workspace": "workspace-1",
    "content-type": "application/json",
    accept: "application/json",
    "mcp-protocol-version": "2025-11-25",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "zenith_get_context", arguments: {} } }),
});

beforeEach(() => {
  state.enabled = true;
  state.postgres = false;
  state.admit.mockReset().mockResolvedValue(undefined);
  state.snapshot.mockClear();
  state.credential = {
    id: "credential-1", subject: "subject-1", tokenHash: "a".repeat(64),
    workspaceId: "workspace-1", projectIds: ["project-1"], scopes: ["read"],
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  resetDb({
    workspaces: [{ id: "workspace-1", name: "Private workspace", slug: "private", createdAt: new Date().toISOString() }],
    members: [{ id: "subject-1", workspaceId: "workspace-1", name: "Member", email: "member@example.test", role: "admin" }],
  });
});

describe("agent admission independent of browser cookies", () => {
  it.each([403, 503])("v2 refuses admission status %i before loading product data or executing work", async (status) => {
    state.postgres = true;
    state.admit.mockRejectedValueOnce(Object.assign(new Error("Private provider details"), { status }));
    const work = vi.fn(async () => "private data");
    await expect(inAgentScope(principal(), work)).rejects.toMatchObject({
      code: status === 403 ? "waitlist_required" : "policy_unavailable", status,
    });
    expect(state.admit).toHaveBeenCalledWith({ id: "subject-1", email: "" });
    expect(state.snapshot).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it.each([403, 503])("v1 refuses admission status %i before reading product data", async (status) => {
    state.postgres = true;
    state.admit.mockRejectedValueOnce(Object.assign(new Error("Private provider details"), { status }));
    const response = await agentReader(request());
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error.code).toBe(status === 403 ? "waitlist_required" : "policy_unavailable");
    expect(JSON.stringify(body)).not.toContain("Private provider details");
    expect(state.snapshot).not.toHaveBeenCalled();
  });

  it("permits admitted subjects through both scopes", async () => {
    expect(await inAgentScope(principal(), async () => "allowed")).toBe("allowed");
    expect((await agentReader(request())).status).toBe(200);
    expect(state.admit).toHaveBeenCalledTimes(2);
  });

  it("preserves default-off operation without reaching Supabase or waitlist storage", async () => {
    state.enabled = false;
    state.admit.mockRejectedValue(new Error("No identity provider configured"));
    expect(await inAgentScope(principal(), async () => "allowed")).toBe("allowed");
    expect((await agentReader(request())).status).toBe(200);
    expect(state.admit).not.toHaveBeenCalled();
  });

  it("fails closed on unknown admission failures without revealing their details", async () => {
    state.admit.mockRejectedValue(new Error("Database password is private"));
    await expect(requireAgentWaitlistAccess("subject-1")).rejects.toMatchObject({ code: "policy_unavailable", status: 503 });
  });
});
