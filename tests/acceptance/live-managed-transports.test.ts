import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { realTransport, privateFile } from "../../scripts/acceptance/live/managed/transport";
import type { Target } from "../../scripts/acceptance/live/managed/plan";
const RUN = "zlive-202610081200-abcd";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) { if (!path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`)) throw new Error("Temp cleanup escaped its root"); rmSync(root, { recursive: true }); } });
function auth(text = randomBytes(24).toString("hex")) {
  const dir = mkdtempSync(path.join(tmpdir(), "zenith-l3-transport-")); roots.push(dir);
  const file = path.join(dir, "credential"); writeFileSync(file, text, { mode: 0o600 }); return { file, text, env: { TEST_AUTH_FILE: file } };
}
const target = (kind: Target["kind"], provider: Target["provider"]): Target => ({ id: "target", kind, provider, account: "sandbox-account", region: "us-east-1", origin: "https://sandbox.invalid", auth: "bearer", credentialRef: "TEST_AUTH_FILE", workspaceId: "owned-workspace" });

describe("L3 real transport contract with recorded/fake network IO only", () => {
  it("the factory and plan metadata never read absent credentials or call the network", () => {
    const net = vi.spyOn(globalThis, "fetch"); expect(() => realTransport({}, RUN, [])).not.toThrow(); expect(net).not.toHaveBeenCalled();
  });
  it("rejects relative credential references and TLS bypass", () => {
    expect(() => privateFile("TEST_AUTH_FILE", { TEST_AUTH_FILE: "relative" })).toThrow();
    expect(() => realTransport({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, RUN, [])).toThrow();
  });
  it("sends a FILE bearer only to the planned origin, refuses redirects through status checks, and sets the workspace", async () => {
    const a = auth(); const t = target("product", "control_plane"); const net = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "redirect" }), { status: 302 }));
    const result = await realTransport(a.env, RUN, [t]).send({ kind: "http", target: t.id, method: "GET", path: "/api/platform/v1/operations/owned", status: 200, assertions: [{ pointer: "/operation/status", equals: "succeeded" }] }, t, vi.fn());
    expect(result.status).toBe(302); expect(net).toHaveBeenCalledTimes(1);
    expect(net.mock.calls[0]![0]!.toString()).toBe("https://sandbox.invalid/api/platform/v1/operations/owned");
    expect(net.mock.calls[0]![1]).toMatchObject({ redirect: "manual", headers: { authorization: `Bearer ${a.text}`, "x-zenith-workspace": t.workspaceId } });
  });
  it("preserves genuine browser-session authentication for the existing teardown route", async () => {
    const a = auth(); const t = { ...target("product", "control_plane"), auth: "browser" as const }; const net = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await realTransport(a.env, RUN, [t]).send({ kind: "http", target: t.id, method: "POST", path: "/api/platform/v1/operations/owned/mixed-run/teardown", body: { action: "sync", childId: "owned-child" }, status: 200, assertions: [{ pointer: "/summary/status", equals: "destroyed" }] }, t, vi.fn());
    const headers = net.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.cookie).toBe(a.text); expect(headers.origin).toBe(t.origin); expect(headers.authorization).toBeUndefined();
  });
  it("guards each actual GCP inventory page and pins project/query/token continuation", async () => {
    const a = auth(); const t = target("gcp", "gcp"); const guard = vi.fn();
    const net = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ name: "owned" }], nextPageToken: "next" }))).mockResolvedValueOnce(new Response("{}"));
    const result = await realTransport(a.env, RUN, [t]).send({ kind: "inventory", target: t.id }, t, guard);
    expect(result.body).toEqual([{ name: "owned" }]); expect(guard).toHaveBeenCalledTimes(2);
    const second = net.mock.calls[1]![0] as URL;
    expect(second.pathname).toBe("/v1/projects/sandbox-account:searchAllResources"); expect(second.searchParams.get("query")).toBe(`labels.zenith_live_run=${RUN}`); expect(second.searchParams.get("pageToken")).toBe("next");
  });
  it.each(["https://other.invalid/subscriptions/sandbox-account/resources", "https://management.azure.com/subscriptions/unrelated/resources"])("refuses Azure pagination escaping its target: %s", async nextLink => {
    const a = auth(); const t = target("azure", "azure"); const net = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ value: [], nextLink }))); const guard = vi.fn();
    await expect(realTransport(a.env, RUN, [t]).send({ kind: "inventory", target: t.id }, t, guard)).rejects.toThrow("escaped"); expect(net).toHaveBeenCalledTimes(1); expect(guard).toHaveBeenCalledTimes(1);
  });
  it.each([null, { value: "not-an-array" }, { nextPageToken: "unreadable" }])("does not call malformed Azure inventories empty: %s", async body => {
    const a = auth(); const t = target("azure", "azure"); vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(realTransport(a.env, RUN, [t]).send({ kind: "inventory", target: t.id }, t, vi.fn())).rejects.toThrow();
  });
  it("rejects kubeconfig credential plugins before any provider call", async () => {
    const a = auth(JSON.stringify({ contexts: [{ name: "owned", context: { cluster: "owned", user: "owned" } }], clusters: [{ name: "owned", cluster: { server: "https://sandbox.invalid" } }], users: [{ name: "owned", user: { exec: { command: "unreviewed" } } }] }));
    const t = { ...target("kubernetes", "kubernetes"), context: "owned" }; const net = vi.spyOn(globalThis, "fetch");
    await expect(realTransport(a.env, RUN, [t]).send({ kind: "inventory", target: t.id }, t, vi.fn())).rejects.toThrow("credential plugins"); expect(net).not.toHaveBeenCalled();
  });
});
