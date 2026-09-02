/**
 * The anchored-overlay primitive the bell and both chrome chips now share, and
 * the tooltip binding that used to leave a `role="tooltip"` with nothing
 * pointing at it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Chip, MenuItem, Popover, Tooltip } from "@/components/ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function render(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const menu = (open: boolean, onClose = () => {}) =>
  h(Popover, {
    open,
    onClose,
    label: "Account",
    trigger: h("button", { type: "button", children: "open" }),
    children: [
      h(MenuItem, { key: "a", href: "/one", children: "One" }),
      h(MenuItem, { key: "b", onClick: () => {}, children: "Two" }),
      h(MenuItem, {
        key: "c",
        disabled: true,
        disabledReason: "Needs the admin role.",
        children: "Three",
      }),
    ],
  });

const items = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[role="menuitem"]')];

describe("<Popover>", () => {
  it("renders nothing until it is open, and keeps the trigger visible", () => {
    const el = render(menu(false));
    expect(el.querySelector('[role="menu"]')).toBeNull();
    expect(el.querySelector("button")).not.toBeNull();
  });

  it("renders the panel with menu semantics when open", () => {
    const el = render(menu(true));
    expect(el.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Account");
    expect(items(el)).toHaveLength(3);
  });

  it("moves focus with the arrow keys and skips a disabled item", () => {
    const el = render(menu(true));
    const panel = el.querySelector<HTMLElement>('[role="menu"]')!;
    const key = (k: string) =>
      act(() => {
        panel.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
      });
    items(el)[0].focus();
    key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Two");
    // Three is disabled, so Down wraps past it back to the top.
    key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("One");
    key("ArrowUp");
    expect(document.activeElement?.textContent).toBe("Two");
  });

  it("jumps to the last enabled item with End", () => {
    const el = render(menu(true));
    const panel = el.querySelector<HTMLElement>('[role="menu"]')!;
    act(() => {
      panel.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(document.activeElement?.textContent).toBe("Two");
  });

  it("closes on Escape", () => {
    let closed = false;
    render(menu(true, () => (closed = true)));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(closed).toBe(true);
  });

  it("closes on a click outside, and not on one inside", () => {
    let closes = 0;
    const el = render(menu(true, () => closes++));
    act(() => {
      el.querySelector('[role="menu"]')!.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
    });
    expect(closes).toBe(0);
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(closes).toBe(1);
  });
});

describe("<MenuItem>", () => {
  it("is a link when it navigates and a button when it acts", () => {
    const el = render(menu(true));
    expect(items(el)[0].tagName).toBe("A");
    expect(items(el)[1].tagName).toBe("BUTTON");
  });

  it("says why a disabled row is disabled, rather than looking identical", () => {
    const el = render(menu(true));
    const off = items(el)[2];
    expect(off.getAttribute("aria-disabled")).toBe("true");
    expect(off.getAttribute("title")).toBe("Needs the admin role.");
    expect(off.tagName).toBe("SPAN"); // not focusable, not clickable
  });
});

describe("<Tooltip>", () => {
  it("binds the label to its trigger with aria-describedby (H8)", () => {
    const el = render(
      h(Tooltip, {
        label: "What this means",
        children: h(Chip, { children: "planner" }),
      })
    );
    const tip = el.querySelector('[role="tooltip"]')!;
    const trigger = [...el.querySelectorAll("span")].find(
      (s) => s.getAttribute("aria-describedby") === tip.id
    );
    expect(tip.id).toBeTruthy();
    expect(trigger).toBeTruthy();
    expect(trigger).not.toBe(tip);
    expect(tip.textContent).toBe("What this means");
  });

  it("falls back to the wrapper when the child is not a single element", () => {
    const el = render(h(Tooltip, { label: "note", children: "plain text" }));
    const tip = el.querySelector('[role="tooltip"]')!;
    expect(el.firstElementChild!.getAttribute("aria-describedby")).toBe(tip.id);
  });
});
