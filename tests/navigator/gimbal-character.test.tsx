import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GimbalCharacter } from "@/components/navigator/gimbal-character";
import type { GimbalRendererOptions } from "@/components/navigator/gimbal-renderer";

const fake = vi.hoisted(() => ({ create: vi.fn(), runtime: {
  setState: vi.fn(), setReducedMotion: vi.fn(), setVisible: vi.fn(), greet: vi.fn(), dispose: vi.fn(),
} }));
vi.mock("@/components/navigator/gimbal-renderer", () => ({ createGimbalRenderer: fake.create }));
let root: Root, host: HTMLDivElement, options: GimbalRendererOptions;
beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
  fake.create.mockImplementation(async (_: HTMLElement, value: GimbalRendererOptions) => {
    options = value; value.onReady(); return fake.runtime;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount() {
  await act(async () => { root.render(<GimbalCharacter state="planning" />); });
  await act(async () => { await vi.dynamicImportSettled(); });
}
describe("Gimbal component lifecycle", () => {
  it.each(["offscreen", "hidden"])("defers GPU creation when %s during the renderer import", async (condition) => {
    let observeVisibility: (entries: { isIntersecting: boolean }[]) => void = () => {};
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: typeof observeVisibility) { observeVisibility = callback; }
      observe() {
        observeVisibility([{ isIntersecting: true }]);
        // The import promise is now pending; make the view inactive before it resolves.
        if (condition === "offscreen") observeVisibility([{ isIntersecting: false }]);
        else {
          visibility.mockReturnValue("hidden");
          document.dispatchEvent(new Event("visibilitychange"));
        }
      }
      disconnect() {}
    });
    try {
      await mount();
      expect(fake.create).not.toHaveBeenCalled();
      expect(host.querySelector(".gimbal-character")?.getAttribute("data-renderer")).toBe("static");
      await act(async () => {
        visibility.mockReturnValue("visible");
        observeVisibility([{ isIntersecting: true }]);
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.dynamicImportSettled();
      });
      expect(fake.create).toHaveBeenCalledOnce();
      expect(fake.runtime.setVisible).toHaveBeenLastCalledWith(true);
      // Deferred imports must not exhaust the single context-loss recovery.
      vi.useFakeTimers();
      act(() => options.onError());
      await act(async () => { await vi.advanceTimersByTimeAsync(1200); await vi.dynamicImportSettled(); });
      expect(fake.create).toHaveBeenCalledTimes(2);
    } finally { visibility.mockRestore(); }
  });

  it("passes the product material to both renderer and fallback", async () => {
    await act(async () => { root.render(<GimbalCharacter state="planning" material="porcelain" />); });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(options.material).toBe("porcelain");
    expect(host.querySelector('.gimbal-static ellipse[rx="42"]')?.getAttribute("fill")).toBe("#f4f3ee");
  });

  it("follows system reduced motion without replacing the renderer", async () => {
    let onChange = () => {};
    const preference = { matches: false, addEventListener: (_: string, callback: () => void) => { onChange = callback; }, removeEventListener() {} };
    vi.stubGlobal("matchMedia", () => preference);
    await mount();
    preference.matches = true;
    act(() => onChange());
    expect(fake.runtime.setReducedMotion).toHaveBeenLastCalledWith(true);
    expect(fake.create).toHaveBeenCalledOnce();
    expect(fake.runtime.dispose).not.toHaveBeenCalled();
    expect(host.querySelector('[data-quality="max"]')).not.toBeNull();
  });
  it("acknowledges greetings even when WebGL fails", async () => {
    fake.create.mockRejectedValue(new Error("WebGL unavailable"));
    await mount();
    expect(host.querySelector(".gimbal-character")?.getAttribute("data-renderer")).toBe("static");
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Hello. I’m here.");
  });
  it("attempts recovery once and retains a usable fallback after another loss", async () => {
    await mount(); vi.useFakeTimers();
    act(() => options.onError());
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); await vi.dynamicImportSettled(); });
    expect(fake.create).toHaveBeenCalledTimes(2);
    act(() => options.onError());
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fake.create).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".gimbal-character")?.getAttribute("data-renderer")).toBe("static");
  });
});
