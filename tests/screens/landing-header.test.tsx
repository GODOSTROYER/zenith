import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cta } from "@/app/_landing/cta";
import { LandingHeader } from "@/app/_landing/landing-header";

vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@/app/_landing/landing-motion", () => ({ useHeaderState: vi.fn() }));
vi.mock("@/app/_landing/liquid-glass", () => ({ GLASS: { bar: {}, button: {} }, useLiquidGlass: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const visitor: Cta = { href: "/waitlist", label: "Join waitlist", signedIn: false };
let root: Root;
let host: HTMLDivElement;
const render = (cta: Cta = visitor) => act(() => root.render(<LandingHeader cta={cta} />));
const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-controls="zenith-mobile-nav"]')!;
const menu = () => host.querySelector<HTMLElement>('nav[aria-label="Mobile navigation"]');
const openMenu = () => act(() => toggle().click());
const clickLink = (link: HTMLAnchorElement) => {
  link.addEventListener("click", (event) => event.preventDefault(), { once: true });
  act(() => link.click());
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("landing header", () => {
  it("offers visitors a mobile waitlist dialog trigger and a separate desktop sign-in link", () => {
    render();
    const waitlist = host.querySelector<HTMLAnchorElement>(".zenith-mobile-waitlist")!;
    expect(waitlist.textContent).toBe("Join waitlist");
    expect(waitlist.getAttribute("href")).toBe("/waitlist");
    expect(waitlist.getAttribute("aria-haspopup")).toBe("dialog");
    expect(waitlist.hasAttribute("data-waitlist-trigger")).toBe(true);

    const signIn = host.querySelector<HTMLAnchorElement>(".zenith-header-sign-in")!;
    expect(signIn.textContent).toBe("Sign in");
    expect(signIn.getAttribute("href")).toBe("/login");
    expect(signIn.hasAttribute("data-waitlist-trigger")).toBe(false);

    openMenu();
    expect(menu()!.querySelector('a[href="/login"]')?.textContent).toBe("Sign in");
    expect(menu()!.querySelector('a[href="/waitlist"]')).toBeNull();
  });

  it.each([
    { href: "/waitlist", label: "Check access" },
    { href: "/overview", label: "Open Zenith" },
    { href: "/onboarding", label: "Continue setup" },
  ])("preserves the signed-in $label destination without anonymous intake", ({ href, label }) => {
    render({ href, label, signedIn: true });
    const primary = host.querySelector<HTMLAnchorElement>(".zenith-header-actions a")!;
    expect(primary.textContent).toBe(label);
    expect(primary.getAttribute("href")).toBe(href);
    expect(primary.hasAttribute("aria-haspopup")).toBe(false);
    expect(host.querySelector("[data-waitlist-trigger]")).toBeNull();
    expect(host.querySelector(".zenith-mobile-waitlist")).toBeNull();

    openMenu();
    const destination = menu()!.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;
    expect(destination.textContent).toBe(label);
    expect(menu()!.querySelector('a[href="/login"]')).toBeNull();
    clickLink(destination);
    expect(menu()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the menu toggle's expanded state and accessible name in sync", () => {
    render();
    expect(menu()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe("Open navigation");
    openMenu();
    expect(menu()?.id).toBe(toggle().getAttribute("aria-controls"));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().getAttribute("aria-label")).toBe("Close navigation");
    act(() => toggle().click());
    expect(menu()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape from a menu link and restores focus to the toggle", () => {
    render();
    openMenu();
    const link = menu()!.querySelector<HTMLAnchorElement>("a")!;
    link.focus();
    expect(document.activeElement).toBe(link);
    act(() => link.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(menu()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle());
  });

  it("closes after clicking outside the header while keeping inside pointer interactions open", () => {
    render();
    openMenu();
    act(() => menu()!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(menu()).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      document.body.click();
    });
    expect(menu()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes an open menu when the visitor activates the mobile waitlist action", () => {
    render();
    openMenu();
    clickLink(host.querySelector<HTMLAnchorElement>(".zenith-mobile-waitlist")!);
    expect(menu()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });
});
