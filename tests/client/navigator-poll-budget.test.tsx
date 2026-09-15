/**
 * What the Navigator's run poll actually costs (UI-7).
 *
 * The screen used to ask `/api/navigator/runs/:id` every 800ms for as long as a
 * run was executing. This counts the requests the old shape and the new one
 * make over the same simulated minute, in the three states that matter — a run
 * landing steps, a run that is waiting on something, and a backgrounded tab —
 * so the reduction is a measured number rather than a claim.
 *
 * `Math.random` is pinned so the jitter is deterministic: 0.5 with a 0.2 ratio
 * puts every new-shape interval at exactly 1.1× its base.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useJson, withJitter, type UseJsonOptions } from "@/lib/client/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Exactly what src/components/navigator/navigator-screen.tsx asks for. */
const NEW = { base: 2000, options: { jitterRatio: 0.2 } satisfies UseJsonOptions };
/** Exactly what it asked for before this change. */
const OLD = { base: 800, options: {} satisfies UseJsonOptions };

const WINDOW_MS = 60_000;

let root: Root;
let host: HTMLDivElement;
let count: number;
let visibility: ReturnType<typeof vi.spyOn>;
let seq: number;

beforeEach(() => {
  vi.useFakeTimers();
  count = 0;
  seq = 0;
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Run one shape for one simulated minute and report the requests it made.
 * `moving` decides whether the route answers with a changed payload — a step
 * landing — or the same one, which is what the backoff reacts to.
 */
async function requestsOverAMinute(
  url: string,
  shape: { base: number; options: UseJsonOptions },
  { moving, hidden = false }: { moving: boolean; hidden?: boolean }
): Promise<number> {
  visibility.mockReturnValue("visible");
  vi.stubGlobal("fetch", vi.fn(async () => {
    count += 1;
    const body = { step: moving ? (seq += 1) : 1 };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
  }));
  function Probe() {
    useJson<{ step: number }>(url, shape.base, shape.options);
    return null;
  }
  await act(async () => root.render(<Probe />));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  if (hidden) {
    visibility.mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(WINDOW_MS); });
  const made = count;
  await act(async () => root.render(null));
  count = 0;
  seq = 0;
  return made;
}

describe("Navigator run-following request budget", () => {
  it("makes far fewer requests over a minute of an actively moving run", async () => {
    const before = await requestsOverAMinute("/api/navigator/runs/old-active", OLD, { moving: true });
    const after = await requestsOverAMinute("/api/navigator/runs/new-active", NEW, { moving: true });

    // 800ms flat, never backing off while steps keep landing.
    expect(before).toBe(1 + Math.floor(WINDOW_MS / 800));
    // 2000ms + 10% jitter, likewise never backing off while steps land.
    expect(after).toBe(1 + Math.floor(WINDOW_MS / withJitter(2000, 0.2, () => 0.5)));
    expect(before / after).toBeGreaterThanOrEqual(2.5);
  });

  it("makes far fewer requests over a minute of a run that is not moving", async () => {
    const before = await requestsOverAMinute("/api/navigator/runs/old-idle", OLD, { moving: false });
    const after = await requestsOverAMinute("/api/navigator/runs/new-idle", NEW, { moving: false });

    // Both back off by the shared 4× ceiling; the new one starts 2.75× higher.
    // 800 / 1600 / 3200… against 2200 / 4400 / 8800…
    expect(before).toBe(21);
    expect(after).toBe(9);
    expect(before / after).toBeGreaterThanOrEqual(2);
  });

  it("costs one request, not sixty seconds of them, while the tab is hidden", async () => {
    const before = await requestsOverAMinute("/api/navigator/runs/old-hidden", OLD, { moving: true, hidden: true });
    const after = await requestsOverAMinute("/api/navigator/runs/new-hidden", NEW, { moving: true, hidden: true });
    expect(before).toBe(1);
    expect(after).toBe(1);
  });

  it("stops entirely once the run reaches a terminal state", async () => {
    // A null URL is what the screen passes for a finished run.
    const url: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => {
      count += 1;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ step: 1 }) };
    }));
    function Probe() {
      useJson<{ step: number }>(url, NEW.base, NEW.options);
      return null;
    }
    await act(async () => root.render(<Probe />));
    await act(async () => { await vi.advanceTimersByTimeAsync(WINDOW_MS); });
    expect(count).toBe(0);
  });
});

describe("poll jitter", () => {
  it("never shortens the interval and never exceeds the bound it promises", () => {
    expect(withJitter(2000, 0.2, () => 0)).toBe(2000);
    expect(withJitter(2000, 0.2, () => 1)).toBe(2400);
    expect(withJitter(2000, 0, () => 1)).toBe(2000);
    expect(withJitter(0, 0.5, () => 1)).toBe(0);
    // A ratio outside 0..1 is clamped rather than trusted.
    expect(withJitter(2000, -1, () => 1)).toBe(2000);
    expect(withJitter(2000, 9, () => 1)).toBe(4000);
  });
});
