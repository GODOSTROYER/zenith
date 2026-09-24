import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BentoBody } from "@/app/_landing/bento-body";
import { approvalExampleReducer, planRiskLabel, providerPresentation } from "@/app/_landing/bento-data";
import { LandingExperienceProvider } from "@/app/_landing/landing-experience";
import { ESTIMATE } from "@/app/_landing/scenario";
import { AUTONOMY_MEANING } from "@/lib/navigator/shared";
import { fmtUsd } from "@/lib/format";
import type { ProviderRow } from "@/app/_landing/landing";

// Test the real shared presentation state, without scroll animation or Next prefetch.
vi.mock("@/app/_landing/landing-motion", () => ({ useSmoothScroll: () => undefined }));
vi.mock("next/link", () => ({ default: "a" }));

const providers: ProviderRow[] = [
  { id: "sandbox", displayName: "Sandbox", availability: "available", tagline: "Simulation" },
  { id: "localstack", displayName: "LocalStack", availability: "available", tagline: "Local operations" },
  { id: "aws", displayName: "AWS", availability: "preview", tagline: "AWS Preview" },
  { id: "gcp", displayName: "Google Cloud", availability: "planned", tagline: "Not available yet." },
];

let host: HTMLDivElement;
let root: Root;
const observe = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("IntersectionObserver", class {
    observe = observe;
    unobserve = vi.fn();
    disconnect = vi.fn();
  });
  observe.mockClear();
  window.sessionStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(rows = providers) {
  await act(async () => root.render(<LandingExperienceProvider><BentoBody providers={rows} /></LandingExperienceProvider>));
}

async function click(label: string, scope: ParentNode = host) {
  const button = Array.from(scope.querySelectorAll("button")).find((element) => element.textContent?.trim() === label);
  expect(button, `button '${label}' should exist`).toBeDefined();
  await act(async () => button!.click());
}

describe("bento product story", () => {
  it("adds no second hero, terminal or code wall", async () => {
    await render();
    expect(host.querySelectorAll("h1, pre, code")).toHaveLength(0);
    expect(host.querySelectorAll("[data-bento]")).toHaveLength(9);
    for (const id of ["before", "scenarios", "agents", "gimbal", "cloud", "ownership"]) {
      expect(host.querySelector(`#${id}[data-chapter]`)).not.toBeNull();
    }
  });

  it("keeps the map, proposal and estimate on the same shared view", async () => {
    await render();
    await click("Current");
    expect(host.querySelectorAll('#before button[aria-label*="proposed addition"]')).toHaveLength(0);
    expect(host.querySelector('#scenarios [role="status"]')?.textContent).toContain(fmtUsd(ESTIMATE.current));
    expect(host.querySelector("#preview")?.textContent).toContain("No changes proposed.");
    await click("Preview the change");
    expect(host.querySelectorAll('#before button[aria-label*="proposed addition"]')).toHaveLength(2);
    expect(host.querySelector('#scenarios [role="status"]')?.textContent).toContain(fmtUsd(ESTIMATE.proposed));
    expect(host.querySelector("#preview")?.textContent).toContain("Processing worker");
  });

  it("waits for explicit approval and resets consent when the source changes", async () => {
    await render();
    const flow = host.querySelector("[data-approved]")!;
    expect(flow.getAttribute("data-approved")).toBe("false");
    await click("Approve example");
    expect(flow.getAttribute("data-approved")).toBe("true");
    expect(host.querySelector('#agents [role="status"]')?.textContent).toContain("Simulated only; no cloud action");
    await click("You");
    expect(flow.getAttribute("data-approved")).toBe("false");
    await click("Approve example");
    await click("Reset example");
    expect(flow.getAttribute("data-approved")).toBe("false");
  });

  it("explains all five real autonomy levels without changing a workspace", async () => {
    await render();
    const card = host.querySelector("#gimbal")!;
    for (const [level, meaning] of Object.entries(AUTONOMY_MEANING)) {
      await click(level, card);
      expect(card.querySelector('[role="status"]')?.textContent).toBe(meaning);
      expect(card.querySelector('button[aria-pressed="true"]')?.textContent).toBe(level);
    }
    expect(card.textContent).toContain("No workspace setting is changed.");
  });

  it("makes portable artifacts inspectable without a fake download button", async () => {
    await render();
    await click("System", host.querySelector("#ownership")!);
    expect(host.querySelector('#ownership [role="status"]')?.textContent).toContain("zenith.manifest.json");
    await click("Operations", host.querySelector("#ownership")!);
    expect(host.querySelector('#ownership [role="status"]')?.textContent).toContain("Operations / README.md");
    expect(host.querySelector("a[download]")).toBeNull();
  });

  it("keeps simulation, local support, preview and roadmap separate", async () => {
    await render();
    const text = host.querySelector("#cloud")!.textContent!;
    expect(text).toContain("Available · simulated");
    expect(text).toContain("Other operations remain simulated.");
    expect(text).toContain("No AWS API calls or in-app deployment.");
    expect(text).toContain("Google Cloud · Planned");
    expect(text).toContain("Product vision");
  });

  it("does not invent available providers when the registry is empty", async () => {
    await render([]);
    const text = host.querySelector("#cloud")!.textContent!;
    expect(text).toContain("Provider status is unavailable");
    expect(text).not.toContain("Available · local");
  });

  it("lets a visitor explore real team situations", async () => {
    await render();
    await click("AI-native", host.querySelector("#teams")!);
    expect(host.querySelector('#teams [role="status"]')?.textContent).toContain("more than code");
  });

  it("leaves a fully visible page with reduced motion and starts no entry animation", async () => {
    await render();
    expect(observe).not.toHaveBeenCalled();
    expect(host.querySelectorAll("[data-bento]")).toHaveLength(9);
    expect(host.textContent).toContain("Meet Zenith.");
  });
});

describe("presentation guardrails", () => {
  it("makes source changes revoke the example approval", () => {
    expect(approvalExampleReducer({ source: "agent", approved: true }, { type: "source", source: "you" })).toEqual({ source: "you", approved: false });
  });
  it("never promotes an unknown or mixed plan risk to low", () => {
    expect(planRiskLabel([])).toBe("No changes");
    expect(planRiskLabel([{ risk: "low" }])).toBe("Low risk");
    expect(planRiskLabel([{ risk: "low" }, { risk: "high" }])).toBe("Review risk in the plan");
    expect(planRiskLabel([{ risk: "unknown" }])).toBe("Review risk in the plan");
  });
  it("lets the registry override familiar provider identities", () => {
    expect(providerPresentation({ ...providers[0], availability: "planned" }).label).toBe("Planned");
    expect(providerPresentation({ ...providers[1], availability: "preview" }).label).toBe("Preview");
  });
  it("preserves an unfamiliar provider's registry description", () => {
    const row: ProviderRow = { id: "another-provider", displayName: "Another provider", availability: "available", tagline: "Only this documented capability." };
    expect(providerPresentation(row)).toEqual({ tone: "available", label: "Available", description: row.tagline });
  });
});
