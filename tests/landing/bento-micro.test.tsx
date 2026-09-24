import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBentoMicro, MICRO_MOTION } from "@/app/_landing/bento-micro-runtime";

let root: HTMLDivElement;
let cleanup: () => void;
let hidden: boolean;
let rafId = 0;
const frames = new Map<number, FrameRequestCallback>();
const media = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
const animations: Array<{ cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null; oncancel: (() => void) | null }> = [];
const observers: Array<{ callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }> = [];

function dimensions(element: Element): DOMRect {
  const node = element as HTMLElement;
  const isPill = node.hasAttribute("data-micro-pill");
  const translation = node.style?.transform.match(/translate\(([-.\d]+)px, ([-.\d]+)px\)/);
  const x = isPill ? Number(translation?.[1] ?? 0) : Number(node.dataset?.x ?? 0);
  const y = Number(node.dataset?.y ?? 0);
  const width = isPill ? Number.parseFloat(node.style.width) || 0 : Number(node.dataset?.w ?? 300);
  const height = isPill ? Number.parseFloat(node.style.height) || 0 : Number(node.dataset?.h ?? 60);
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) };
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }
function preference(query: string, value: boolean) {
  const entry = media.get(query)!;
  entry.matches = value;
  entry.listeners.forEach((listener) => listener());
}
function move(type = "mouse") {
  const event = new Event("pointermove", { bubbles: true });
  Object.defineProperties(event, { pointerType: { value: type }, clientX: { value: 100 }, clientY: { value: 50 } });
  root.querySelector("[data-bento]")!.dispatchEvent(event);
}
function flushFrames() {
  for (const [id, callback] of frames) { frames.delete(id); callback(0); }
}

