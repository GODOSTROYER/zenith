import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeSync } from "@/components/ui/theme-sync";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { chooseTheme } from "@/lib/client/theme-store";
import { initializeTheme, THEME_BOOTSTRAP_SCRIPT, THEME_STORAGE_KEY } from "@/lib/theme";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let light: boolean;
let mediaListeners: Set<() => void>;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-preference");
  light = false;
  mediaListeners = new Set();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return light; },
    addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
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
});

function systemChanges(nextLight: boolean) {
  light = nextLight;
  act(() => { for (const listener of mediaListeners) listener(); });
}

function storageChanges(value: string | null, key: string | null = THEME_STORAGE_KEY, storageArea?: Storage) {
  act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea })));
}

it("keeps following System on routes without any mounted selector", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "system");
  act(() => root.render(<ThemeSync />));
  expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  systemChanges(true);
  expect(document.documentElement.dataset.theme).toBe("light");
  systemChanges(false);
  expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  expect(document.documentElement.dataset.themePreference).toBe("system");
});

it("does not let a stale System listener overwrite an explicit AMOLED choice", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "system");
  act(() => root.render(<><ThemeSync /><ThemeToggle /><ThemeToggle /></>));
  act(() => chooseTheme("amoled"));
  systemChanges(true);
  systemChanges(false);
  expect(document.documentElement.dataset.theme).toBe("amoled");
  expect(host.querySelectorAll('button[aria-label="Theme: AMOLED Dark"]')).toHaveLength(2);
});

it("updates every control and the document when another tab selects a theme", () => {
  act(() => root.render(<><ThemeSync /><ThemeToggle /><ThemeToggle /></>));
  storageChanges("amoled");
  expect(document.documentElement.dataset.theme).toBe("amoled");
  expect(host.querySelectorAll('button[aria-label="Theme: AMOLED Dark"]')).toHaveLength(2);
  storageChanges("system");
  systemChanges(true);
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(host.querySelectorAll('button[aria-label="Theme: System"]')).toHaveLength(2);
});

it("ignores unrelated and session-storage events", () => {
  act(() => root.render(<ThemeSync />));
  storageChanges("amoled", "zenith-shell-collapsed");
  storageChanges("amoled", THEME_STORAGE_KEY, sessionStorage);
  expect(document.documentElement.getAttribute("data-theme")).toBeNull();
});

it.each([null, "invalid"])("keeps the displayed theme when another tab removes or corrupts its preference: %s", (value) => {
  act(() => root.render(<ThemeSync />));
  act(() => chooseTheme("amoled"));
  storageChanges(value);
  expect(document.documentElement.dataset.theme).toBe("amoled");
  storageChanges(null, null);
  expect(document.documentElement.dataset.themePreference).toBe("amoled");
});

it("preserves System through root remounts when storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Blocked"); });
  act(() => root.render(<ThemeSync key="first" />));
  act(() => chooseTheme("system"));
  act(() => root.render(<ThemeSync key="next" />));
  systemChanges(true);
  expect(document.documentElement.dataset.themePreference).toBe("system");
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("uses one root listener under StrictMode and releases it when unmounted", () => {
  act(() => root.render(<StrictMode><ThemeSync /></StrictMode>));
  expect(mediaListeners.size).toBe(1);
  act(() => root.render(null));
  expect(mediaListeners.size).toBe(0);
  storageChanges("amoled");
  expect(document.documentElement.getAttribute("data-theme")).toBeNull();
});

it.each(["light", "dark", "amoled", "system"])("agrees with the actual pre-paint script for saved %s", (preference) => {
  light = true;
  localStorage.setItem(THEME_STORAGE_KEY, preference);
  window.eval(THEME_BOOTSTRAP_SCRIPT);
  const before = document.documentElement.getAttribute("data-theme");
  act(() => root.render(<><ThemeSync /><ThemeToggle /></>));
  expect(document.documentElement.getAttribute("data-theme")).toBe(before);
  expect(document.documentElement.dataset.themePreference).toBe(preference);
});

it("does not fail mounting or switching if matchMedia is unavailable", () => {
  vi.stubGlobal("matchMedia", undefined);
  localStorage.setItem(THEME_STORAGE_KEY, "system");
  act(() => root.render(<ThemeSync />));
  expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  act(() => chooseTheme("amoled"));
  expect(document.documentElement.dataset.theme).toBe("amoled");
});

it("applies the saved preference when a client root error has no executing head script", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "amoled");
  // React-inserted scripts do not execute; the boundary's layout effect calls
  // this same bootstrap directly before its newly rendered body is painted.
  initializeTheme();
  expect(document.documentElement.dataset.theme).toBe("amoled");
  expect(document.documentElement.dataset.themePreference).toBe("amoled");
});

it("keeps an already-applied storage-denied choice when initializing a root error", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Blocked"); });
  act(() => chooseTheme("amoled"));
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  initializeTheme();
  expect(document.documentElement.dataset.theme).toBe("amoled");
});
