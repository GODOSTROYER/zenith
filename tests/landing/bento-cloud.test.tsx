import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BentoCloudCluster } from "@/app/_landing/bento-cloud";
import { CLOUD_BRANDS, CloudLogo } from "@/app/_landing/bento-cloud-visuals";
import type { ProviderRow } from "@/app/_landing/landing";

vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/app/_landing/landing-experience", () => ({ useHighlight: () => undefined }));

const providers: ProviderRow[] = [
  { id: "aws", displayName: "AWS", availability: "preview", tagline: "AWS Preview" },
  { id: "gcp", displayName: "Google Cloud", availability: "planned", tagline: "Not available yet." },
  { id: "oracle-coming-later", displayName: "Oracle Cloud", availability: "planned", tagline: "Coming later." },
  { id: "sandbox", displayName: "Sandbox", availability: "available", tagline: "Simulated" },
  { id: "localstack", displayName: "LocalStack", availability: "available", tagline: "Local operations" },
];
let host: HTMLDivElement;
let root: Root;
let notify: IntersectionObserverCallback;
let motion: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
let preferences: Set<() => void>;
const observe = vi.fn();
const disconnect = vi.fn();
const fetchSpy = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockClear(); observe.mockClear(); disconnect.mockClear();
  preferences = new Set();
  motion = {
    matches: false,
    addEventListener: vi.fn((_name: string, listener: () => void) => preferences.add(listener)),
    removeEventListener: vi.fn((_name: string, listener: () => void) => preferences.delete(listener)),
  };
  vi.stubGlobal("matchMedia", () => motion);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { notify = callback; }
    observe = observe;
    unobserve = vi.fn();
    disconnect = disconnect;
  });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(rows = providers) {
  await act(async () => root.render(<BentoCloudCluster providers={rows}><article id="teams">Existing team card</article></BentoCloudCluster>));
}
function cluster() { return host.querySelector<HTMLElement>("#cloud")!; }
function scenes() { return Array.from(host.querySelectorAll<HTMLElement>("[data-cloud-scene]")); }
async function intersect(index: number, visible: boolean) {
  const target = scenes()[index];
  const rect = target.getBoundingClientRect();
  const entry: IntersectionObserverEntry = {
    target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0,
    boundingClientRect: rect, intersectionRect: rect, rootBounds: null, time: 0,
  };
  await act(async () => notify([entry], {} as IntersectionObserver));
}
async function setReduced(value: boolean) {
  await act(async () => { motion.matches = value; preferences.forEach((listener) => listener()); });
}

