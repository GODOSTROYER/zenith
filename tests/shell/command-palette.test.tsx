/**
 * The command palette: what it lists, what it refuses, and that ⌘K/Ctrl-K
 * actually reaches a keyboard user.
 *
 * The row logic is pure and tested directly; the render test exists for the
 * one thing pure functions cannot prove — that a row the caller's role forbids
 * reaches assistive tech as disabled, with the reason attached, instead of
 * looking like every other row and failing after the click.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  CommandPalette,
  filterRows,
  paletteRows,
  PALETTE_LIMIT,
  type ActionEntry,
} from "@/components/shell/command-palette";

// React refuses to treat `act` as real without this, and warns on every render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.fn();
let pathname = "/overview";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname,
}));

const boot = {
  workspace: { id: "ws", name: "Kepler Labs" },
  projects: [
    { id: "p1", name: "Atlas", slug: "atlas" },
    { id: "p2", name: "Borealis", slug: "borealis" },
  ],
  members: [],
  auth: { configured: false },
  user: null,
  role: "editor" as const,
};
vi.mock("@/components/shell/shell-context", () => ({
  useShell: () => ({ boot, loading: false, error: undefined, refresh: () => {} }),
}));

const CATALOG: ActionEntry[] = [
  { id: "deploy.apply", title: "Deploy", category: "deploy", risk: "medium", requiredRole: "editor" },
  {
    id: "workspace.rename",
    title: "Rename workspace",
    category: "project",
    risk: "low",
    requiredRole: "admin",
  },
  {
    id: "system.addService",
    title: "Add service",
    category: "system",
    risk: "low",
    requiredRole: "editor",
  },
];

const projects = [{ name: "Atlas", slug: "atlas" }];
const find = (rows: ReturnType<typeof paletteRows>, key: string) =>
  rows.find((r) => r.key === key);
const action = (id: string, category = "operations", requiredRole: ActionEntry["requiredRole"] = "editor"): ActionEntry => ({
  id, title: id, category, requiredRole, risk: "low",
});

describe("paletteRows", () => {
  it("offers every screen of every project, plus the workspace entries", () => {
    const rows = paletteRows([], projects, "admin");
    expect(find(rows, "screen:overview")?.href).toBe("/overview");
    expect(find(rows, "screen:atlas:")?.href).toBe("/p/atlas");
    expect(find(rows, "screen:atlas:deploys")?.href).toBe("/p/atlas/deploys");
  });

  it("sends each action to the screen that owns it", () => {
    const rows = paletteRows(CATALOG, projects, "admin");
    expect(find(rows, "action:deploy.apply")?.href).toBe("/p/atlas/deploys");
    expect(find(rows, "action:workspace.rename")?.href).toBe("/p/atlas/settings");
    expect(find(rows, "action:system.addService")?.href).toBe("/p/atlas");
  });

  it("blocks an action above the caller's role and names both roles", () => {
    const rows = paletteRows(CATALOG, projects, "editor");
    expect(find(rows, "action:deploy.apply")?.blocked).toBeUndefined();
    expect(find(rows, "action:workspace.rename")?.blocked).toBe(
      "Needs the admin role. You are editor in this workspace."
    );
  });

  it("claims nothing when the role is not known yet", () => {
    const rows = paletteRows(CATALOG, projects, null);
    expect(find(rows, "action:workspace.rename")?.blocked).toBeUndefined();
  });

  it("blocks every action, with a reason, when there is no project to open", () => {
    const rows = paletteRows(CATALOG, [], "admin");
    for (const r of rows.filter((x) => x.group === "Actions")) {
      expect(r.href).toBeUndefined();
      expect(r.blocked).toBe("No project in this workspace yet — create one first.");
    }
  });

  it("carries the risk of each action so the row can show it", () => {
    const rows = paletteRows(CATALOG, projects, "admin");
    expect(find(rows, "action:deploy.apply")?.risk).toBe("medium");
  });

  it.each(["alerts.createRule", "alerts.updateRule", "alerts.deleteRule", "alerts.acknowledge"])("opens Observe's alert controls for %s", (id) => {
    const row = find(paletteRows([action(id)], projects, "admin"), `action:${id}`);
    expect(row?.href).toBe("/p/atlas/observe#alerts");
    expect(row?.where).toBe("Atlas — Observe — Alerts");
  });

  it.each(["alerts.createChannel", "alerts.updateChannel", "alerts.deleteChannel", "alerts.testChannel"])("opens alert delivery settings for %s", (id) => {
    const row = find(paletteRows([action(id)], projects, "admin"), `action:${id}`);
    expect(row?.href).toBe("/p/atlas/settings#alerts");
    expect(row?.where).toBe("Atlas — Settings — Alert delivery");
  });

  it("separates security and investigation from graph operations despite their shared category", () => {
    const rows = paletteRows([action("security.resolveFinding"), action("security.dismissFinding"), action("security.reopenFinding"), action("ops.investigate"), action("ops.restartService")], projects, "admin");
    for (const id of ["resolveFinding", "dismissFinding", "reopenFinding"]) expect(find(rows, `action:security.${id}`)?.href).toBe("/p/atlas/security");
    expect(find(rows, "action:ops.investigate")?.href).toBe("/p/atlas/navigator");
    expect(find(rows, "action:ops.restartService")?.href).toBe("/p/atlas");
  });

  it("routes project creation to onboarding while existing-project imports and blueprints open System", () => {
    const rows = paletteRows([action("project.create", "project"), action("project.applyBlueprint", "project"), action("project.importCompose", "project"), action("project.importResources", "project"), action("project.updateManifest", "system")], projects, "editor");
    expect(find(rows, "action:project.create")?.href).toBe("/onboarding?step=3");
    expect(find(rows, "action:project.create")?.where).toBe("Onboarding — Create project");
    for (const id of ["applyBlueprint", "importCompose", "importResources"]) expect(find(rows, `action:project.${id}`)?.href).toBe("/p/atlas");
    expect(find(rows, "action:project.updateManifest")?.href).toBe("/p/atlas/source");
  });

  it("lets an empty workspace reach creation flows without bypassing registry role requirements", () => {
    const catalog = [action("project.create", "project"), action("project.applyBlueprint", "project"), action("project.importCompose", "project"), action("connection.create", "connection", "admin")];
    const admin = paletteRows(catalog, [], "admin");
    for (const row of admin.filter((row) => row.group === "Actions")) expect(row.blocked).toBeUndefined();
    expect(find(admin, "action:project.create")?.href).toBe("/onboarding?step=3");
    expect(find(admin, "action:connection.create")?.href).toBe("/onboarding?step=2");
    const editor = paletteRows(catalog, [], "editor");
    expect(find(editor, "action:connection.create")?.blocked).toBe("Needs the admin role. You are editor in this workspace.");
    expect(find(paletteRows(catalog, [], "viewer"), "action:project.create")?.blocked).toContain("Needs the editor role");
  });

  it.each(["connection.create", "connection.check", "connection.disconnect"])("opens existing connection management for %s", (id) => {
    const row = find(paletteRows([action(id, "connection")], projects, "admin"), `action:${id}`);
    expect(row?.href).toBe("/p/atlas/settings#connections");
    expect(row?.where).toBe("Atlas — Settings — Connections");
    if (id !== "connection.create") expect(find(paletteRows([action(id, "connection")], [], "admin"), `action:${id}`)?.blocked).toContain("No project");
  });
});

describe("filterRows", () => {
  const rows = paletteRows(CATALOG, projects, "admin");

  it("matches title, action id and category, case-insensitively", () => {
    expect(filterRows(rows, "DEPLOY.APPLY").map((r) => r.key)).toContain("action:deploy.apply");
    expect(filterRows(rows, "rename").map((r) => r.key)).toEqual(["action:workspace.rename"]);
    expect(filterRows(rows, "observe").map((r) => r.key)).toEqual(["screen:atlas:observe"]);
  });

  it("returns nothing rather than everything when nothing matches", () => {
    expect(filterRows(rows, "zzzz")).toEqual([]);
  });

  it("caps what it renders so a large catalog cannot blow up the list", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...CATALOG[0],
      id: `a${i}`,
      title: `Action ${i}`,
    }));
    expect(filterRows(paletteRows(many, projects, "admin"), "").length).toBe(PALETTE_LIMIT);
  });
});

/* ------------------------------- rendered -------------------------------- */

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.useRealTimers();
});

