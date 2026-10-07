/**
 * The OAuth consent restatement on the Integrations screen (PROD-UX-02): before
 * a person authorizes a client the screen must show whose tokens, accepted at
 * which exact resource, with which exact scope strings, for how long, and how
 * to take it back. The facts come from the server, never from the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import IntegrationControl from "@/app/(product)/integrations/integration-control";
import { consentFacts } from "@/lib/agent-access/scope-catalog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = "https://zenith.test";
const ISSUER = "https://issuer.test/tenant";
const state = (over: Record<string, unknown> = {}) => ({
  workspaceId: "w1", subject: "u1", role: "admin", resource: `${ORIGIN}/api/agent/v2/mcp`, oauthConfigured: true,
  projects: [{ id: "p1", name: "Atlas" }], grants: [], operations: [], linkedAgents: [], consent: consentFacts(ORIGIN, ISSUER), ...over,
});

let root: Root;
let host: HTMLDivElement;
let current: Record<string, unknown>;
beforeEach(() => {
  current = state();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => current })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
async function render() {
  await act(async () => root.render(<main id="main"><IntegrationControl /></main>));
  await settle();
}
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("consent restatement", () => {
  it("names the issuer, both exact resources, the exact scope strings and the revocation endpoint", async () => {
    await render();
    const text = host.textContent ?? "";
    expect(text).toContain("You are authorizing");
    expect(text).toContain(ISSUER);
    expect(text).toContain(`${ORIGIN}/api/agent/v3/mcp`);
    expect(text).toContain(`${ORIGIN}/api/agent/v2/mcp`);
    const summary = [...host.querySelectorAll("dl")].find((dl) => dl.textContent?.includes("Exact scopes"))!;
    expect(summary.textContent).toContain("zenith:read");
    expect(summary.textContent).not.toContain("zenith:write"); // read is the default; nothing else is implied
    expect(text).toContain(`${ORIGIN}/api/agent/oauth/revoke`);
    expect(text).toMatch(/revoke this below at any time/);
  });

  it("every permission states its literal OAuth scope", async () => {
    await render();
    const text = host.textContent ?? "";
    for (const scope of ["read", "plan", "export", "write", "publish", "logs"]) expect(text).toContain(`OAuth scope: zenith:${scope}.`);
  });

  it("follows the form: the client id, chosen projects, expiry and ticked scopes", async () => {
    await render();
    const clientInput = [...host.querySelectorAll("input")].find((i) => i.getAttribute("autocomplete") === "off" && i.maxLength === 200)!;
    await type(clientInput, "claude-code");
    const box = (label: string) => [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].find((i) => host.querySelector(`label[for="${i.id}"]`)?.textContent === label)!;
    await act(async () => box("Atlas").click());
    await act(async () => box("write").click());
    await settle();
    const summary = [...host.querySelectorAll("dl")].find((dl) => dl.textContent?.includes("Exact scopes"))!;
    expect(summary.textContent).toContain("claude-code");
    expect(summary.textContent).toContain("Atlas");
    expect(summary.textContent).toContain("zenith:read zenith:write");
    expect(summary.textContent).toMatch(/1 day after you authorize/);
  });

  it("shows nothing invented when the server supplied no consent facts", async () => {
    current = state({ consent: undefined });
    await render();
    expect(host.textContent).not.toContain("You are authorizing");
  });

  it("says plainly that no authorization server is configured, and offers no form", async () => {
    current = state({ oauthConfigured: false, consent: consentFacts(ORIGIN, null) });
    await render();
    expect(host.textContent).toContain("Remote OAuth is not configured here");
    expect(host.textContent).not.toContain("You are authorizing");
  });
});
