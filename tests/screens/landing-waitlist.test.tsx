import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingWaitlist } from "@/app/_landing/landing-waitlist";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/app/_landing/landing-experience", () => ({ useLanding: () => ({ dispatch }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let showModal: ReturnType<typeof vi.fn>;
let closeModal: ReturnType<typeof vi.fn>;
const heroLink = () => host.querySelector<HTMLAnchorElement>('[data-chapter="hero"] a[href="/waitlist"]')!;
const render = (signedIn = false, mobile = false) => act(() => root.render(<div className="zenith-landing">
  {mobile && <header><a href="/waitlist" data-waitlist-trigger>Join waitlist</a></header>}
  <section data-chapter="hero"><a href="/waitlist">{signedIn ? "Check access" : "Join waitlist"}</a></section>
  <section data-chapter="resources"><a href="/waitlist">Standalone waitlist</a></section>
  <LandingWaitlist signedIn={signedIn} />
</div>));

beforeEach(() => {
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
    const trigger = heroLink();
    trigger.focus();
    act(() => trigger.click());
    expect(showModal).toHaveBeenCalledOnce();
    expect(document.body.style.overflow).toBe("hidden");
    const dialog = host.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(host.querySelector("[data-waitlist-title]"));
    act(() => dialog.dispatchEvent(new Event("cancel", { bubbles: false, cancelable: true })));
    expect(dialog.open).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps real link fallbacks, intercepting only unmodified visitor clicks", () => {
    render();
    const link = heroLink();
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
    const check = heroLink();
    expect(check.textContent).toBe("Check access");
    let intercepted: boolean | undefined;
    check.addEventListener("click", (event) => { intercepted = event.defaultPrevented; event.preventDefault(); }, { once: true });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => check.dispatchEvent(event));
    expect(intercepted).toBe(false);
    expect(showModal).not.toHaveBeenCalled();
  });

  it("lets waitlist links outside the hero navigate normally", () => {
    render();
    const link = host.querySelector<HTMLAnchorElement>('[data-chapter="resources"] a[href="/waitlist"]')!;
    let intercepted: boolean | undefined;
    link.addEventListener("click", (event) => { intercepted = event.defaultPrevented; event.preventDefault(); }, { once: true });
    act(() => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(intercepted).toBe(false);
    expect(showModal).not.toHaveBeenCalled();
    expect(link.getAttribute("href")).toBe("/waitlist");
  });

  it("uses the hero link without adding a floating Join waitlist button", () => {
    render();
    expect(heroLink().textContent).toBe("Join waitlist");
    expect([...host.querySelectorAll("button")].filter(element => !element.closest("dialog"))).toHaveLength(0);
    expect([...host.querySelectorAll("a, button")].filter(element => !element.closest("dialog") && element.textContent === "Join waitlist")).toEqual([heroLink()]);
  });

  it("opens from the explicit mobile header action and follows the visible keyboard viewport", () => {
    const viewport = Object.assign(new EventTarget(), { height: 520, offsetTop: 12 });
    vi.stubGlobal("visualViewport", viewport);
    render(false, true);
    const trigger = host.querySelector<HTMLAnchorElement>("header [data-waitlist-trigger]")!;
    trigger.focus();
    act(() => trigger.click());
    const dialog = host.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(showModal).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(host.querySelector("[data-waitlist-title]"));
    expect(dialog.style.getPropertyValue("--waitlist-viewport")).toBe("520px");
    expect(dialog.style.getPropertyValue("--waitlist-top")).toBe("12px");
    viewport.height = 330;
    act(() => viewport.dispatchEvent(new Event("resize")));
    expect(dialog.style.getPropertyValue("--waitlist-viewport")).toBe("330px");
    act(() => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("");
  });
});
