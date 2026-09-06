import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Manifest } from "@/lib/domain/types";
import { diffManifests } from "@/lib/domain/graph";
import { CURRENT_DEMO_MANIFEST, PROPOSED_DEMO_MANIFEST, DEMO_COST, DEMO_STEPS, demoApi, demoSource } from "@/components/landing/demo-fixture";
import { deriveDemo, initialDemoState, revisionDemoReducer, useRevisionDemo, type DemoState } from "@/components/landing/use-revision-demo";
import { ChangeDemo } from "@/components/landing/change-demo";
import { ModelSurfaces } from "@/components/landing/model-surfaces";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/components/landing/revision-scene", () => ({ RevisionScene: ({ phase }: { phase: string }) => <div data-scene-phase={phase} /> }));
let root: Root | undefined;
let host: HTMLDivElement | undefined;
function Harness() { const demo = useRevisionDemo(); return <><ChangeDemo demo={demo} /><ModelSurfaces demo={demo} /></>; }
function render() { host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root!.render(<Harness />)); }
function button(text: string) { const element = [...host!.querySelectorAll("button")].find((item) => item.textContent?.includes(text)); if (!element) throw new Error(`Missing button: ${text}`); return element; }
function click(element: HTMLElement) { act(() => element.click()); }
function finish(state: DemoState) { return DEMO_STEPS.reduce((next) => revisionDemoReducer(next, { type: "advance" }), state); }
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("synthetic landing simulation", () => {
  it("uses valid canonical manifests and the product cost model", () => {
    expect(Manifest.safeParse(CURRENT_DEMO_MANIFEST).success).toBe(true);
    expect(Manifest.safeParse(PROPOSED_DEMO_MANIFEST).success).toBe(true);
    expect(PROPOSED_DEMO_MANIFEST.resources).toHaveLength(1);
    expect(PROPOSED_DEMO_MANIFEST.bindings.map((binding) => binding.capability)).toEqual(["queue_publish", "queue_consume"]);
    expect(DEMO_COST).toEqual({ current: 14, proposed: 15, delta: 1 });
    expect(diffManifests(CURRENT_DEMO_MANIFEST, PROPOSED_DEMO_MANIFEST).projectedMonthlyUsd).toBe(15);
    for (const manifest of [CURRENT_DEMO_MANIFEST, PROPOSED_DEMO_MANIFEST]) {
      expect(JSON.parse(demoSource(manifest, 9).split("\n").slice(2).join("\n"))).toEqual(manifest);
      const request = JSON.parse(demoApi(manifest, 9).split("\n\n")[1]);
      expect(request.mode).toBe("plan");
      expect(request.input.manifest).toEqual(manifest);
    }
  });

  it("requires review and an explicit run, ignores unsolicited progress, and retains restore history", () => {
    let state = initialDemoState();
    expect(revisionDemoReducer(state, { type: "run" })).toBe(state);
    expect(revisionDemoReducer(state, { type: "advance" })).toBe(state);
    state = revisionDemoReducer(state, { type: "review", value: true });
    expect(state.stage).toBe("review");
    expect(revisionDemoReducer(state, { type: "advance" })).toBe(state);
    state = revisionDemoReducer(state, { type: "run" });
    state = finish(state);
    expect(state.stage).toBe("recorded");
    expect(deriveDemo(state).revision).toBe(9);
    state = revisionDemoReducer(state, { type: "restore" });
    expect(deriveDemo(state).manifest).toEqual(CURRENT_DEMO_MANIFEST);
    expect(state.history.map((record) => record.revision)).toEqual([8, 9, 10]);
    expect(state.history[1].kind).toBe("simulation");
    state = revisionDemoReducer(state, { type: "inspect", view: "proposed" });
    expect(deriveDemo(state).revision).toBe(11);
    expect(revisionDemoReducer(state, { type: "run" })).toBe(state);
    state = finish(revisionDemoReducer(revisionDemoReducer(state, { type: "review", value: true }), { type: "run" }));
    expect(state.history.map((record) => record.revision)).toEqual([8, 9, 10, 11]);
  });

  it("does not run on scrolling, inspection, a checked box, or tab changes; completes after explicit approval", () => {
    vi.useFakeTimers();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render();
    expect(button("Run simulation").disabled).toBe(true);
    click(button("Current 08"));
    act(() => window.dispatchEvent(new Event("scroll")));
    click(button("Source"));
    expect(host!.querySelector('pre[aria-label*="source"]')?.textContent).toContain('"resources": []');
    click(button("Proposed 09"));
    click(host!.querySelector('input[type="checkbox"]') as HTMLInputElement);
    act(() => vi.advanceTimersByTime(10000));
    expect(host!.textContent).not.toContain("Simulation complete");
    click(button("Run simulation"));
    for (let i = 0; i < 3; i++) act(() => vi.advanceTimersByTime(900));
    expect(host!.textContent).toContain("Simulation complete");
    expect(host!.textContent).toContain("sim://atlas/revisions/09/atlas-jobs");
    expect(host!.querySelector('[aria-label="Revision details"] > h3')?.textContent).toBe("Recorded revision 09");
    expect(host!.textContent).not.toContain("Proposed revision 09");
    click(button("View revision 08"));
    expect(host!.textContent).toContain("Viewing historical revision 08");
    expect(host!.textContent).toContain("Active revision 09 recorded");
    expect(host!.querySelector('pre[aria-label*="source"]')?.textContent).toContain('"resources": []');
    click(button("Current 09"));
    click(button("Restore previous demo revision"));
    expect(host!.textContent).toContain("Active revision 10 keeps the history");
    expect(host!.querySelector('[aria-label="Revision details"] > h3')?.textContent).toBe("Restored revision 10");
    expect(host!.querySelector('[aria-label="Revision details"]')?.textContent).toContain("$15.00 → $14.00");
    expect(host!.querySelector('[aria-label="Revision details"]')?.textContent).toContain("Removed bindings2");
    expect(host!.querySelector('pre[aria-label*="source"]')?.textContent).toContain('"resources": []');
    click(button("View revision 09"));
    expect(host!.textContent).toContain("Viewing historical revision 09");
    expect(host!.textContent).toContain("Active revision 10 keeps the history");
    expect(host!.querySelector('pre[aria-label*="source"]')?.textContent).toContain('"name": "atlas-jobs"');
    expect(host!.querySelector('pre[aria-label*="API"]')?.textContent).toContain('"name": "atlas-jobs"');
    click(button("Current 10"));
    expect(host!.querySelector('pre[aria-label*="source"]')?.textContent).toContain('"resources": []');
    expect(fetch).not.toHaveBeenCalled();
    click(button("Reset demonstration"));
    expect(button("Run simulation").disabled).toBe(true);
  });

  it("views retained revisions without changing approval, active configuration, or audit history", () => {
    const approved = revisionDemoReducer(initialDemoState(), { type: "review", value: true });
    const baselineView = revisionDemoReducer(approved, { type: "view-history", revision: 8 });
    expect(baselineView.stage).toBe(approved.stage);
    expect(baselineView.reviewed).toBe(true);
    expect(baselineView.history).toBe(approved.history);
    expect(baselineView.currentRevision).toBe(8);
    expect(deriveDemo(baselineView).manifest).toEqual(CURRENT_DEMO_MANIFEST);
    expect(revisionDemoReducer(baselineView, { type: "view-history", revision: 99 })).toBe(baselineView);
    const recorded = finish(revisionDemoReducer(approved, { type: "run" }));
    const restored = revisionDemoReducer(recorded, { type: "restore" });
    const historical = revisionDemoReducer(restored, { type: "view-history", revision: 9 });
    expect(historical.stage).toBe("restored");
    expect(historical.currentRevision).toBe(10);
    expect(historical.currentHasQueue).toBe(false);
    expect(historical.history).toBe(restored.history);
    expect(historical.reviewed).toBe(false);
    expect(deriveDemo(historical)).toMatchObject({ revision: 9, phase: "recorded", isHistorical: true, manifest: PROPOSED_DEMO_MANIFEST });
    const active = revisionDemoReducer(historical, { type: "inspect", view: "current" });
    expect(deriveDemo(active)).toMatchObject({ revision: 10, phase: "restored", isHistorical: false, manifest: CURRENT_DEMO_MANIFEST });
    const proposal = revisionDemoReducer(historical, { type: "inspect", view: "proposed" });
    expect(deriveDemo(proposal)).toMatchObject({ revision: 11, phase: "proposed", isHistorical: false });
  });

  it("supports arrow, Home and End tab navigation with matching visible panels", () => {
    render();
    const tab = button("System Map");
    act(() => { tab.focus(); tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(document.activeElement).toBe(button("Source"));
    expect(button("Source").getAttribute("aria-selected")).toBe("true");
    act(() => button("Source").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(button("Navigator"));
    act(() => button("Navigator").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(tab);
    expect(host!.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
  });
});
