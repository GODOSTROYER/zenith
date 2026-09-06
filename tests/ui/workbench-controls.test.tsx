import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs } from "@/components/ui/tabs";
import { LogViewer, type LogLine } from "@/components/ui/log-viewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("modal focus and ownership", () => {
  it("respects a form's autofocus and still restores the external opener", () => {
    const screen = (open: boolean) => <>
      <button id="autofocus-trigger">Open form</button>
      <Dialog open={open} onClose={() => {}} title="New resource">
        <Input autoFocus aria-label="Resource name" />
      </Dialog>
    </>;
    act(() => root.render(screen(false)));
    const trigger = host.querySelector<HTMLButtonElement>("button")!;
    trigger.focus();
    act(() => root.render(screen(true)));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Resource name");
    act(() => root.render(screen(false)));
    expect(document.activeElement).toBe(trigger);
  });

  it("focuses after the portal exists, preserves a draft's focus on updates, and restores its trigger only on close", () => {
    const close = vi.fn();
    const screen = (open: boolean, revision: number) => <>
      <button id="open">Open review</button>
      <Dialog open={open} onClose={() => close(revision)} title="Review changes">
        <Input defaultValue="existing draft" aria-label="Draft" />
      </Dialog>
    </>;
    act(() => root.render(screen(false, 0)));
    const trigger = host.querySelector<HTMLButtonElement>("#open")!;
    trigger.focus();
    act(() => root.render(screen(true, 1)));
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(panel.contains(document.activeElement)).toBe(true);
    const input = panel.querySelector("input")!;
    input.focus();
    input.setSelectionRange(2, 6);
    act(() => root.render(screen(true, 2)));
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(close).toHaveBeenCalledExactlyOnceWith(2);
    act(() => root.render(screen(false, 3)));
    expect(document.activeElement).toBe(trigger);
    expect(panel.parentElement?.hasAttribute("inert")).toBe(true);
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("dismisses only the nested overlay and retains the parent scroll lock and focus context", () => {
    function Nested() {
      const [outer, setOuter] = useState(false);
      const [inner, setInner] = useState(false);
      return <>
        <button onClick={() => setOuter(true)}>Open outer</button>
        <Dialog open={outer} onClose={() => setOuter(false)} title="Outer">
          <button id="inner-trigger" onClick={() => setInner(true)}>Open inner</button>
          <Dialog open={inner} onClose={() => setInner(false)} title="Inner">Inner content</Dialog>
        </Dialog>
      </>;
    }
    act(() => root.render(<Nested />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    const innerTrigger = document.querySelector<HTMLButtonElement>("#inner-trigger")!;
    innerTrigger.focus();
    act(() => innerTrigger.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(innerTrigger);
    expect(document.body.style.overflow).toBe("hidden");
    act(() => vi.advanceTimersByTime(250));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});

describe("control accessibility", () => {
  it("keeps a busy button's visible action name available to assistive technology", () => {
    act(() => root.render(<Button busy>Save source</Button>));
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("Save source");
    expect(getComputedStyle(button.firstElementChild!).visibility).not.toBe("hidden");
    expect(button.firstElementChild?.getAttribute("aria-hidden")).not.toBe("true");
  });

  it.each(["input", "select", "textarea"] as const)("preserves explicit ARIA and resolves every Field description for %s", (kind) => {
    const props = { id: "resource-control", "aria-describedby": "external-help", "aria-invalid": true as const };
    act(() => root.render(<>
      <p id="external-help">External context</p>
      <Field label="Resource name" required help="Use a short name" error="Enter a unique name">
        {kind === "input" ? <Input {...props} /> : kind === "select" ? <Select {...props} options={[]} /> : <Textarea {...props} />}
      </Field>
    </>));
    const control = host.querySelector(kind)!;
    const descriptions = control.getAttribute("aria-describedby")!.split(" ");
    expect(descriptions).toHaveLength(2);
    expect(descriptions.every((id) => document.getElementById(id))).toBe(true);
    expect(descriptions).toContain("external-help");
    expect(control.getAttribute("aria-invalid")).toBe("true");
    expect(control.getAttribute("aria-required")).toBe("true");
    expect(document.getElementById(control.getAttribute("aria-labelledby")!)?.textContent).toContain("Resource name");
  });

  it("moves tab focus with selection, skips disabled tabs, and supports Home/End", () => {
    function TabExample() {
      const [value, setValue] = useState("one");
      return <Tabs value={value} onChange={setValue} items={[
        { value: "one", label: "One" }, { value: "off", label: "Unavailable", disabled: true },
        { value: "two", label: "Two" }, { value: "three", label: "Three" },
      ]} />;
    }
    act(() => root.render(<TabExample />));
    host.querySelector<HTMLButtonElement>('[role="tab"]')!.focus();
    const key = (key: string) => act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    key("ArrowRight");
    expect(document.activeElement?.textContent).toBe("Two");
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
    key("End");
    expect(document.activeElement?.textContent).toBe("Three");
    key("Home");
    expect(document.activeElement?.textContent).toBe("One");
    key("ArrowLeft");
    expect(document.activeElement?.textContent).toBe("Three");
  });
});

it("follows newly arriving logs after the 500-line cap and respects manual scrolling", () => {
  const lines: LogLine[] = Array.from({ length: 500 }, (_, seq) => ({ seq, stream: "stdout", line: `Line ${seq}` }));
  act(() => root.render(<LogViewer lines={lines} />));
  const log = host.querySelector<HTMLDivElement>('[role="log"]')!;
  let height = 10000;
  Object.defineProperty(log, "scrollHeight", { get: () => height });
  Object.defineProperty(log, "clientHeight", { value: 320 });
  act(() => root.render(<LogViewer lines={[...lines, { seq: 500, stream: "stdout", line: "A new line" }]} />));
  expect(log.scrollTop).toBe(10000);
  log.scrollTop = 200;
  act(() => log.dispatchEvent(new Event("scroll")));
  expect(log.getAttribute("aria-live")).toBe("off");
  height = 11000;
  act(() => root.render(<LogViewer lines={[...lines, { seq: 501, stream: "stdout", line: "Another new line" }]} />));
  expect(log.scrollTop).toBe(200);
});
