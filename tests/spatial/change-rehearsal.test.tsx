import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChangeRehearsal } from "@/components/spatial/change-rehearsal";
import { emptyManifest, Resource, type Changeset } from "@/lib/domain/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const changeset: Changeset = { items: [{ nodeId: "queue-id", nodeName: "events", nodeType: "resource", op: "create", costDeltaUsd: 2, risk: "low", explanation: "Create queue" }], projectedMonthlyUsd: 2, totalCostDeltaUsd: 2, warnings: [] };
const proposedManifest = { ...emptyManifest(), resources: [Resource.parse({ id: "queue-id", name: "events", kind: "queue" })] };
beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const button = (text: string) => [...host.querySelectorAll("button")].find((element) => element.textContent === text)!;

describe("readable rehearsal without WebGL", () => {
  it("shows actual current/proposed membership and estimates without canvas support", () => {
    act(() => root.render(<ChangeRehearsal currentManifest={null} proposedManifest={proposedManifest} changeset={changeset} environmentName="Sandbox" />));
    expect(host.textContent).toContain("Sandbox · Proposed configuration");
    expect(host.textContent).toContain("Addition");
    expect(host.textContent).toContain("$2.00");
    expect(host.querySelector("svg")).not.toBeNull();
    act(() => button("Current").click());
    expect(host.textContent).toContain("Absent from current");
    expect(host.textContent).toContain("No deployed revision yet");
    expect(host.textContent).toContain("$0.00");
    expect(button("Current").getAttribute("aria-pressed")).toBe("true");
  });
  it("uses real stable resource IDs for selection while retaining comparison state on updates", () => {
    const onSelect = vi.fn();
    const render = () => root.render(<ChangeRehearsal currentManifest={null} proposedManifest={proposedManifest} changeset={changeset} environmentName="Sandbox" onSelect={onSelect} />);
    act(render);
    const resource = host.querySelector<HTMLButtonElement>('button[title="events · queue-id"]')!;
    act(() => resource.click());
    expect(onSelect).toHaveBeenCalledWith("queue-id");
    act(() => button("Current").click());
    act(render);
    expect(button("Current").getAttribute("aria-pressed")).toBe("true");
  });
  it("keeps an empty state meaningful with no artificial resources", () => {
    act(() => root.render(<ChangeRehearsal currentManifest={null} proposedManifest={emptyManifest()} changeset={{ ...changeset, items: [], projectedMonthlyUsd: 0, totalCostDeltaUsd: 0 }} environmentName="Staging" />));
    expect(host.textContent).toContain("No resources in this configuration yet");
    expect(host.querySelector("canvas")).toBeNull();
  });
});
