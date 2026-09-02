/**
 * The notice primitive, rendered.
 *
 * The audit finding this replaced was not "these boxes look different" — it was
 * that fifteen hand-rolled copies disagreed about whether a notice interrupts a
 * screen reader. So the one thing worth pinning is the announcement each tone
 * gets by default, and that a surface can still say otherwise.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Callout, type CalloutProps } from "@/components/ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(props: CalloutProps): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(Callout, props)));
  return host.firstElementChild as HTMLElement;
}

describe("<Callout>", () => {
  it("makes an error interrupt and a warning wait its turn", () => {
    expect(render({ tone: "err", children: "boom" }).getAttribute("role")).toBe("alert");
    expect(render({ tone: "warn", children: "careful" }).getAttribute("role")).toBe("status");
  });

  it("leaves the calm tones out of the live region entirely", () => {
    expect(render({ tone: "ok", children: "valid" }).getAttribute("role")).toBeNull();
    expect(render({ tone: "info", children: "note" }).getAttribute("role")).toBeNull();
  });

  it("lets a surface override the tone's default announcement", () => {
    // Settings → Secrets and the alert banner both need this: a polled banner
    // must not shout, and a warning that lands mid-edit must.
    expect(render({ tone: "err", live: "status", children: "x" }).getAttribute("role")).toBe(
      "status"
    );
    expect(render({ tone: "warn", live: "alert", children: "x" }).getAttribute("role")).toBe(
      "alert"
    );
    expect(render({ tone: "err", live: "off", children: "x" }).getAttribute("role")).toBeNull();
  });

  it("carries the title, the body and the actions, and hides its glyph from AT", () => {
    const el = render({
      tone: "err",
      title: "Stopped",
      children: createElement("p", null, "the reason"),
      actions: createElement("button", null, "Try again"),
    });
    expect(el.textContent).toContain("Stopped");
    expect(el.textContent).toContain("the reason");
    expect(el.querySelector("button")?.textContent).toBe("Try again");
    expect(el.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("drops the glyph when a surface passes none", () => {
    expect(render({ tone: "info", icon: null, children: "plain" }).querySelector("svg")).toBeNull();
  });
});
