import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProductChrome } from "@/components/shell/product-chrome";
import { isDestinationActive, PROJECT_DESTINATIONS } from "@/components/shell/navigation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const push = vi.fn();
let pathname = "/p/atlas/source";
const { api } = vi.hoisted(() => ({ api: vi.fn(async () => ({})) }));
vi.mock("@/lib/client/api", () => ({ api, ApiError: class extends Error {} }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ push, refresh: vi.fn() }) }));
const makeShell = () => ({
  catalog: [], refresh: vi.fn(), boot: {
    workspace: { id: "ws", name: "Kepler Labs" }, workspaces: [{ id: "ws2", name: "Second workspace", role: "editor" }],
    projects: [{ id: "p1", name: "Atlas", slug: "atlas" }],
    members: [], auth: { configured: false }, user: null, role: "editor",
  },
});
let shell = makeShell();
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => shell }));
vi.mock("@/components/shell/command-palette", () => ({ CommandPalette: () => <button>Search</button> }));
vi.mock("@/components/shell/activity-bell", () => ({ ActivityBell: () => <button>Notifications</button> }));
vi.mock("@/components/ui/theme-toggle", () => ({ ThemeToggle: () => <button>Theme</button> }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  push.mockClear(); api.mockClear();
  pathname = "/p/atlas/source";
  shell = makeShell();
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("workbench navigation", () => {
  it("matches complete sections and retains all nine project destinations", () => {
    expect(isDestinationActive("/p/atlas/source-export", "/p/atlas/source")).toBe(false);
    expect(isDestinationActive("/p/atlas/source/history", "/p/atlas/source")).toBe(true);
    expect(isDestinationActive("/p/atlas/source", "/p/atlas", true)).toBe(false);
    expect(PROJECT_DESTINATIONS.map((entry) => entry.seg)).toEqual(["", "source", "deploys", "revisions", "observe", "security", "activity", "navigator", "settings"]);
  });

  it("collapses without replacing a draft or losing the control's keyboard focus", async () => {
    let mounts = 0;
    function WorkingSurface() { useEffect(() => { mounts += 1; }, []); return <input aria-label="Draft" defaultValue="unsaved resource" />; }
    await act(async () => root.render(<ProductChrome><WorkingSurface /></ProductChrome>));
    const draft = host.querySelector("input")!;
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Collapse navigation"]')!;
    toggle.focus();
    await act(async () => toggle.click());
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("input")).toBe(draft);
    expect(draft.value).toBe("unsaved resource");
    expect(mounts).toBe(1);
    expect(localStorage.getItem("zenith-shell-collapsed")).toBe("true");
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe("Source");
    expect(host.querySelectorAll('nav a[href^="/p/atlas"]')).toHaveLength(9);
  });

  it("opens the mobile navigation as a dialog and Escape restores menu focus", async () => {
    await act(async () => root.render(<ProductChrome><div>Working surface</div></ProductChrome>));
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')!;
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(dialog?.querySelectorAll('nav a[href^="/p/atlas"]')).toHaveLength(9);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it.each([true, false])("keeps the active workspace Share link in the header with projects=%s", async (hasProjects) => {
    if (!hasProjects) {
      pathname = "/overview";
      shell.boot.projects = [];
    }
    shell.boot.workspace.id = "active workspace/&";
    await act(async () => root.render(<ProductChrome><div>Working surface</div></ProductChrome>));
    const share = host.querySelector<HTMLAnchorElement>('header a[aria-label="Share Kepler Labs"]')!;
    expect(share).not.toBeNull();
    expect(share.textContent).toBe("Share");
    expect(share.getAttribute("href")).toBe("/workspace?workspace=active%20workspace%2F%26");
    expect(share.getAttribute("aria-disabled")).not.toBe("true");

    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Collapse navigation"]')!;
    await act(async () => toggle.click());
    expect(host.querySelector('header a[aria-label="Share Kepler Labs"]')).toBe(share);
    expect(api).not.toHaveBeenCalled();
  });

  it.each(["ws", "other workspace/&"])("opens sharing for workspace %s from its own switcher row with no projects", async (workspaceId) => {
    pathname = "/overview";
    shell.boot.projects = [];
    shell.boot.workspaces = [
      { id: "ws", name: "Kepler Labs", role: "editor" },
      { id: "other workspace/&", name: "Second workspace", role: "viewer" },
    ];
    await act(async () => root.render(<ProductChrome><div>Working surface</div></ProductChrome>));
    const trigger = host.querySelector<HTMLButtonElement>('aside button[aria-haspopup="menu"]')!;
    await act(async () => trigger.click());
    const menu = document.querySelector('[role="menu"][aria-label="Workspace Kepler Labs"]')!;
    const shares = Array.from(menu.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"][aria-label^="Share "]'));
    expect(shares.map((share) => [share.getAttribute("aria-label"), share.getAttribute("href")])).toEqual([
      ["Share Kepler Labs", "/workspace?workspace=ws"],
      ["Share Second workspace", "/workspace?workspace=other%20workspace%2F%26"],
    ]);
    for (const share of shares) {
      expect(share.getAttribute("aria-disabled")).not.toBe("true");
    }
    const share = shares.find((item) => item.getAttribute("href") === `/workspace?workspace=${encodeURIComponent(workspaceId)}`)!;
    // Observe the link's handler while preventing jsdom's unsupported navigation.
    share.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await act(async () => share.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(api).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(shell.refresh).not.toHaveBeenCalled();
  });

  it("returns to Overview after switching workspace instead of retaining a foreign project route", async () => {
    await act(async () => root.render(<ProductChrome><div>Working surface</div></ProductChrome>));
    const trigger = host.querySelector<HTMLButtonElement>('[title="Workspace · Kepler Labs"]')!;
    await act(async () => trigger.click());
    const destination = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((item) => item.textContent?.includes("Second workspace"))!;
    await act(async () => destination.click());
    expect(api).toHaveBeenCalledWith("/api/workspace/select", { method: "POST", body: JSON.stringify({ workspaceId: "ws2" }) });
    expect(push).toHaveBeenCalledWith("/overview");
  });
});
