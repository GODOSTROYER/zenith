import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/shell/command-palette";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/overview" }));
vi.mock("@/components/shell/shell-context", () => ({
  useShell: () => ({ boot: { projects: [{ name: "Atlas", slug: "atlas" }], role: "admin" } }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  router.push.mockClear();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CommandPalette keyboard dismissal", () => {
  it.each(["", "no-matching-screen"])("Escape closes the search combobox for query %j and restores its trigger", (query) => {
    act(() => root.render(<CommandPalette catalog={[]} />));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    act(() => { trigger.focus(); trigger.click(); });
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    if (query) act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelectorAll('[role="option"]').length > 0).toBe(query === "");

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(router.push).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
