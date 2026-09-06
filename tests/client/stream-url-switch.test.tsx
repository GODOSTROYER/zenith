import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEventStream } from "@/lib/client/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useEventStream replay cursor ownership", () => {
  let root: Root;
  let host: HTMLDivElement;
  let streams: FakeEventSource[];
  const onEvent = vi.fn();

  class FakeEventSource extends EventTarget {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor(readonly url: string) {
      super();
      streams.push(this);
    }
    emit(seq: number) {
      this.dispatchEvent(new MessageEvent("log", {
        lastEventId: String(seq), data: JSON.stringify({ line: `line ${seq}` }),
      }));
    }
  }

  function Probe({ url, events = ["log"] }: { url: string | null; events?: string[] }) {
    useEventStream(url, events, onEvent);
    return <input aria-label="Draft" defaultValue="review notes" />;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    onEvent.mockClear();
    streams = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(url: string | null, events?: string[]) {
    await act(async () => root.render(<Probe url={url} events={events} />));
  }

  it("replays a newly selected deployment from the beginning without remounting the surface", async () => {
    await render("/api/deployments/previous/events");
    act(() => streams[0].emit(81));
    const input = host.querySelector("input")!;
    input.value = "unsaved review notes";

    await render("/api/deployments/next/events");
    expect(streams[0].close).toHaveBeenCalledOnce();
    expect(streams[1].url).toBe("/api/deployments/next/events?after=-1");
    expect(host.querySelector("input")).toBe(input);
    expect(input.value).toBe("unsaved review notes");
    act(() => streams[1].emit(0));
    expect(onEvent).toHaveBeenLastCalledWith("log", { line: "line 0" }, 0);
  });

  it("preserves the last received cursor on reconnect and listener changes for the same URL", async () => {
    const url = "/api/deployments/current/events?environment=staging";
    await render(url);
    act(() => { streams[0].emit(34); streams[0].onerror?.(); });
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(streams[1].url).toBe(`${url}&after=34`);

    await render(url, ["log", "output"]);
    expect(streams[2].url).toBe(`${url}&after=34`);
  });

  it("does not let a pending old-stream reconnect reopen after switching URLs", async () => {
    await render("/api/deployments/previous/events");
    act(() => { streams[0].emit(81); streams[0].onerror?.(); });
    await render("/api/deployments/next/events");
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(streams).toHaveLength(2);
    expect(streams[1].url).toBe("/api/deployments/next/events?after=-1");
  });
});
