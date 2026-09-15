/**
 * The compact stand-in for the cost and pending-change context (UI-4).
 *
 * jsdom cannot evaluate the media queries that decide which of the two forms is
 * displayed — that is checked in a real browser — so what is pinned here is
 * everything the CSS does not do: that the control carries both numbers, names
 * itself for assistive technology, opens from the keyboard, and offers the way
 * through to the pending changes rather than only counting them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextSummary } from "@/components/shell/project-chrome";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const trigger = () => host.querySelector<HTMLButtonElement>(".workbench-context-summary")!;

describe("compact project context", () => {
  it("names the cost and the pending count for assistive technology", async () => {
    await act(async () => root.render(
      <ContextSummary cost="$1,240" pending={3} slug="atlas" environmentName="Production" />
    ));
    expect(trigger().getAttribute("aria-label")).toBe(
      "Project context: $1,240 per month estimated, 3 pending changes"
    );
    // The digits are decoration once the label says it all — read twice is worse.
    expect(trigger().textContent).toBe("$1,2403");
    expect(trigger().querySelector("[aria-hidden='true']")).not.toBeNull();
  });

  it("says so plainly when nothing is waiting to deploy", async () => {
    await act(async () => root.render(
      <ContextSummary cost="$0" pending={0} slug="atlas" environmentName="Development" />
    ));
    expect(trigger().getAttribute("aria-label")).toBe(
      "Project context: $0 per month estimated, no pending changes"
    );
    expect(host.querySelector(".workbench-context-summary-pending")).toBeNull();
  });

  it("opens from the keyboard and leads to the pending changes", async () => {
    await act(async () => root.render(
      <ContextSummary cost="$1,240" pending={1} slug="atlas" environmentName="Production" />
    ));
    const button = trigger();
    button.focus();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = document.querySelector<HTMLElement>('[role="menu"][aria-label="Project context"]')!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain("estimated monthly");
    // Singular, and the environment is named rather than left as "here".
    expect(panel.textContent).toContain("Undeployed in Production");
    const link = panel.querySelector<HTMLAnchorElement>('a[role="menuitem"]')!;
    expect(link.getAttribute("href")).toBe("/p/atlas");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });
});
