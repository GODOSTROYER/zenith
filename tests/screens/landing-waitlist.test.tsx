import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingWaitlist } from "@/app/_landing/landing-waitlist";

const state = vi.hoisted(() => ({ companion: { open: false }, walkthrough: null as object | null }));
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/app/_landing/landing-experience", () => ({ useLanding: () => ({ state, dispatch }) }));
vi.mock("@/app/_landing/liquid-glass", () => ({ GLASS: { bar: {} }, useLiquidGlass() {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let showModal: ReturnType<typeof vi.fn>;
let closeModal: ReturnType<typeof vi.fn>;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === label || element.getAttribute("aria-label") === label)!;
const render = (signedIn = false) => act(() => root.render(<div className="zenith-landing"><a href="/waitlist">Main action</a><LandingWaitlist signedIn={signedIn} /></div>));

beforeEach(() => {
  state.companion.open = false;
  state.walkthrough = null;
  dispatch.mockClear();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  closeModal = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
  HTMLDialogElement.prototype.showModal = showModal;
  HTMLDialogElement.prototype.close = closeModal;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("landing waitlist dialog", () => {
  it("opens as a native modal, holds page scrolling, and restores focus after Escape", () => {
    render();
    const trigger = button("Join waitlist");
    trigger.focus();
    act(() => trigger.click());
    expect(showModal).toHaveBeenCalledOnce();
    expect(document.body.style.overflow).toBe("hidden");
    expect(trigger.closest("[inert]")).not.toBeNull();
    const dialog = host.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(host.querySelector("[data-waitlist-title]"));
    act(() => dialog.dispatchEvent(new Event("cancel", { bubbles: false, cancelable: true })));
    expect(dialog.open).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(trigger.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps real link fallbacks, intercepting only unmodified visitor clicks", () => {
    render();
    const link = host.querySelector<HTMLAnchorElement>('a[href="/waitlist"]')!;
    let intercepted: boolean | undefined;
    link.addEventListener("click", (event) => { intercepted = event.defaultPrevented; event.preventDefault(); }, { once: true });
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    act(() => link.dispatchEvent(modified));
    expect(intercepted).toBe(false);
    expect(showModal).not.toHaveBeenCalled();
    const ordinary = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => link.dispatchEvent(ordinary));
    expect(ordinary.defaultPrevented).toBe(true);
    expect(showModal).toHaveBeenCalledOnce();
    expect(link.getAttribute("href")).toBe("/waitlist");
  });

  it("lets signed-in people navigate to their access check instead of anonymous intake", () => {
    render(true);
    expect(button("Join waitlist")).toBeUndefined();
    const check = [...host.querySelectorAll<HTMLAnchorElement>('a[href="/waitlist"]')].find(element => element.textContent === "Check access")!;
    let intercepted: boolean | undefined;
    check.addEventListener("click", (event) => { intercepted = event.defaultPrevented; event.preventDefault(); }, { once: true });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => check.dispatchEvent(event));
    expect(intercepted).toBe(false);
    expect(showModal).not.toHaveBeenCalled();
  });

  it("makes Gimbal available from the capsule and keeps the capsule out of an active guide", () => {
    render();
    act(() => button("Ask Gimbal").click());
    expect(dispatch).toHaveBeenCalledWith({ type: "companion-open" });
    state.companion.open = true;
    render();
    expect(button("Join waitlist").closest("[inert]")).not.toBeNull();
  });
});
