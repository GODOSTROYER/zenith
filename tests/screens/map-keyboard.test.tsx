import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useNodeFocus } from "@/components/map/keyboard";

afterEach(() => vi.unstubAllGlobals());

it("centers keyboard selection without motion when the preference changes, retaining zoom", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let reduced = false;
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  const setCenter = vi.fn();
  const rf = { getNode: () => ({ position: { x: 100, y: 80 }, width: 280, height: 120 }), getZoom: () => 0.8, setCenter } as unknown as Parameters<typeof useNodeFocus>[0];
  function Harness() { const { centerOn } = useNodeFocus(rf); return <button onClick={() => centerOn("resource")}>Select resource</button>; }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    act(() => root.render(<Harness />));
    act(() => host.querySelector("button")!.click());
    expect(setCenter).toHaveBeenLastCalledWith(240, 140, { zoom: 0.8, duration: 220 });
    reduced = true;
    act(() => host.querySelector("button")!.click());
    expect(setCenter).toHaveBeenLastCalledWith(240, 140, { zoom: 0.8, duration: 0 });
  } finally { act(() => root.unmount()); }
});
