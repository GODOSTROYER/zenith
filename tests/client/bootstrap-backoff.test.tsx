/**
 * The bootstrap poll does not back off.
 *
 * `/api/bootstrap` is how a tab learns about something done elsewhere — a
 * workspace joined, a project created in another tab — so an unchanged answer
 * is the ordinary case rather than a reason to ask less often. With the shared
 * 4× idle ceiling that news arrived up to 40s late; the provider now asks for
 * no backoff, and the route's ETag keeps a quiet tab down to a 304.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useJson } from "@/lib/client/api";
import { ShellProvider } from "@/components/shell/shell-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let count: number;

const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  count = 0;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("fetch", vi.fn(async () => {
    count += 1;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ same: true }) };
  }));
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

describe("bootstrap polling", () => {
  it("keeps asking every 10s however long nothing changes", async () => {
    await act(async () => root.render(<ShellProvider>{null}</ShellProvider>));
    await advance(0);
    expect(count).toBe(1);
    expect(fetch).toHaveBeenCalledWith("/api/bootstrap", expect.anything());

    // Four identical answers in a row: with the default ceiling the fourth
    // would not have been asked for until 10+20+40+40s had passed.
    await advance(40_000);
    expect(count).toBe(5);
  });

  it("still backs off for a URL that did not ask for the cap", async () => {
    function Probe() {
      useJson<{ same: boolean }>("/api/other", 10_000);
      return null;
    }
    await act(async () => root.render(<Probe />));
    await advance(0);
    await advance(40_000);
    expect(count).toBe(3); // 10s, then 20s, then 40s — the third is still pending
  });
});
