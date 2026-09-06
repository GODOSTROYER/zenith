import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GimbalCharacter } from "@/components/navigator/gimbal-character";
import type { GimbalRendererOptions } from "@/components/navigator/gimbal-renderer";

const fake = vi.hoisted(() => ({ create: vi.fn(), runtime: {
  setState: vi.fn(), setReducedMotion: vi.fn(), setVisible: vi.fn(), setLowPower: vi.fn(), greet: vi.fn(), dispose: vi.fn(),
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
  it("keeps the same renderer when changing motion modes", async () => {
    await mount();
    await act(async () => { root.render(<GimbalCharacter state="planning" motion="still" />); });
    expect(fake.create).toHaveBeenCalledOnce();
    expect(fake.runtime.dispose).not.toHaveBeenCalled();
    expect(fake.runtime.setReducedMotion).toHaveBeenLastCalledWith(true);
    await act(async () => { root.render(<GimbalCharacter state="planning" motion="low-power" />); });
    expect(fake.runtime.setLowPower).toHaveBeenLastCalledWith(true);
    expect(fake.create).toHaveBeenCalledOnce();
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
