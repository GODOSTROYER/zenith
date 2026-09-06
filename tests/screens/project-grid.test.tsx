/**
 * The overview cards, rendered.
 *
 * The card used to be one big link, which is why it had no way to offer an
 * environment-level entry point: an anchor cannot contain an anchor. This
 * asserts the structure that replaced it — several real links, none nested —
 * and that the filters over the cards do what their labels say.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProjectGrid } from "@/app/(product)/overview/project-grid";
import type { EnvRow, ProjectRow } from "@/app/(product)/overview/rows";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));

const env = (over: Partial<EnvRow> = {}): EnvRow => ({
  id: "e1",
  name: "staging",
  klass: "staging",
  region: "us-east-1",
  dot: "ok",
  word: "live",
  revision: "r7",
  pending: 0,
  projectedUsd: 40,
  ...over,
});

const project = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: "p1",
  name: "Atlas",
  slug: "atlas",
  workingUsd: 120,
  deployedUsd: 90,
  openFindings: 0,
  pending: 0,
  environments: [env()],
  ...over,
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function render(projects: ProjectRow[]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(ProjectGrid, { projects })));
  return host;
}

const links = (el: HTMLElement) => [...el.querySelectorAll("a")];

describe("<ProjectGrid> card structure", () => {
  it("has no anchor inside an anchor (V6)", () => {
    const el = render([
      project({ pending: 3, openFindings: 2, environments: [env(), env({ id: "e2", name: "prod", klass: "production" })] }),
    ]);
    for (const a of links(el)) expect(a.querySelector("a")).toBeNull();
    expect(links(el).length).toBeGreaterThan(4);
  });

  it("gives each environment its own link, carrying the environment it names", () => {
    const el = render([project({ environments: [env({ id: "e1" }), env({ id: "e2", name: "prod" })] })]);
    const hrefs = links(el).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/p/atlas?env=e1");
    expect(hrefs).toContain("/p/atlas?env=e2");
  });

  it("sends the findings chip to Security and the pending chip to the map (V1)", () => {
    const el = render([project({ pending: 3, openFindings: 2 })]);
    const hrefs = links(el).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/p/atlas/security");
    expect(el.textContent).toContain("3 to deploy");
    expect(el.textContent).toContain("2 open findings");
  });

  it("says nothing about pending work or findings when there is none", () => {
    const el = render([project()]);
    expect(el.textContent).not.toContain("to deploy");
    expect(el.textContent).not.toContain("open finding");
  });

  it("labels both costs rather than showing one bare number (V2)", () => {
    const el = render([project()]);
    expect(el.textContent).toContain("/mo working");
    expect(el.textContent).toContain("/mo deployed");
  });

  it("shows a budget meter only for an environment that has a budget (V7)", () => {
    expect(render([project()]).querySelectorAll('[role="meter"]').length).toBe(0);
    act(() => root!.unmount());
    const el = render([project({ environments: [env({ budgetUsd: 200, projectedUsd: 190 })] })]);
    const meter = el.querySelector('[role="meter"]');
    expect(meter).not.toBeNull();
    expect(el.textContent).toContain("staging budget");
  });
});

describe("<ProjectGrid> controls", () => {
  const atlas = project({ id: "p1", name: "Atlas", slug: "atlas" });
  const kepler = project({ id: "p2", name: "Kepler", slug: "kepler", pending: 2 });

  it("hides the controls for a single project — there is nothing to sort", () => {
    const el = render([atlas]);
    expect(el.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("filters as you type, and reports how many are shown (V8)", () => {
    const el = render([atlas, kepler]);
    expect(el.textContent).toContain("2 of 2");
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Filter projects"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "kepler");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(el.textContent).toContain("1 of 2");
    expect(el.textContent).toContain("Kepler");
    expect(el.textContent).not.toContain("Atlas");
  });

  it("narrows to what needs a human when asked", () => {
    const el = render([atlas, kepler]);
    const box = el.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.disabled).toBe(false);
    act(() => box.click());
    expect(el.textContent).toContain("1 of 2");
    expect(el.textContent).not.toContain("Atlas");
  });

  it("disables that filter, with a reason, when nothing needs a human", () => {
    const el = render([atlas, project({ id: "p3", name: "Borealis", slug: "borealis" })]);
    const box = el.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.disabled).toBe(true);
    expect(box.closest("span")?.getAttribute("title")).toBe(
      "Nothing in this workspace is waiting on you right now."
    );
  });

  it("explains an empty result instead of showing a blank grid", () => {
    const el = render([atlas, kepler]);
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Filter projects"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "zzzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(el.textContent).toContain("No project matches those filters");
    const clear = [...el.querySelectorAll("button")].find((button) => button.textContent === "Clear filters")!;
    act(() => clear.click());
    expect(el.textContent).toContain("2 of 2");
    expect(el.textContent).toContain("Atlas");
    expect(el.textContent).toContain("Kepler");
  });
  it("puts the create action before project cards", () => {
    const el = render([atlas, kepler]);
    expect(links(el)[0].textContent).toContain("New project");
    expect(links(el)[0].getAttribute("href")).toBe("/onboarding?step=3");
  });
});