beforeEach(() => {
  hidden = false;
  media.clear(); frames.clear(); animations.length = 0; observers.length = 0;
  cleanup = () => undefined;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("matchMedia", (query: string) => {
    let state = media.get(query);
    if (!state) { state = { matches: query.includes("pointer: fine"), listeners: new Set() }; media.set(query, state); }
    return { get matches() { return state!.matches; }, addEventListener: (_: string, cb: () => void) => state!.listeners.add(cb), removeEventListener: (_: string, cb: () => void) => state!.listeners.delete(cb) };
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++rafId, callback); return rafId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("IntersectionObserver", class {
    callback: IntersectionObserverCallback;
    observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
    constructor(callback: IntersectionObserverCallback) { this.callback = callback; observers.push(this); }
  });
  vi.stubGlobal("ResizeObserver", class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) { return dimensions(this); });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) { return Number(this.dataset.x ?? 0); });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) { return Number(this.dataset.y ?? 0); });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return Number(this.dataset.w ?? 100); });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return Number(this.dataset.h ?? 44); });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: vi.fn(() => {
    const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null, oncancel: null as (() => void) | null };
    animations.push(animation);
    return animation as unknown as Animation;
  }) });
  root = document.createElement("div");
  root.innerHTML = `<article data-bento>
    <div data-micro-group="view"><span data-micro-pill aria-hidden="true"></span><button aria-pressed="true" data-x="0">Current</button><button aria-pressed="false" data-x="104">Proposed</button></div>
    <p data-micro-change="text" data-micro-value="current">Actual content</p>
    <div data-micro-change="map" data-micro-value="app"><svg><path data-micro-beam d="M0 0H100" pathLength="1" /></svg></div>
    <details data-micro-details><summary>Details</summary><div data-micro-disclosure>Real information</div></details>
  </article>`;
  document.body.append(root);
});
afterEach(() => {
  cleanup(); root.remove(); delete (Element.prototype as Partial<Element>).animate;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const start = () => { cleanup = installBentoMicro(root); };

describe("bento micro motion", () => {
  it("is a progressive enhancement: no content hidden and no animation on mount", () => {
    start();
    expect(root.textContent).toContain("Actual content");
    expect(animations).toHaveLength(0);
    expect(root.querySelector("[data-micro-group]")?.getAttribute("data-micro-ready")).toBe("true");
  });
  it("glides the pill to the real selected control without changing button state", async () => {
    start();
    const buttons = root.querySelectorAll("button");
    buttons[0].setAttribute("aria-pressed", "false"); buttons[1].setAttribute("aria-pressed", "true");
    await flush();
    expect((root.querySelector("[data-micro-pill]") as HTMLElement).style.transform).toContain("104px");
    expect(animations).toHaveLength(1);
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
  });
  it("transitions a changed value without modifying or duplicating its text", async () => {
    start();
    const text = root.querySelector("p")!;
    text.textContent = "New actual content"; text.dataset.microValue = "proposed";
    await flush();
    expect(animations).toHaveLength(1);
    expect(text.textContent).toBe("New actual content");
    expect(root.querySelectorAll("p")).toHaveLength(1);
  });
  it("does not replay a value that did not change", async () => {
    start(); root.querySelector("p")!.dataset.microValue = "current";
    await flush(); expect(animations).toHaveLength(0);
  });
  it("cancels an interrupted animation before starting the next one", async () => {
    start(); root.querySelector("p")!.dataset.microValue = "one"; await flush();
    root.querySelector("p")!.dataset.microValue = "two"; await flush();
    expect(animations).toHaveLength(2); expect(animations[0].cancel).toHaveBeenCalledOnce();
  });
  it("traces only the marked system relationships, once", async () => {
    start(); root.querySelector<HTMLElement>('[data-micro-change="map"]')!.dataset.microValue = "worker"; await flush();
    expect(animations).toHaveLength(1);
    expect(Element.prototype.animate).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ duration: MICRO_MOTION.trace }));
  });
  it("batches cursor movement into one frame and schedules nothing at idle", () => {
    start(); move(); move(); move();
    expect(frames.size).toBe(1); flushFrames(); expect(frames.size).toBe(0);
    expect(root.querySelector("article")?.dataset.microHover).toBe("true");
  });
  it("ignores synthetic hover from touch pointers", () => {
    start(); move("touch"); flushFrames();
    expect(root.querySelector("article")?.dataset.microHover).toBeUndefined();
    expect(frames.size).toBe(0);
  });
  it("ignores mouse hover on coarse/no-hover devices", () => {
    start(); preference("(hover: hover) and (pointer: fine)", false); move();
    expect(frames.size).toBe(0);
  });
  it("provides equivalent card emphasis on keyboard focus, then cleans up", () => {
    start(); root.querySelector("button")!.focus();
    expect(root.querySelector("article")?.dataset.microFocus).toBe("true");
    root.querySelector("button")!.blur();
    expect(root.querySelector("article")?.dataset.microFocus).toBeUndefined();
  });
  it("opens native details immediately and enhances only its contents", async () => {
    start(); root.querySelector("details")!.open = true; await flush();
    expect(root.querySelector("details")!.open).toBe(true); expect(animations).toHaveLength(1);
    root.querySelector("details")!.open = false; await flush();
    expect(root.querySelector("details")!.open).toBe(false); expect(animations).toHaveLength(1);
  });
  it("responds to reduced motion mid-interaction, leaving the final state", async () => {
    start(); root.querySelector("p")!.dataset.microValue = "new"; await flush(); move();
    preference("(prefers-reduced-motion: reduce)", true);
    expect(animations[0].cancel).toHaveBeenCalled(); expect(frames.size).toBe(0);
    expect(root.dataset.microPolicy).toBe("still");
    expect(root.querySelector("[data-micro-group]")?.hasAttribute("data-micro-ready")).toBe(false);
    root.querySelector("p")!.dataset.microValue = "final"; await flush();
    expect(animations).toHaveLength(1); expect(root.textContent).toContain("Actual content");
  });
  it("uses native button backgrounds in forced colors", () => {
    start(); preference("(forced-colors: active)", true);
    expect(root.querySelector("[data-micro-group]")?.hasAttribute("data-micro-ready")).toBe(false);
  });
  it("cancels transient animation and cursor work in a hidden tab", async () => {
    start(); root.querySelector("p")!.dataset.microValue = "new"; await flush(); move();
    hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    expect(animations[0].cancel).toHaveBeenCalled(); expect(frames.size).toBe(0);
  });
  it("stops transient work when its card leaves the viewport", async () => {
    start(); root.querySelector("p")!.dataset.microValue = "new"; await flush();
    const target = root.querySelector("article")!;
    const rect = target.getBoundingClientRect();
    const entry: IntersectionObserverEntry = { target, isIntersecting: false, intersectionRatio: 0, time: 0, boundingClientRect: rect, intersectionRect: rect, rootBounds: null };
    observers[0].callback([entry], {} as IntersectionObserver);
    expect(animations[0].cancel).toHaveBeenCalled();
  });
  it("cleans up observers, media listeners, frames, and transient inline styles", () => {
    start(); move(); cleanup();
    expect(frames.size).toBe(0); expect(observers[0].disconnect).toHaveBeenCalled();
    for (const state of media.values()) expect(state.listeners.size).toBe(0);
    expect(root.querySelector("[data-micro-pill]")?.hasAttribute("style")).toBe(false);
    move(); expect(frames.size).toBe(0);
  });
  it("keeps content usable without browser animation support", async () => {
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: undefined });
    start(); root.querySelector("p")!.dataset.microValue = "new"; await flush();
    expect(root.textContent).toContain("Actual content"); expect(animations).toHaveLength(0);
  });
  it("degrades safely without intersection or resize observers", async () => {
    vi.stubGlobal("IntersectionObserver", undefined); vi.stubGlobal("ResizeObserver", undefined);
    start(); root.querySelector("p")!.dataset.microValue = "new"; await flush();
    expect(animations).toHaveLength(1); expect(() => cleanup()).not.toThrow();
  });
});
