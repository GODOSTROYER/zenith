import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useJson, type Loadable } from "@/lib/client/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useJson request scheduling", () => {
  let root: Root;
  let host: HTMLDivElement;
  let current: Loadable<{ value: number }>;
  let requests: Array<(value: number, ok?: boolean) => void>;
  let visibility: ReturnType<typeof vi.spyOn>;

  function Probe({ url = "/test/poll", interval = 1000 }: { url?: string | null; interval?: number }) {
    current = useJson<{ value: number }>(url, interval);
    return <span>{current.data?.value ?? "loading"}</span>;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    requests = [];
    visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => {
      requests.push((value, ok = true) => resolve({ ok, status: ok ? 200 : 500, json: async () => ({ value }) }));
    })));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); requests.forEach((resolve) => resolve(0)); });
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const render = async (props = {}) => { await act(async () => root.render(<Probe {...props} />)); };
  const finish = async (index: number, value: number, ok = true) => { await act(async () => requests[index](value, ok)); };
  const advance = async (ms: number) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };

  it("waits for a slow read to finish before starting its poll interval", async () => {
    await render();
    await advance(20_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await finish(0, 1);
    expect(host.textContent).toBe("1");
    await advance(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares pending reads across Strict Mode remounts and identical subscribers", async () => {
    await act(async () => root.render(<StrictMode><Probe /><Probe /></StrictMode>));
    expect(fetch).toHaveBeenCalledTimes(1);
    await finish(0, 7);
    expect(host.textContent).toBe("77");
  });

  it("coalesces explicit refreshes while pending into one fresh read afterwards", async () => {
    await render();
    await act(async () => { current.refresh(); current.refresh(); current.refresh(); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await finish(0, 1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await finish(1, 2);
    expect(host.textContent).toBe("2");
  });

  it("backs off unchanged reads and preserves data identity", async () => {
    await render();
    await finish(0, 1);
    const first = current.data;
    await advance(1000);
    await finish(1, 1);
    expect(current.data).toBe(first);
    await advance(1999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops in a hidden tab, catches up once on return, and does not poll after unmount", async () => {
    await render();
    await finish(0, 1);
    visibility.mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(20_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    await finish(1, 2);
    await advance(20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("changes polling mode without clearing data or creating an extra request", async () => {
    await render();
    await finish(0, 1);
    await render({ interval: 0 });
    expect(host.textContent).toBe("1");
    await advance(20_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await render({ interval: 1000 });
    await advance(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("re-syncs once on tab return even when an SSE connection disabled polling", async () => {
    await render({ interval: 0 });
    await finish(0, 1);
    visibility.mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(20_000);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await finish(1, 2);
    await advance(20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("2");
  });

  it("ignores an old URL's late response and retries after errors", async () => {
    await render();
    await render({ url: "/test/other" });
    await finish(0, 9);
    expect(host.textContent).toBe("loading");
    await finish(1, 2, false);
    expect(current.error?.status).toBe(500);
    await advance(1000);
    await finish(2, 3);
    expect(current.error).toBeUndefined();
    expect(host.textContent).toBe("3");
  });
});
