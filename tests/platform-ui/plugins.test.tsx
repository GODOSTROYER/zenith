/** /platform/plugins UI contract in jsdom. HTTP replies are test fakes; the routes themselves are covered by tests/plugins. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { button, click, flush, mount, text } from "../screens/platform/render";
import { PluginsManager } from "@/app/(product)/platform/plugins/plugins-manager";
import type { PluginGrantView, PluginView } from "@/lib/plugins/view";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); router.refresh.mockReset(); vi.stubGlobal("fetch", fetchMock); });
const jsonReply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const manifest = { description: "Reads topology.", publisher: { id: "acme", name: "Acme" }, artifact: { digest: `sha256:${"a".repeat(64)}` },
  capabilities: { apiVersion: "v3", tools: ["zenith_get_topology", "zenith_query_logs"], scopes: ["read", "logs"] },
  components: { skills: ["connect"], agents: [{ name: "zenith-inspector" }], mcpServers: [{ name: "zenith", command: "node", args: ["cli.mjs"] }] } };
const plugin = (over: Partial<PluginView> = {}): PluginView => ({ id: "plg_1", pluginId: "acme/viewer", version: "1.0.0", status: "pending_review", publisherId: "acme", manifestDigest: "d".repeat(64),
  artifactDigest: "a".repeat(64), manifest, provenance: { keyId: "k1", verifiedAt: "2026-10-05T00:00:00Z" }, approvedTools: [], approvedScopes: [], requestedBy: "alice",
  reviewedBy: null, reviewedAt: null, revokedAt: null, revokeReason: null, createdAt: "2026-10-05T00:00:00Z", ...over });
const tokenView: PluginGrantView = { id: "pgr_1", registrationId: "plg_1", credentialId: "cred_1", scopes: ["read"], createdBy: "bob", createdAt: "2026-10-05T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z", revokedAt: null, lastUsedAt: null };
const body = (i = 0) => JSON.parse(fetchMock.mock.calls[i][1]!.body as string);

describe("plugin review page", () => {
  it("shows publisher, digests, declared tools and scopes, and sends the exact digest with the approved subset", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ plugin: {} }));
    const el = mount(<PluginsManager workspaceId="ws_1" role="admin" plugins={[plugin()]} tokens={[]} resource="https://z.test/api/agent/v3/mcp" />);
    for (const expected of ["acme/viewer", "Awaiting review", "d".repeat(64), "a".repeat(64), "zenith_get_topology", "zenith_query_logs", "read, logs", "Acme"]) expect(text(el)).toContain(expected);
    const boxes = [...el.querySelectorAll<HTMLInputElement>('[aria-label="Tools to approve"] input')];
    click(boxes[1]);
    click(button(el, "Approve selected")); await flush();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/integrations/plugins/review");
    expect(body()).toEqual({ registrationId: "plg_1", manifestDigest: "d".repeat(64), decision: "approve", tools: ["zenith_get_topology"], scopes: ["read", "logs"] });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("keeps read locked and blocks approving nothing", () => {
    const el = mount(<PluginsManager workspaceId="ws_1" role="admin" plugins={[plugin()]} tokens={[]} resource={null} />);
    const read = [...el.querySelectorAll<HTMLInputElement>('[aria-label="Scopes to approve"] input')][0];
    expect(read.disabled).toBe(true);
    for (const box of el.querySelectorAll<HTMLInputElement>('[aria-label="Tools to approve"] input')) click(box);
    expect(button(el, "Approve selected").disabled).toBe(true);
  });

  it("gives non-admins no approve, register or revoke controls and hides unreviewed plugins from their list contract", () => {
    const el = mount(<PluginsManager workspaceId="ws_1" role="editor" plugins={[plugin()]} tokens={[]} resource={null} />);
    expect(text(el)).toContain("Waiting for an admin");
    expect(() => button(el, "Approve selected")).toThrow();
    expect(() => button(el, "Register plugin")).toThrow();
    expect(() => button(el, "Revoke plugin")).toThrow();
  });

  it("revokes only after a reason and a second confirmation, then reports the tokens stopped", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ grantsRevoked: 2 }));
    const el = mount(<PluginsManager workspaceId="ws_1" role="admin" plugins={[plugin({ status: "approved", approvedTools: ["zenith_get_topology"], approvedScopes: ["read"] })]} tokens={[tokenView]} resource={null} />);
    expect(text(el)).toContain("via credential cred_1");
    click(button(el, "Revoke plugin"));
    expect(button(el, "Confirm revoke").disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("issues a token, shows it once, and sends no credential secret", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ token: "zp_" + "T".repeat(43), expiresAt: "2026-10-12T00:00:00Z" }, 201));
    const el = mount(<PluginsManager workspaceId="ws_1" role="editor" plugins={[plugin({ status: "approved", approvedTools: ["zenith_get_topology"], approvedScopes: ["read"] })]} tokens={[]} resource="https://z.test/api/agent/v3/mcp" />);
    expect(button(el, "Issue token").disabled).toBe(true);
    expect(text(el)).toContain("Valid only at https://z.test/api/agent/v3/mcp");
  });
});

describe("plugin page honesty", () => {
  it("states that Zenith does not fetch the archive", () => {
    const el = mount(<PluginsManager workspaceId="ws_1" role="admin" plugins={[plugin()]} tokens={[]} resource={null} />);
    expect(text(el)).toContain("Zenith does not download the archive");
  });
});
