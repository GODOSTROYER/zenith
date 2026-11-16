import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GlobalError from "@/app/global-error";
import { THEME_STORAGE_KEY } from "@/lib/theme";

let root: Root;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-preference");
  localStorage.clear();
  window.history.replaceState(null, "", "/overview");
  log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  root = createRoot(document);
});
afterEach(() => {
  act(() => root.unmount());
  document.documentElement.innerHTML = "<head></head><body></body>";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-preference");
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  log.mockRestore();
});

it("restores saved AMOLED on client root replacement and keeps recovery actions usable", async () => {
  localStorage.setItem(THEME_STORAGE_KEY, "amoled");
  const reset = vi.fn();
  await act(async () => root.render(<GlobalError error={new Error("render failed")} reset={reset} />));
  // jsdom does not execute script elements inserted by React. This assertion
  // therefore exercises the synchronous client fallback, not only the head tag.
  expect(document.documentElement.dataset.theme).toBe("amoled");
  expect(document.documentElement.dataset.themePreference).toBe("amoled");
  expect(document.querySelector("style")?.textContent).toContain("--error-ground: #000000");
  expect(document.body.style.background).toContain("--error-ground");
  expect(document.querySelector("h1")?.textContent).toBe("Zenith could not start");
  const retry = [...document.querySelectorAll("button")].find(button => button.textContent === "Try again")!;
  await act(async () => retry.click());
  expect(reset).toHaveBeenCalledOnce();
});

it.each(["light", "dark", "legacy-invalid"])("keeps the independent error palette fallback for %s", async theme => {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  await act(async () => root.render(<GlobalError error={new Error("render failed")} reset={() => undefined} />));
  expect(document.documentElement.dataset.theme).not.toBe("amoled");
  expect(document.body.style.background).toContain("#0a0d13");
  expect(document.querySelector("main")?.style.background).toContain("#141a26");
  expect(document.querySelector("head script")?.textContent).toContain(THEME_STORAGE_KEY);
});