function mount(catalog = CATALOG) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(CommandPalette, { catalog })));
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });

const dialog = () => document.querySelector('[role="dialog"]');

describe("<CommandPalette>", () => {
  it("opens on Ctrl-K and unmounts again on the same chord", () => {
    vi.useFakeTimers();
    mount();
    expect(dialog()).toBeNull();
    press("k", { ctrlKey: true });
    expect(dialog()).not.toBeNull();
    press("k", { ctrlKey: true });
    // useModal keeps the panel mounted for its 200ms exit transition.
    act(() => void vi.advanceTimersByTime(400));
    expect(dialog()).toBeNull();
  });

  it("has a searchable combobox wired to the option list", () => {
    mount();
    press("k", { metaKey: true });
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(input?.getAttribute("aria-controls")).toBe(
      document.querySelector('[role="listbox"]')?.id
    );
    expect(input?.getAttribute("aria-activedescendant")).toBeTruthy();
  });

  it("marks a role-blocked row aria-disabled and puts the reason on it", () => {
    mount();
    press("k", { ctrlKey: true });
    const rows = [...document.querySelectorAll('[role="option"]')];
    const blocked = rows.find((r) => r.textContent?.includes("Rename workspace"));
    expect(blocked?.getAttribute("aria-disabled")).toBe("true");
    expect(blocked?.getAttribute("title")).toBe(
      "Needs the admin role. You are editor in this workspace."
    );
    expect(blocked?.textContent).toContain("Needs the admin role");
  });

  it("sends actions to the project you are looking at, not the first one", () => {
    pathname = "/p/borealis/deploys";
    try {
      mount();
      press("k", { ctrlKey: true });
      const row = [...document.querySelectorAll('[role="option"]')].find((r) =>
        r.textContent?.startsWith("Deploy")
      );
      expect(row?.textContent).toContain("Opens Borealis");
    } finally {
      pathname = "/overview";
    }
  });

  it("opens the advertised alert destination for the active project when selected", () => {
    pathname = "/p/borealis/security";
    push.mockClear();
    try {
      mount([{ ...action("alerts.acknowledge"), title: "Acknowledge alert" }]);
      press("k", { ctrlKey: true });
      const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.startsWith("Acknowledge alert"))!;
      expect(row.textContent).toContain("Opens Borealis — Observe — Alerts");
      act(() => row.click());
      expect(push).toHaveBeenCalledWith("/p/borealis/observe#alerts");
    } finally {
      pathname = "/overview";
    }
  });

  it("navigates on Enter, and refuses to navigate a blocked row", () => {
    mount();
    press("k", { ctrlKey: true });
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const type = (value: string) =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const enter = () =>
      act(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });

    push.mockClear();
    type("Add service");
    enter();
    expect(push).toHaveBeenCalledWith("/p/atlas");

    push.mockClear();
    press("k", { ctrlKey: true });
    press("k", { ctrlKey: true });
    type("Rename workspace");
    enter();
    expect(push).not.toHaveBeenCalled();
  });
});
