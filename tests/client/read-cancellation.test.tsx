/**
 * A read belongs to the screen that asked for it.
 *
 * `useJson` shares one in-flight request per URL, so cancellation cannot simply
 * be "whoever leaves first aborts": a second screen reading the same URL is
 * depending on that response. The request is cancelled when the last reader
 * lets go — on unmount or a route change — and not before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useJson } from "@/lib/client/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
/** every signal `fetch` was handed, in call order */
let signals: AbortSignal[];

function Probe({ url }: { url: string | null }) {
  useJson<{ value: number }>(url, 0);
  return null;
}

/** Let the deferred cancellation decision run. */
const settle = async () => { await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  signals = [];
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  // Never resolves: the only thing that can end these requests is an abort.
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise(() => {});
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("in-flight read cancellation", () => {
  it("cancels the request when the screen that asked for it unmounts", async () => {
    await act(async () => root.render(<Probe url="/api/navigator/runs/r1" />));
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    await act(async () => root.render(null));
    await settle();
    expect(signals[0].aborted).toBe(true);
  });

  it("cancels the old request when the route changes, and starts a new one", async () => {
    await act(async () => root.render(<Probe url="/api/navigator/runs/r1" />));
    await act(async () => root.render(<Probe url="/api/navigator/runs/r2" />));
    await settle();
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it("keeps the shared request alive while another reader of the same URL is mounted", async () => {
    const both = (second: boolean) => <>
      <Probe url="/api/navigator/runs/shared" />
      {second && <Probe url="/api/navigator/runs/shared" />}
    </>;
    await act(async () => root.render(both(true)));
    expect(signals).toHaveLength(1); // one request, two readers
    await act(async () => root.render(both(false)));
    await settle();
    expect(signals[0].aborted).toBe(false);
    await act(async () => root.render(null));
    await settle();
    expect(signals[0].aborted).toBe(true);
  });
});
