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
    onerror: ((event: Event) => void) | null = null;
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
    fail() {
      const event = new Event("error");
      this.dispatchEvent(event);
      this.onerror?.(event);
    }
    emitError(payload: unknown) {
      const event = new MessageEvent("error", { data: JSON.stringify(payload) });
      this.dispatchEvent(event);
      this.onerror?.(event);
    }
  }

  function Probe({ url, events = ["log"] }: { url: string | null; events?: string[] }) {
    const { connected } = useEventStream(url, events, onEvent);
    return <input aria-label="Draft" defaultValue="review notes" data-connected={connected} />;
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
    act(() => { streams[0].emit(34); streams[0].fail(); });
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(streams[1].url).toBe(`${url}&after=34`);

    await render(url, ["log", "output"]);
    expect(streams[2].url).toBe(`${url}&after=34`);
  });

  it("does not let a pending old-stream reconnect reopen after switching URLs", async () => {
    await render("/api/deployments/previous/events");
    act(() => { streams[0].emit(81); streams[0].fail(); });
    await render("/api/deployments/next/events");
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(streams).toHaveLength(2);
    expect(streams[1].url).toBe("/api/deployments/next/events?after=-1");
  });

  it("reconnects on a native error without delivering an undefined application payload", async () => {
    await render("/api/logs/production/api", ["log", "error"]);
    act(() => streams[0].onopen?.());
    expect(host.querySelector("input")?.dataset.connected).toBe("true");

    act(() => streams[0].fail());
    expect(onEvent).not.toHaveBeenCalled();
    expect(host.querySelector("input")?.dataset.connected).toBe("false");
    expect(streams[0].close).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(streams[1].url).toBe("/api/logs/production/api?after=-1");
  });

  it("delivers a server error frame once without treating it as a disconnected socket", async () => {
    await render("/api/logs/production/api", ["log", "error"]);
    act(() => streams[0].onopen?.());
    const error = { message: "Provider unavailable", fix: "Check the connection." };

    act(() => streams[0].emitError(error));
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith("error", error, 0);
    expect(host.querySelector("input")?.dataset.connected).toBe("true");
    expect(streams[0].close).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(streams).toHaveLength(1);
  });

  it("ignores queued events from a closed stream after switching screens", async () => {
    await render("/api/logs/production/previous", ["log", "error"]);
    const previous = streams[0];
    await render("/api/logs/production/next", ["log", "error"]);
    act(() => streams[1].onopen?.());

    act(() => {
      previous.emit(81);
      previous.fail();
      previous.dispatchEvent(new Event("done"));
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(host.querySelector("input")?.dataset.connected).toBe("true");
    expect(streams[1].close).not.toHaveBeenCalled();

    act(() => streams[1].fail());
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(streams).toHaveLength(3);
    expect(streams[2].url).toBe("/api/logs/production/next?after=-1");
  });
});
