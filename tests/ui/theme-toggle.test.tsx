import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { ThemeSync } from "@/components/ui/theme-sync";
import { THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-preference");
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-preference");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function expectSelected(label: string) {
  act(() => root.render(<><ThemeSync /><ThemeToggle /></>));
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  expect(trigger.getAttribute("aria-label")).toBe(`Theme: ${label}`);
  act(() => trigger.click());
  const selected = document.querySelector('[role="menuitemradio"][aria-checked="true"]');
  expect(selected?.textContent).toContain(label);
}

it("announces the inherited light theme after landing-to-auth navigation without a saved choice", () => {
  document.documentElement.dataset.theme = "light";
  expectSelected("Light");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("zenith-theme")).toBeNull();
});

it("keeps the unsaved dark document selected", () => {
  expectSelected("Dark");
});

it.each(["dark", "light", "amoled", "system"])("preserves the explicit saved %s preference", (theme) => {
  localStorage.setItem("zenith-theme", theme);
  if (theme !== "dark") document.documentElement.dataset.theme = "light";
  expectSelected(theme === "amoled" ? "AMOLED Dark" : theme[0].toUpperCase() + theme.slice(1));
  expect(localStorage.getItem("zenith-theme")).toBe(theme);
});

it("announces the displayed light theme when storage is unavailable", () => {
  document.documentElement.dataset.theme = "light";
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  expectSelected("Light");
});

function trigger(index = 0) {
  return host.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')[index];
}

function select(label: string, index = 0) {
  act(() => trigger(index).click());
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
    .find((button) => button.textContent?.startsWith(label));
  expect(item, `Theme option ${label}`).toBeDefined();
  act(() => item!.click());
  // Popover retains its inert panel during the exit animation.
  act(() => vi.advanceTimersByTime(400));
}

it.each<[Theme, string, string | null]>([
  ["light", "Light", "light"],
  ["dark", "Dark", null],
  ["amoled", "AMOLED Dark", "amoled"],
  ["system", "System", "light"],
])("switches to %s, persists it and updates every selector", (preference, label, resolved) => {
  act(() => root.render(<><ThemeSync /><ThemeToggle /><ThemeToggle /></>));
  select(label);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(preference);
  expect(document.documentElement.getAttribute("data-theme")).toBe(resolved);
  expect(document.documentElement.getAttribute("data-theme-preference")).toBe(preference);
  for (const button of host.querySelectorAll('button[aria-haspopup="menu"]')) {
    expect(button.getAttribute("aria-label")).toBe(`Theme: ${label}`);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  }
  act(() => trigger(1).click());
  const selected = document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]');
  expect(selected).toHaveLength(1);
  expect(selected[0].textContent).toContain(label);
});

it("keeps AMOLED selected after the control is remounted during navigation", () => {
  act(() => root.render(<><ThemeSync /><ThemeToggle key="auth" /></>));
  select("AMOLED Dark");
  act(() => root.render(<><ThemeSync /><ThemeToggle key="product" /></>));
  expect(trigger().getAttribute("aria-label")).toBe("Theme: AMOLED Dark");
  expect(document.documentElement.dataset.theme).toBe("amoled");
});

it("switches and synchronizes AMOLED even when storage writes fail", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
  act(() => root.render(<><ThemeSync /><ThemeToggle /><ThemeToggle /></>));
  select("AMOLED Dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  expect(document.documentElement.dataset.theme).toBe("amoled");
  expect(trigger(1).getAttribute("aria-label")).toBe("Theme: AMOLED Dark");
});

it("falls back to the displayed theme for an invalid saved preference", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "unknown-legacy-theme");
  document.documentElement.dataset.theme = "light";
  expectSelected("Light");
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("offers keyboard navigation over all four radio options and restores focus on Escape", () => {
  act(() => root.render(<><ThemeSync /><ThemeToggle /></>));
  const button = trigger();
  button.focus();
  act(() => button.click());
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Theme"]')!;
  expect(menu.parentElement).toBe(document.body);
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
  expect(items).toHaveLength(4);
  act(() => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(document.activeElement).toBe(items[0]);
  act(() => items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(document.activeElement).toBe(items[1]);
  act(() => items[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(document.activeElement).toBe(items[2]);
  expect(items[2].textContent).toContain("AMOLED Dark");
  act(() => items[2].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.activeElement).toBe(items[3]);
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  act(() => vi.advanceTimersByTime(400));
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(button);
});
