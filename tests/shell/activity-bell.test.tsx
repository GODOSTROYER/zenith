/**
 * The notification panel, rendered: one row per notification, each leading to
 * the trail of the project it is actually about.
 *
 * The regression this guards is a row that opened the wrong project — the
 * panel used to put one URL, derived from the route or the workspace's first
 * project, on every row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ActivityBell } from "@/components/shell/activity-bell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shell = vi.hoisted(() => ({
  boot: undefined as unknown,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/p/atlas/deploys" }));
vi.mock("@/components/shell/shell-context", () => ({
  useShell: () => ({ boot: shell.boot, loading: false, error: undefined, refresh: vi.fn(), catalog: [] }),
}));

const PROJECTS = [
  { id: "p1", name: "Atlas", slug: "atlas" },
  { id: "p2", name: "Borealis", slug: "borealis" },
];

const STORE_KEY = "zenith-activity";

let root: Root;
let host: HTMLDivElement;

/** jsdom under recent Node can ship without Web Storage; the panel needs one. */
function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (k: string) => (values.has(k) ? values.get(k)! : null),
    key: (i: number) => [...values.keys()][i] ?? null,
    removeItem: (k: string) => void values.delete(k),
    setItem: (k: string, v: string) => void values.set(k, String(v)),
  } as Storage;
}

beforeEach(() => {
  shell.boot = { projects: PROJECTS };
  vi.stubGlobal("sessionStorage", fakeStorage());
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** Seed the per-tab buffer exactly as an earlier page load would have left it. */
const seed = (records: unknown[]) => sessionStorage.setItem(STORE_KEY, JSON.stringify(records));

async function openPanel() {
  await act(async () => root.render(<ActivityBell />));
  const trigger = host.querySelector("button")!;
  await act(async () => trigger.click());
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

const rows = (panel: HTMLElement) => [...panel.querySelectorAll("li")];

describe("the activity panel's rows", () => {
  it("sends every row to its own project's trail", async () => {
    seed([
      { id: "a", title: "Atlas deployed", ts: "2026-09-01T10:00:00.000Z", kind: "ok", projectId: "p1" },
      { id: "b", title: "Borealis deployed", ts: "2026-09-01T10:01:00.000Z", kind: "ok", projectId: "p2" },
    ]);
    const panel = await openPanel();
    const hrefs = rows(panel).map((li) => li.querySelector("a")?.getAttribute("href"));
    expect(hrefs).toEqual(["/p/atlas/activity", "/p/borealis/activity"]);
  });

  it("does not route a row to the project in the current route", async () => {
    // The route is /p/atlas/…; this notification belongs to Borealis.
    seed([{ id: "b", title: "Borealis deployed", ts: "t", kind: "ok", projectId: "p2" }]);
    const panel = await openPanel();
    expect(rows(panel)[0].querySelector("a")!.getAttribute("href")).toBe("/p/borealis/activity");
  });

  it("says so, in plain text, when the row's project is gone or not yours", async () => {
    seed([{ id: "c", title: "Ghost deployed", ts: "t", kind: "ok", projectId: "deleted" }]);
    const panel = await openPanel();
    const row = rows(panel)[0];
    expect(row.querySelector("a")).toBeNull();
    expect(row.textContent).toMatch(/no longer available/i);
    expect(row.querySelector("span[title]")!.getAttribute("title")).toMatch(/no longer available/i);
  });

  it("never falls back to the first project for an unresolvable row", async () => {
    seed([{ id: "c", title: "Ghost", ts: "t", kind: "ok", projectSlug: "retired" }]);
    const panel = await openPanel();
    expect(panel.querySelectorAll('li a[href*="/activity"]')).toHaveLength(0);
  });

  it("loads records saved before notifications carried a project, as plain rows", async () => {
    seed([
      { id: "old", title: "Something happened", ts: "t", kind: "info" },
      "corrupt",
      { nonsense: true },
    ]);
    const panel = await openPanel();
    expect(rows(panel)).toHaveLength(1);
    expect(rows(panel)[0].textContent).toContain("Something happened");
    expect(rows(panel)[0].querySelector("a")).toBeNull();
    // A record that never had a project is not an error state.
    expect(rows(panel)[0].textContent).not.toMatch(/no longer available/i);
  });

  it("survives a corrupt buffer without losing the panel", async () => {
    sessionStorage.setItem(STORE_KEY, "{not json");
    const panel = await openPanel();
    expect(panel.textContent).toContain("Nothing yet");
  });

  it("holds off on the unavailable verdict until the workspace has loaded", async () => {
    shell.boot = undefined;
    seed([{ id: "a", title: "Atlas deployed", ts: "t", kind: "ok", projectId: "p1" }]);
    const panel = await openPanel();
    expect(rows(panel)[0].textContent).not.toMatch(/no longer available/i);
    expect(rows(panel)[0].querySelector("a")).toBeNull();
  });

  it("names the project its footer link actually opens", async () => {
    const panel = await openPanel();
    const footer = panel.querySelector("footer")!;
    expect(footer.textContent).toContain("Atlas");
    expect(footer.querySelector("a")!.getAttribute("href")).toBe("/p/atlas/activity");
  });

  it("mirrors a live toast into the panel with its project identity intact", async () => {
    await act(async () => root.render(<ActivityBell />));
    await act(async () => {
      window.__zenithActivity?.({
        id: "live",
        title: "Borealis deployed",
        ts: new Date().toISOString(),
        kind: "ok",
        projectId: "p2",
      });
    });
    const trigger = host.querySelector("button")!;
    await act(async () => trigger.click());
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(rows(panel)[0].querySelector("a")!.getAttribute("href")).toBe("/p/borealis/activity");
  });
});