describe("hosting bento composition", () => {
  it("features managed hosting and multicloud, with only compact development labels", async () => {
    await render();
    expect(cluster().getAttribute("data-chapter")).toBe("cloud");
    expect(host.querySelector("#hosting-title")?.textContent).toBe("You build it.Zenith runs it.");
    expect(host.querySelector("#hosting")?.textContent).toContain("In development");
    expect(host.querySelector("#multicloud")?.textContent).toContain("Concept");
    expect(host.querySelectorAll("[data-bento]")).toHaveLength(3);
    expect(host.querySelectorAll("#teams")).toHaveLength(1);
    expect(host.querySelector("h1, pre, code, [aria-live], [role=status]")).toBeNull();
    expect(cluster().textContent).not.toMatch(/cheapest|lowest cost|optimized automatically|zero overhead|\$\d/i);
  });

  it("keeps brand identities and capability detail separate", async () => {
    await render();
    const collection = host.querySelector('[aria-label="Cloud roadmap and deployment options"]')!;
    expect(collection.querySelectorAll("img")).toHaveLength(5);
    expect(collection.textContent).toContain("Kubernetes");
    expect(collection.textContent).not.toContain("Available");
    const details = host.querySelector("details")!;
    expect(details.open).toBe(false);
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("No AWS API calls or in-app deployment.");
    expect(details.textContent).toContain("Available · simulated");
    expect(details.textContent).toContain("Other operations remain simulated.");
    expect(details.textContent).toContain("Local development");
    expect(details.querySelectorAll('[data-status="planned"]')).toHaveLength(2);
    expect(details.querySelectorAll('[data-cloud-logo="localstack"]')).toHaveLength(1);
  });

  it("uses existing guide routes instead of inventing a deployment or waitlist flow", async () => {
    await render();
    expect(Array.from(host.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["/guide", "/guide"]);
    expect(host.querySelector("form, input")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads provider availability from the supplied registry, including unknown providers", async () => {
    const future: ProviderRow = { id: "future", displayName: "Future cloud", availability: "preview", tagline: "Review-only support." };
    await render([{ ...providers[0], availability: "planned" }, future]);
    const details = host.querySelector("details")!;
    expect(details.querySelectorAll('[data-status="planned"]')).toHaveLength(1);
    expect(details.textContent).toContain("Review-only support.");
    expect(details.textContent).not.toContain("Available · local");
  });

  it("does not manufacture registry availability when the list is empty", async () => {
    await render([]);
    expect(host.querySelector("details")?.textContent).toContain("Provider status is unavailable");
    expect(host.querySelectorAll("[data-status]")).toHaveLength(0);
  });

  it("provides a readable static description of both illustrations", async () => {
    await render();
    expect(scenes()).toHaveLength(2);
    expect(scenes()[0].getAttribute("aria-label")).toContain("managed by Zenith");
    expect(scenes()[1].getAttribute("aria-label")).toContain("AWS compute and Google Cloud storage");
    expect(scenes()[1].getAttribute("aria-label")).toContain("not live routing");
  });

  it("ships local SVG assets for every referenced logo, with an Oracle alias", async () => {
    for (const brand of CLOUD_BRANDS) {
      const svg = readFileSync(join(process.cwd(), "public/cloud-logos", `${brand.asset}.svg`), "utf8");
      expect(svg).toContain("<svg");
      expect(svg).not.toMatch(/<script|<foreignObject/i);
    }
    await act(async () => root.render(<CloudLogo id="oracle-coming-later" />));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/cloud-logos/oracle.svg");
  });
});

describe("independent hosting motion lifecycle", () => {
  it("starts only in view and pauses each scene when it leaves", async () => {
    await render();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(cluster().dataset.cloudMotion).toBe("paused");
    await intersect(0, true);
    expect(cluster().dataset.cloudMotion).toBe("running");
    expect(scenes()[0].dataset.sceneVisible).toBe("true");
    expect(scenes()[1].dataset.sceneVisible).toBe("false");
    await intersect(1, true);
    await intersect(0, false);
    expect(cluster().dataset.cloudMotion).toBe("running");
    expect(scenes()[0].dataset.sceneVisible).toBe("false");
    await intersect(1, false);
    expect(cluster().dataset.cloudMotion).toBe("paused");
  });

  it("pauses and resumes without recreating observers or restarting CSS timelines", async () => {
    await render(); await intersect(0, true);
    const count = disconnect.mock.calls.length;
    const button = host.querySelector<HTMLButtonElement>('button[aria-controls]')!;
    await act(async () => button.click());
    expect(cluster().dataset.userPaused).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Play hosting animations");
    expect(disconnect).toHaveBeenCalledTimes(count);
    await act(async () => button.click());
    expect(cluster().dataset.userPaused).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Pause hosting animations");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pauses hidden tabs and resumes without losing manual pause", async () => {
    await render(); await intersect(0, true);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-controls]')!.click());
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(cluster().dataset.cloudMotion).toBe("paused");
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(cluster().dataset.cloudMotion).toBe("running");
    expect(cluster().dataset.userPaused).toBe("true");
  });

  it("never observes or animates for an initial reduced-motion preference", async () => {
    motion.matches = true;
    await render();
    expect(cluster().dataset.cloudMotion).toBe("still");
    expect(observe).not.toHaveBeenCalled();
    expect(scenes()).toHaveLength(2);
  });

  it("reacts to motion preference changes in both directions", async () => {
    await render(); await intersect(0, true);
    await setReduced(true);
    expect(cluster().dataset.cloudMotion).toBe("still");
    await setReduced(false);
    expect(cluster().dataset.cloudMotion).toBe("paused");
    await intersect(1, true);
    expect(cluster().dataset.cloudMotion).toBe("running");
  });

  it("falls back to a complete static illustration without an observer API", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    await render();
    expect(cluster().dataset.cloudMotion).toBe("still");
    expect(scenes()).toHaveLength(2);
  });

  it("removes observers and preference/document listeners on unmount", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    await render(); await intersect(0, true);
    const element = cluster();
    await act(async () => root.render(null));
    expect(disconnect).toHaveBeenCalled();
    expect(preferences.size).toBe(0);
    expect(remove.mock.calls.some(([name]) => name === "visibilitychange")).toBe(true);
    expect(element.dataset.cloudMotion).toBe("still");
  });
});
