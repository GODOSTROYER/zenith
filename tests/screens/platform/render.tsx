/**
 * Mount helpers for the jsdom tests in this folder: the same `createRoot` + `act`
 * pattern the kit's own tests use (no testing-library in this repo), plus a few
 * queries the honesty and accessibility checks share.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: { root: Root; host: HTMLElement }[] = [];

afterEach(() => {
  for (const { root, host } of roots) {
    act(() => root.unmount());
    host.remove();
  }
  roots = [];
});

/** Render an element into the document and return its container. */
export function mount(element: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  act(() => root.render(element));
  return host;
}

/** Re-render into the same container (for prop changes). */
export function rerender(host: HTMLElement, element: ReactElement): void {
  const entry = roots.find((r) => r.host === host);
  if (!entry) throw new Error("rerender: container was not created by mount()");
  act(() => entry.root.render(element));
}

export const text = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim();

export const buttons = (el: Element): HTMLButtonElement[] => [...el.querySelectorAll("button")];

/** The first button whose accessible name (aria-label, else text) contains `name`. */
export function button(el: Element, name: string): HTMLButtonElement {
  const found = buttons(el).find((b) => (b.getAttribute("aria-label") ?? text(b)).includes(name));
  if (!found) throw new Error(`No button named "${name}". Buttons: ${buttons(el).map((b) => b.getAttribute("aria-label") ?? text(b)).join(" | ")}`);
  return found;
}

export function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Set a React-controlled input/textarea value and fire the events React listens to. */
export function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function blur(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

/** Wait for pending promises (async handlers) to settle inside act. */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Heading levels in document order, e.g. [3, 4, 4, 5]. */
export const headingLevels = (el: Element): number[] =>
  [...el.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName.slice(1)));

/** No heading may skip a level going down (h3 -> h5 is a skip; h5 -> h3 is fine). */
export function headingsDoNotSkip(el: Element): boolean {
  const levels = headingLevels(el);
  return levels.every((l, i) => i === 0 || l <= levels[i - 1] + 1);
}

/** The visible accessible name of a button: aria-label, else its text. */
export const nameOf = (b: Element): string => (b.getAttribute("aria-label") ?? text(b)).trim();

/** Elements referenced by an aria-describedby on `el`, joined as text. */
export function describedBy(el: Element): string {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
}
