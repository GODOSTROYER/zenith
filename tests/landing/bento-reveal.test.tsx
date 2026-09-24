import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BENTO_REVEAL, installBentoReveal } from "@/app/_landing/bento-reveal-runtime";
import { installBentoMicro } from "@/app/_landing/bento-micro-runtime";

let root: HTMLDivElement;
let cleanup: () => void;
let hidden: boolean;
let notify: IntersectionObserverCallback;
const observe = vi.fn();
const disconnect = vi.fn();
const media = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
const frames = new Map<number, FrameRequestCallback>();
const animations: Array<{ target: Element; frames: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null; oncancel: (() => void) | null }> = [];
let originalAnimate: PropertyDescriptor | undefined;
let sequence = 0;

beforeEach(() => {
  hidden = false; cleanup = () => undefined; media.clear(); frames.clear(); animations.length = 0;
  observe.mockClear(); disconnect.mockClear();
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("matchMedia", (query: string) => {
    let state = media.get(query);
    if (!state) { state = { matches: query.includes("pointer: fine"), listeners: new Set() }; media.set(query, state); }
    return { get matches() { return state!.matches; }, addEventListener: (_: string, listener: () => void) => state!.listeners.add(listener), removeEventListener: (_: string, listener: () => void) => state!.listeners.delete(listener) };
  });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { notify = callback; }
    observe = observe; disconnect = disconnect; unobserve = vi.fn();
  });
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = { target: this, frames: keyframes, options, onfinish: null as (() => void) | null, oncancel: null as (() => void) | null, cancel: vi.fn() };
    animation.cancel.mockImplementation(() => animation.oncancel?.());
    animations.push(animation);
    return animation;
  } });
  root = document.createElement("div");
  root.innerHTML = Array.from({ length: 4 }, (_, index) => `<article data-bento id="card-${index}"><header><h3>Readable title ${index}</h3></header><div data-bento-art><button>Use it</button><div data-agent-loop>Independent loop</div></div></article>`).join("");
  document.body.append(root);
});
afterEach(() => {
  cleanup(); root.remove();
  if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else delete (Element.prototype as Partial<Element>).animate;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function entries(indices: number[], visible = true) {
  return indices.map((index): IntersectionObserverEntry => {
    const target = root.querySelectorAll("article")[index];
    const rect = target.getBoundingClientRect();
    return { target, boundingClientRect: rect, intersectionRect: rect, rootBounds: null, time: 0, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 };
  });
}
function enter(indices = [0]) { notify(entries(indices), {} as IntersectionObserver); }
function preference(query: string, value: boolean) { const state = media.get(query)!; state.matches = value; state.listeners.forEach((listener) => listener()); }
function start() { cleanup = installBentoReveal(root); }
function focusControl(button: HTMLButtonElement) {
  button.focus();
  // Exercise the delegated event deterministically in JSDOM. Native browser
  // focus behavior is checked by landing-polish-browser.ts; a second delivery
  // here also verifies that settling an already-settled card is idempotent.
  button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(document.activeElement).toBe(button);
}

describe("bento reveal choreography", () => {
  it("renders complete content and schedules nothing before intersection", () => {
    start(); expect(animations).toHaveLength(0); expect(root.textContent).toContain("Readable title");
    expect(root.querySelector("[hidden]")).toBeNull(); expect(frames.size).toBe(0);
  });
  it("keeps the card coordinate system stationary while heading and art settle", () => {
    start(); enter(); expect(animations).toHaveLength(3);
    const surface = animations.find((animation) => animation.target.matches("article"))!;
    expect(surface.frames.every((frame) => !("transform" in frame) && !("translate" in frame))).toBe(true);
    expect(animations.find((animation) => animation.target.matches("h3"))?.options.duration).toBe(BENTO_REVEAL.heading);
    expect(animations.some((animation) => animation.target.matches("[data-agent-loop]"))).toBe(false);
  });
  it("uses DOM order and a bounded stagger even for a large observer batch", () => {
    start(); enter([3, 1, 2, 0]);
    expect(animations[0].target.id).toBe("card-0");
    const surfaces = animations.filter((animation) => animation.target.matches("article"));
    expect(surfaces.map((animation) => animation.options.delay)).toEqual([0, 55, 110, 110]);
  });
  it("does not replay cards on repeated intersection", () => {
    start(); enter(); enter(); expect(animations).toHaveLength(3);
  });
  it.each(["focus", "focusin", "pointerdown"])("settles owned reveals on %s without double cancellation", (type) => {
    start(); enter();
    const pending = [...animations];
    expect(pending).toHaveLength(3);
    const button = root.querySelector("button")!;
    // The runtime contract is event delegation, not a JSDOM focus implementation.
    // Native keyboard focus is exercised against the production page in Chromium.
    const event = () => type === "pointerdown"
      ? new Event(type, { bubbles: true })
      : new FocusEvent(type, { bubbles: type === "focusin" });
    button.dispatchEvent(event());
    button.dispatchEvent(event());
    expect(pending.map((animation) => ({
      target: animation.target.tagName,
      cancellations: animation.cancel.mock.calls.length,
    }))).toEqual([
      { target: "ARTICLE", cancellations: 1 },
      { target: "H3", cancellations: 1 },
      { target: "DIV", cancellations: 1 },
    ]);
    expect(button.isConnected).toBe(true);
    expect(button.textContent).toBe("Use it");
  });
  it("never animates a card that the user is already operating", () => {
    start(); focusControl(root.querySelector("button")!); enter(); expect(animations).toHaveLength(0);
  });
  it("cancels when offscreen and does not cancel an independent scene", () => {
    start(); enter(); notify(entries([0], false), {} as IntersectionObserver);
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
    enter(); expect(animations).toHaveLength(3);
  });
  it.each(["(prefers-reduced-motion: reduce)", "(forced-colors: active)"])("settles for a dynamic %s preference", (query) => {
    start(); enter(); preference(query, true);
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
    enter([1]); expect(animations).toHaveLength(3);
    preference(query, false); enter([1]); expect(animations).toHaveLength(6);
  });
  it("pauses hidden-tab work and does not replay completed reveals", () => {
    start(); enter(); hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
    hidden = false; document.dispatchEvent(new Event("visibilitychange")); enter(); expect(animations).toHaveLength(3);
  });
  it("degrades without observer support", () => {
    vi.stubGlobal("IntersectionObserver", undefined); start(); expect(animations).toHaveLength(0); expect(root.textContent).toContain("Readable title");
  });
  it("releases listeners and animations on cleanup", () => {
    start(); enter(); cleanup(); expect(disconnect).toHaveBeenCalled();
    for (const state of media.values()) expect(state.listeners.size).toBe(0);
    enter([1]); expect(animations).toHaveLength(3);
  });
});

describe("bounded artwork depth", () => {
  function move() {
    const card = root.querySelector("article")!;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}) });
    const event = new Event("pointermove", { bubbles: true });
    Object.defineProperties(event, { pointerType: { value: "mouse" }, clientX: { value: 900 }, clientY: { value: 900 } });
    card.dispatchEvent(event);
    for (const [id, callback] of frames) { frames.delete(id); callback(0); }
    return card;
  }
  it("clamps artwork offsets without idle animation frames", () => {
    cleanup = installBentoMicro(root); const card = move();
    expect(card.style.getPropertyValue("--micro-dx")).toBe("4.00px");
    expect(card.style.getPropertyValue("--micro-dy")).toBe("3.00px");
    expect(frames.size).toBe(0);
  });
  it.each(["scroll", "blur", "pointercancel"])("clears residual depth on %s", (name) => {
    cleanup = installBentoMicro(root); const card = move();
    (name === "pointercancel" ? root : window).dispatchEvent(new Event(name));
    expect(card.style.getPropertyValue("--micro-dx")).toBe("");
    expect(card.style.getPropertyValue("--micro-dy")).toBe("");
    expect(card.hasAttribute("data-micro-hover")).toBe(false);
  });
  it("recenters when keyboard focus enters a card", () => {
    cleanup = installBentoMicro(root); const card = move(); focusControl(root.querySelector("button")!);
    expect(card.style.getPropertyValue("--micro-dx")).toBe("");
    expect(card.dataset.microFocus).toBe("true");
  });
});
