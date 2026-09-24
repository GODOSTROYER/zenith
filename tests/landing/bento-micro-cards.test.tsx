import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BentoBody } from "@/app/_landing/bento-body";
import { LandingExperienceProvider } from "@/app/_landing/landing-experience";
import type { ProviderRow } from "@/app/_landing/landing";

vi.mock("@/app/_landing/landing-motion", () => ({ useSmoothScroll: () => undefined }));
vi.mock("next/link", () => ({ default: "a" }));
const providers: ProviderRow[] = [
  { id: "aws", displayName: "AWS", availability: "preview", tagline: "AWS Preview" },
  { id: "gcp", displayName: "Google Cloud", availability: "planned", tagline: "Not available yet." },
  { id: "oracle-coming-later", displayName: "Oracle Cloud", availability: "planned", tagline: "Coming later." },
];
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("IntersectionObserver", class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  window.sessionStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(rows = providers) {
  await act(async () => root.render(<LandingExperienceProvider><BentoBody providers={rows} /></LandingExperienceProvider>));
}
async function click(selector: string) {
  const element = host.querySelector<HTMLButtonElement>(selector);
  expect(element).not.toBeNull(); await act(async () => element!.click());
}

describe("micro interactions stay connected to real card state", () => {
  it("lets cost-card comparison change the same shared system and plan", async () => {
    await render();
    await click('#scenarios [data-micro-group="estimate"] button:first-of-type');
    expect(host.querySelector('#before [aria-label="Example system view"] button:first-of-type')?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll('#before button[aria-label*="proposed addition"]')).toHaveLength(0);
    await click('#scenarios [data-micro-group="estimate"] button:last-of-type');
    expect(host.querySelectorAll('#before button[aria-label*="proposed addition"]')).toHaveLength(2);
    expect(host.querySelector("#preview")?.textContent).toContain("Processing worker");
  });
  it("lets the shared-model controls explain their actual relationship", async () => {
    await render(); await click('#foundation button:nth-of-type(1)');
    const actions = Array.from(host.querySelectorAll<HTMLButtonElement>("#foundation button")).find((button) => button.textContent === "Actions")!;
    await act(async () => actions.click());
    expect(actions.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('#foundation [role="status"]')?.textContent).toContain("same audited action boundary");
  });
  it("opens and focuses the matching provider information from its logo", async () => {
    await render();
    expect(host.querySelector<HTMLDetailsElement>("#bento-provider-details")?.open).toBe(false);
    await click('[aria-label="Read Google Cloud provider details"]');
    const row = host.querySelector('[data-micro-provider="gcp"]');
    expect(host.querySelector<HTMLDetailsElement>("#bento-provider-details")?.open).toBe(true);
    expect(document.activeElement).toBe(row);
    expect(row?.getAttribute("data-selected")).toBe("true");
    expect(row?.textContent).toContain("Planned");
  });
  it("resolves the existing Oracle roadmap alias instead of inventing another provider", async () => {
    await render(); await click('[aria-label="Read Oracle Cloud provider details"]');
    expect(document.activeElement).toBe(host.querySelector('[data-micro-provider="oracle-coming-later"]'));
  });
  it("does not make missing providers into dead logo controls", async () => {
    await render([]);
    expect(host.querySelector("[data-micro-logo]")).toBeNull();
    expect(host.querySelector("#cloud-ecosystem")?.textContent).toContain("Provider status is unavailable");
  });
  it("keeps the agent and hosting media controls independent", async () => {
    await render(); await click('[aria-label="Pause hosting animations"]');
    expect(host.querySelector("#cloud")?.getAttribute("data-user-paused")).toBe("true");
    expect(host.querySelector('[aria-label="Pause agent flow animation"]')).not.toBeNull();
    await click('[aria-label="Pause agent flow animation"]');
    expect(host.querySelector('[aria-label="Play agent flow animation"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Play hosting animations"]')).not.toBeNull();
  });
});
