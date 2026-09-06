import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/ui/theme-toggle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function expectSelected(label: string) {
  act(() => root.render(<ThemeToggle />));
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  expect(trigger.getAttribute("aria-label")).toBe(`Theme: ${label}`);
  act(() => trigger.click());
  const selected = host.querySelector('[aria-label="current"]')?.closest('[role="menuitem"]');
  expect(selected?.textContent).toContain(label);
}

it("announces the inherited light theme after landing-to-auth navigation without a saved choice", () => {
  document.documentElement.dataset.theme = "light";
  expectSelected("Light");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("orrery-theme")).toBeNull();
});

it("keeps the unsaved dark document selected", () => {
  expectSelected("Dark");
});

it.each(["dark", "light", "system"])("preserves the explicit saved %s preference", (theme) => {
  localStorage.setItem("orrery-theme", theme);
  if (theme !== "dark") document.documentElement.dataset.theme = "light";
  expectSelected(theme[0].toUpperCase() + theme.slice(1));
  expect(localStorage.getItem("orrery-theme")).toBe(theme);
});

it("announces the displayed light theme when storage is unavailable", () => {
  document.documentElement.dataset.theme = "light";
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  expectSelected("Light");
});
