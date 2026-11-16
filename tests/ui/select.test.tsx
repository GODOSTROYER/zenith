import { act, createRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Popover } from "@/components/ui/popover";
import { Select, type SelectProps } from "@/components/ui/select";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const options = [
  { value: "light", label: "Light" },
  { value: "unavailable", label: "Unavailable", disabled: true },
  { value: "dark", label: "Dark" },
  { value: "amoled", label: "AMOLED Dark" },
  { value: "auto", label: "Automatic" },
];

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const render = (node: ReactNode) => act(() => root.render(node));
const trigger = () => document.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
const native = () => document.querySelector<HTMLSelectElement>('[data-select-native]')!;
const list = () => document.querySelector<HTMLElement>('[role="listbox"]');
const option = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent === label)!;
const activeLabel = () => document.getElementById(trigger().getAttribute("aria-activedescendant") ?? "")?.textContent;
const click = (element: HTMLElement) => act(() => element.click());
const key = (key: string, extra: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
  act(() => trigger().dispatchEvent(event));
  return event;
};

function Controlled(props: Partial<SelectProps> = {}) {
  const [value, setValue] = useState("light");
  return <Select options={options} aria-label="Appearance" {...props} value={value} onChange={(event) => {
    setValue(event.currentTarget.value);
    props.onChange?.(event);
  }} />;
}

