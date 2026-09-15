/**
 * Notifications used to leave after six seconds, whatever they said.
 *
 * Six seconds is not a reading speed — and on a touch device, where there is
 * no hover to pause anything, it was often not even a chance to notice. What
 * failed, what warned, and anything offering a control now stays until it is
 * dismissed; the rest still clears itself, but pauses for a pointer, for
 * keyboard focus and for a touch, and every one of them is still in the
 * activity buffer afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DISMISS_MS,
  ToastProvider,
  isPersistent,
  trimQueue,
  useToasts,
  type ToastApi,
  type ToastRecord,
} from "@/components/ui/toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let api: ToastApi;
let mirrored: ToastRecord[];

function Probe() {
  api = useToasts();
  return null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  mirrored = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ToastProvider>
        <Probe />
      </ToastProvider>
    )
  );
  window.__zenithActivity = (t) => void mirrored.push(t);
});

afterEach(async () => {
  delete window.__zenithActivity;
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const cards = () => [...document.querySelectorAll<HTMLElement>('[role="status"]')];
const wait = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};
/**
 * React derives onMouseEnter/onPointerLeave from `mouseover`/`pointerout` and
 * a relatedTarget outside the element, so the enter/leave cases have to be
 * dispatched the way a browser would rather than as `mouseenter`.
 */
const fire = async (el: Element, type: string, outside = false) => {
  await act(async () => {
    el.dispatchEvent(
      outside
        ? new MouseEvent(type, { bubbles: true, relatedTarget: document.body })
        : new Event(type, { bubbles: true })
    );
  });
};

describe("which notifications hold", () => {
  it("keeps errors and warnings on screen past the dismissal window", async () => {
    await act(async () => {
      api.push({ kind: "err", title: "Deploy failed." });
      api.push({ kind: "warn", title: "Budget nearly spent." });
    });
    await wait(DISMISS_MS * 3);
    expect(cards()).toHaveLength(2);
  });

  it("keeps anything with a control, whatever its kind", async () => {
    await act(async () => {
      api.push({ kind: "ok", title: "Revision saved.", action: { label: "Undo", onClick: () => {} } });
    });
    await wait(DISMISS_MS * 3);
    expect(cards()).toHaveLength(1);
  });

  it("still clears a plain confirmation on its own", async () => {
    await act(async () => void api.push({ kind: "ok", title: "Deployed Atlas." }));
    expect(cards()).toHaveLength(1);
    await wait(DISMISS_MS + 10);
    expect(cards()).toHaveLength(0);
    // and it is still recoverable from the activity bell
    expect(mirrored.map((t) => t.title)).toEqual(["Deployed Atlas."]);
  });

  it("classifies without rendering anything", () => {
    expect(isPersistent({ kind: "err" })).toBe(true);
    expect(isPersistent({ kind: "warn" })).toBe(true);
    expect(isPersistent({ kind: "ok", action: { label: "Undo", onClick: () => {} } })).toBe(true);
    expect(isPersistent({ kind: "ok" })).toBe(false);
    expect(isPersistent({ kind: "info" })).toBe(false);
  });
});

describe("pausing the countdown", () => {
  /** [what, enter event, leave event, dispatched with a relatedTarget] */
  const cases: [string, string, string, boolean][] = [
    ["a pointer over it", "mouseover", "mouseout", true],
    ["keyboard focus inside it", "focusin", "focusout", false],
    ["a touch on it", "touchstart", "touchend", false],
    ["a pointer press", "pointerdown", "pointerout", true],
  ];

  for (const [what, enter, leave, outside] of cases) {
    it(`holds it for ${what}, and resumes on leaving`, async () => {
      await act(async () => void api.push({ kind: "ok", title: "Deployed Atlas." }));
      const card = cards()[0];

      await fire(card, enter, enter !== "pointerdown" && outside);
      await wait(DISMISS_MS * 2);
      expect(cards()).toHaveLength(1);

      await fire(card, leave, outside);
      await wait(DISMISS_MS - 100);
      expect(cards()).toHaveLength(1); // the window restarts, it does not resume mid-way
      await wait(200);
      expect(cards()).toHaveLength(0);
    });
  }

  it("does not restart a held notification when the pointer leaves", async () => {
    await act(async () => void api.push({ kind: "err", title: "Deploy failed." }));
    const card = cards()[0];
    await fire(card, "mouseover", true);
    await fire(card, "mouseout", true);
    await wait(DISMISS_MS * 3);
    expect(cards()).toHaveLength(1);
  });

  it("keeps the dismiss control working for a held notification", async () => {
    await act(async () => void api.push({ kind: "err", title: "Deploy failed." }));
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!;
    await act(async () => close.click());
    expect(cards()).toHaveLength(0);
  });

  it("does not animate when the viewer asked for less motion", async () => {
    await act(async () => void api.push({ kind: "ok", title: "Deployed Atlas." }));
    expect(cards()[0].className).toContain("motion-reduce:animate-none");
  });
});

describe("overflow", () => {
  it("drops a self-clearing notification before one that has to be read", async () => {
    await act(async () => {
      api.push({ kind: "ok", title: "One." });
      api.push({ kind: "err", title: "Failed." });
      api.push({ kind: "ok", title: "Two." });
      api.push({ kind: "ok", title: "Three." });
    });
    const titles = cards().map((c) => c.querySelector("p")!.textContent);
    expect(titles).toContain("Failed.");
    expect(titles).not.toContain("One.");
  });

  it("trims purely as a function of the queue", () => {
    const list = [
      { kind: "ok" as const, title: "a" },
      { kind: "err" as const, title: "b" },
      { kind: "ok" as const, title: "c" },
    ];
    expect(trimQueue(list, 3)).toBe(list);
    expect(trimQueue(list, 2).map((t) => t.title)).toEqual(["b", "c"]);
    expect(trimQueue(list, 1).map((t) => t.title)).toEqual(["b"]);
    // all of them have to be read: the oldest still gives way
    const held = [
      { kind: "err" as const, title: "a" },
      { kind: "err" as const, title: "b" },
    ];
    expect(trimQueue(held, 1).map((t) => t.title)).toEqual(["b"]);
  });
});
