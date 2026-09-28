import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GlassCta } from "@/app/_landing/landing-cta";

vi.mock("@/app/_landing/liquid-glass", () => ({ GLASS: { button: {} }, useLiquidGlass() {} }));

describe("hero early-access action", () => {
  it("renders one dark glass waitlist link with a warm dot and no chat action", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<GlassCta cta={{ href: "/waitlist", label: "Join waitlist", signedIn: false }} />);
    expect(host.querySelectorAll('a[href="/waitlist"]')).toHaveLength(1);
    const link = host.querySelector("a")!;
    expect(link.classList.contains("zenith-cta-waitlist")).toBe(true);
    expect(link.getAttribute("aria-haspopup")).toBe("dialog");
    expect(link.querySelector(".zenith-waitlist-dot")).not.toBeNull();
    expect(link.querySelectorAll("svg")).toHaveLength(1);
    expect(host.querySelector("button")).toBeNull();
  });

  it("preserves admitted and waiting account destinations without enrollment styling", () => {
    for (const href of ["/overview", "/onboarding", "/waitlist"]) {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(<GlassCta cta={{ href, label: "Continue", signedIn: true }} />);
      expect(host.querySelector("a")?.getAttribute("href")).toBe(href);
      expect(host.querySelector(".zenith-cta-waitlist, .zenith-waitlist-dot")).toBeNull();
      expect(host.querySelector("[aria-haspopup]")).toBeNull();
    }
  });
});