describe("themed Select", () => {
  it.each([undefined, ""])("matches native initial placeholder selection with defaultValue=%s", (defaultValue) => {
    render(<>
      <Select options={options} placeholder="Choose a theme" defaultValue={defaultValue} aria-label="Appearance" />
      <select data-reference defaultValue={defaultValue} aria-label="Native reference">
        <option value="" disabled>Choose a theme</option>
        {options.map((item) => <option key={item.value} value={item.value} disabled={item.disabled}>{item.label}</option>)}
      </select>
    </>);
    const reference = host.querySelector<HTMLSelectElement>("[data-reference]")!;
    expect(native().value).toBe(reference.value);
    expect(trigger().textContent).toBe(reference.selectedOptions[0].textContent);
  });

  it("labels the visible control and keeps help/error/required semantics", () => {
    render(<><p id="extra">Additional information</p><Field label="Appearance" required error="Choose an available theme">
      <Select options={options} aria-describedby="extra" />
    </Field></>);
    const label = document.querySelector("label")!;
    expect(document.getElementById(label.htmlFor)).toBe(trigger());
    expect(trigger().getAttribute("aria-labelledby")).toBe(label.id);
    expect(trigger().getAttribute("aria-required")).toBe("true");
    expect(trigger().getAttribute("aria-invalid")).toBe("true");
    const descriptions = trigger().getAttribute("aria-describedby")!.split(" ");
    expect(descriptions).toContain("extra");
    expect(descriptions.map((id) => document.getElementById(id)?.textContent)).toContain("Choose an available theme");
    expect(native().getAttribute("aria-hidden")).toBe("true");
    expect(native().tabIndex).toBe(-1);
    click(label);
    expect(document.activeElement).toBe(trigger());
    expect(list()).not.toBeNull();
  });

  it("portals its listbox and emits real select events once with the selected value", () => {
    const changes: { value: string; target: EventTarget; current: EventTarget }[] = [];
    const input = vi.fn();
    render(<form><Controlled name="appearance" onInput={input} onChange={(event) => changes.push({
      value: event.target.value, target: event.target, current: event.currentTarget,
    })} /></form>);
    click(trigger());
    expect(list()?.parentElement).toBe(document.body);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(list()?.id);
    click(option("AMOLED Dark"));
    expect(changes).toEqual([{ value: "amoled", target: native(), current: native() }]);
    expect(input).toHaveBeenCalledTimes(1);
    expect(trigger().textContent).toBe("AMOLED Dark");
    expect(new FormData(host.querySelector("form")!).getAll("appearance")).toEqual(["amoled"]);
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    click(trigger());
    click(option("AMOLED Dark"));
    expect(changes).toHaveLength(1);
  });

  it("explores enabled options without changing the value, Escape cancels, and Enter commits", () => {
    const changed = vi.fn();
    render(<Controlled onChange={changed} />);
    act(() => trigger().focus());
    key("ArrowDown");
    expect(activeLabel()).toBe("Light");
    key("ArrowDown");
    expect(activeLabel()).toBe("Dark");
    expect(document.activeElement).toBe(trigger());
    expect(native().value).toBe("light");
    key("Escape");
    expect(list()).toBeNull();
    expect(native().value).toBe("light");
    expect(changed).not.toHaveBeenCalled();
    key("End");
    expect(activeLabel()).toBe("Automatic");
    key("Home");
    expect(activeLabel()).toBe("Light");
    key("ArrowDown");
    key("Enter");
    expect(native().value).toBe("dark");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("supports type-ahead, repeated-letter cycling and Space to accept the match", () => {
    vi.useFakeTimers();
    render(<Controlled />);
    key("a");
    expect(activeLabel()).toBe("AMOLED Dark");
    key("a");
    expect(activeLabel()).toBe("Automatic");
    act(() => vi.advanceTimersByTime(710));
    key("a");
    key("m");
    expect(activeLabel()).toBe("AMOLED Dark");
    key(" ");
    expect(native().value).toBe("amoled");
    expect(list()).toBeNull();
  });

  it("commits on Tab without preventing normal form focus traversal", () => {
    render(<><Controlled /><button id="next">Continue</button></>);
    key("End");
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(native().value).toBe("auto");
    expect(list()).toBeNull();
    act(() => host.querySelector<HTMLElement>("#next")!.focus());
    expect(document.activeElement?.id).toBe("next");
  });

  it("supports PageDown/PageUp and scrolls the active descendant into view", () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    render(<Select aria-label="Region" options={Array.from({ length: 24 }, (_, i) => ({ value: String(i), label: `Region ${i}` }))} />);
    key("Home");
    key("PageDown");
    expect(activeLabel()).toBe("Region 10");
    key("PageUp");
    expect(activeLabel()).toBe("Region 0");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it("leaves disabled options unchanged and supports an enabled empty option", () => {
    render(<Select aria-label="Provider" defaultValue="cloud" options={[
      { value: "", label: "Sandbox" }, { value: "cloud", label: "Cloud" },
      { value: "blocked", label: "Disconnected", disabled: true },
    ]} />);
    click(trigger());
    click(option("Disconnected"));
    expect(native().value).toBe("cloud");
    expect(list()).not.toBeNull();
    click(option("Sandbox"));
    expect(native().value).toBe("");
    expect(trigger().textContent).toBe("Sandbox");
  });

  it("does not open or submit disabled controls, including disabled fieldsets", () => {
    render(<form><fieldset disabled><Select aria-label="Appearance" name="appearance" options={options} /></fieldset></form>);
    click(trigger());
    expect(list()).toBeNull();
    expect(new FormData(host.querySelector("form")!).has("appearance")).toBe(false);
    render(<Select disabled options={options} aria-label="Appearance" />);
    expect(trigger().disabled).toBe(true);
    click(trigger());
    expect(list()).toBeNull();
  });

  it("does not reopen a dismissed popup when an async disabled state clears", () => {
    const screen = (disabled: boolean) => <Select options={options} aria-label="Appearance" disabled={disabled} />;
    render(screen(false));
    click(trigger());
    render(screen(true));
    expect(list()).toBeNull();
    render(screen(false));
    expect(list()).toBeNull();
  });

  it("dismisses on outside interaction and on focus leaving the control", () => {
    render(<><Controlled /><button id="outside">Outside</button></>);
    click(trigger());
    key("End");
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(list()).toBeNull();
    expect(native().value).toBe("light");
    click(trigger());
    act(() => host.querySelector<HTMLElement>("#outside")!.focus());
    expect(list()).toBeNull();
  });

  it("toggles closed on a real pointer/mouse click sequence without reopening", () => {
    render(<Controlled />);
    click(trigger());
    act(() => trigger().dispatchEvent(new Event("pointerdown", { bubbles: true })));
    act(() => trigger().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    act(() => trigger().dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    click(trigger());
    expect(list()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps controlled owners authoritative even when a change is declined", () => {
    const changed = vi.fn();
    render(<Select aria-label="Appearance" options={options} value="light" onChange={changed} />);
    click(trigger());
    click(option("Dark"));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(trigger().textContent).toBe("Light");
    expect(native().value).toBe("light");
  });

  it("handles native change events from integrations and uncontrolled form resets", async () => {
    render(<form><Select options={options} aria-label="Appearance" defaultValue="dark" name="appearance" /></form>);
    act(() => { native().value = "amoled"; native().dispatchEvent(new Event("change", { bubbles: true })); });
    expect(trigger().textContent).toBe("AMOLED Dark");
    await act(async () => host.querySelector("form")!.reset());
    expect(native().value).toBe("dark");
    expect(trigger().textContent).toBe("Dark");
  });

  it("stays in sync when asynchronous options remove and later restore an uncontrolled value", () => {
    const screen = (items: typeof options) => <Select options={items} defaultValue="dark" aria-label="Appearance" />;
    render(screen(options));
    expect(trigger().textContent).toBe("Dark");
    render(screen(options.filter((item) => item.value !== "dark")));
    expect(native().value).toBe("light");
    expect(trigger().textContent).toBe("Light");
    render(screen(options));
    expect(native().value).toBe("light");
    expect(trigger().textContent).toBe("Light");
  });

  it("respects canceled resets, external form ownership, and controlled resets", async () => {
    render(<><form id="owner" onReset={(event) => event.preventDefault()} /><Select options={options} defaultValue="dark" aria-label="Appearance" name="appearance" form="owner" /></>);
    click(trigger()); click(option("Light"));
    await act(async () => host.querySelector("form")!.reset());
    expect(native().value).toBe("light");
    expect(trigger().textContent).toBe("Light");
    render(<form><Select options={options} value="amoled" aria-label="Appearance" onChange={() => {}} /></form>);
    await act(async () => host.querySelector("form")!.reset());
    expect(native().value).toBe("amoled");
    expect(trigger().textContent).toBe("AMOLED Dark");
  });

  it("retains a native ref and redirects imperative focus to the visible control", () => {
    const ref = createRef<HTMLSelectElement>();
    const focus = vi.fn();
    render(<Select ref={ref} options={options} aria-label="Appearance" onFocus={(event) => focus(event.currentTarget)} />);
    expect(ref.current).toBeInstanceOf(HTMLSelectElement);
    act(() => ref.current!.focus());
    expect(document.activeElement).toBe(trigger());
    expect(focus).toHaveBeenCalledExactlyOnceWith(native());
  });

  it("blocks required empty submission, exposes the error, then clears it after selection", () => {
    const submit = vi.fn();
    render(<form onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <fieldset><Select name="appearance" aria-label="Appearance" options={options} placeholder="Choose a theme" defaultValue="" required /></fieldset>
      <button type="submit">Save</button>
    </form>);
    click(host.querySelector<HTMLButtonElement>('[type="submit"]')!);
    expect(submit).not.toHaveBeenCalled();
    expect(trigger().getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(document.activeElement).toBe(trigger());
    click(trigger()); click(option("Dark"));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    click(host.querySelector<HTMLButtonElement>('[type="submit"]')!);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("preserves focus/key callbacks and honors a prevented interaction", () => {
    const keyTargets: EventTarget[] = [];
    render(<Select options={options} aria-label="Appearance" onKeyDown={(event) => {
      keyTargets.push(event.currentTarget);
      if (event.key === "End") event.preventDefault();
    }} />);
    key("End");
    expect(list()).toBeNull();
    expect(keyTargets).toEqual([native()]);
    key("Home");
    expect(list()).not.toBeNull();
  });

  it("clamps its portaled popup to a narrow viewport and opens upward when needed", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return (this.getAttribute("role") === "listbox"
        ? { width: 176, height: 160, top: 0, bottom: 160, left: 0, right: 176 }
        : { width: 100, height: 36, top: 550, bottom: 586, left: 280, right: 380 }) as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(160);
    vi.stubGlobal("innerWidth", 320);
    vi.stubGlobal("innerHeight", 640);
    render(<Controlled />);
    click(trigger());
    expect(list()?.style.width).toBe("176px");
    expect(list()?.style.left).toBe("132px");
    expect(list()?.style.top).toBe("386px");
    expect(list()?.style.maxHeight).toBe("288px");
  });

  it("keeps an open selection and its focus when the document theme changes", () => {
    render(<Controlled />);
    click(trigger()); key("ArrowDown");
    for (const theme of ["light", "dark", "amoled"]) {
      document.documentElement.dataset.theme = theme;
      expect(list()?.parentElement).toBe(document.body);
      expect(activeLabel()).toBe("Dark");
      expect(document.activeElement).toBe(trigger());
    }
    key("Enter");
    expect(native().value).toBe("dark");
  });

  it("preserves native multiple-listbox values and form data without a popup", () => {
    render(<form><Select multiple size={4} options={options} defaultValue={["light", "amoled"]} name="appearance" aria-label="Appearance" /></form>);
    expect(trigger()).toBeNull();
    expect(new FormData(host.querySelector("form")!).getAll("appearance")).toEqual(["light", "amoled"]);
  });
});

describe("Select inside overlays", () => {
  it("consumes the first Escape without dismissing its enclosing dialog", () => {
    const close = vi.fn();
    render(<Dialog open onClose={close} title="Edit environment"><Controlled /></Dialog>);
    click(trigger());
    key("ArrowDown");
    key("Escape");
    expect(list()).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(native().value).toBe("light");
    expect(document.activeElement).toBe(trigger());
    key("Escape");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("selects portaled options and dismisses just the list from inside a dialog", () => {
    const close = vi.fn();
    render(<Dialog open onClose={close} title="Edit environment"><Controlled /><button id="dialog-other">Other field</button></Dialog>);
    click(trigger());
    const item = option("AMOLED Dark");
    act(() => item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    click(item);
    expect(native().value).toBe("amoled");
    expect(close).not.toHaveBeenCalled();
    click(trigger());
    act(() => document.getElementById("dialog-other")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(list()).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it("does not treat a portaled option press as an outside click on a containing popover", () => {
    const close = vi.fn();
    render(<Popover open onClose={close} role="dialog" label="Quick settings" trigger={<button>Settings</button>}><Controlled /></Popover>);
    click(trigger());
    const item = option("Dark");
    act(() => item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    click(item);
    expect(native().value).toBe("dark");
    expect(close).not.toHaveBeenCalled();
  });
});
