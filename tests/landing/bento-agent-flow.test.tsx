import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BentoAgentFlow } from "@/app/_landing/bento-agent-flow";

// Keep this presentation-only test independent from the real scenario imports.
vi.mock("@/app/_landing/bento-visuals", () => ({ Glyph: () => <svg aria-hidden="true" /> }));

let host: HTMLDivElement;
let root: Root | null;
let intersect: IntersectionObserverCallback;
let reduced = false;
let hidden = false;
const mediaListeners = new Set<() => void>();
const observe = vi.fn();
const disconnect = vi.fn();
const request = vi.fn();

beforeEach(() => {
  reduced = false;
  hidden = false;
  mediaListeners.clear();
  observe.mockClear();
  disconnect.mockClear();
  request.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", request);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return reduced; },
    addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
  }));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render() { await act(async () => root!.render(<BentoAgentFlow />)); }
function loop() { return host.querySelector<HTMLElement>("[data-agent-loop]")!; }
function inView(ratio = 1) {
  intersect([{ isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry], {} as IntersectionObserver);
}
async function toggle() { await act(async () => host.querySelector<HTMLButtonElement>("button")!.click()); }

describe("agent illustration lifecycle", () => {
  it("starts automatically only in view, pauses offscreen and makes no network request", async () => {
    await render();
    expect(loop().dataset.loop).toBe("paused");
    inView();
    expect(loop().dataset.loop).toBe("running");
    inView(0.1);
    expect(loop().dataset.loop).toBe("paused");
    inView();
    expect(loop().dataset.loop).toBe("running");
    expect(request).not.toHaveBeenCalled();
  });

  it("pauses when the browser tab is hidden", async () => {
    await render();
    inView();
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(loop().dataset.loop).toBe("paused");
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(loop().dataset.loop).toBe("running");
  });

  it("offers only an optional media pause control, not an approval interaction", async () => {
    await render();
    inView();
    await toggle();
    inView();
    expect(loop().dataset.loop).toBe("paused");
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe("Play agent flow animation");
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(loop().dataset.loop).toBe("paused");
    await toggle();
    inView();
    expect(loop().dataset.loop).toBe("running");
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.textContent).not.toContain("Approve example");
    expect(host.querySelector('[role="status"], [aria-live]')).toBeNull();
  });

  it("starts as a static review diagram for reduced motion", async () => {
    reduced = true;
    await render();
    expect(loop().dataset.loop).toBe("still");
    expect(observe).not.toHaveBeenCalled();
    expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("No live cloud action");
  });

  it("handles live motion preference changes without timers or unmounting", async () => {
    await render();
    inView();
    reduced = true;
    mediaListeners.forEach((listener) => listener());
    expect(loop().dataset.loop).toBe("still");
    reduced = false;
    mediaListeners.forEach((listener) => listener());
    expect(loop().dataset.loop).toBe("paused");
    inView();
    expect(loop().dataset.loop).toBe("running");
  });

  it("falls back to a readable static diagram without observer support", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    await render();
    expect(loop().dataset.loop).toBe("still");
    expect(host.textContent).toContain("Review");
  });

  it("disconnects observers and removes listeners on unmount", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    await render();
    inView();
    expect(mediaListeners.size).toBe(1);
    disconnect.mockClear();
    await act(async () => root!.unmount());
    root = null;
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(mediaListeners.size).toBe(0);
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });
});
