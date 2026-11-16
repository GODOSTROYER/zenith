import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEventStream } from "@/lib/client/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useEventStream payload and transport errors", () => {
  let root: Root;
  let host: HTMLDivElement;
  let streams: FakeEventSource[];
  let pageErrors: unknown[];
  const onEvent = vi.fn();

  class FakeEventSource {
    // A DOM-owned target lets jsdom report callback exceptions to window,
    // as EventSource does in a browser. A bare jsdom EventTarget drops them.
    private readonly target = document.createElement("span");
    addEventListener = this.target.addEventListener.bind(this.target);
    removeEventListener = this.target.removeEventListener.bind(this.target);
    dispatchEvent = this.target.dispatchEvent.bind(this.target);
    onopen: (() => void) | null = null;
    private errorHandler: ((event: Event) => void) | null = null;
    close = vi.fn();

    constructor(readonly url: string) {
      streams.push(this);
    }

    // A real EventSource invokes both an error listener and its onerror
    // property for the same event, including a server's named error message.
    set onerror(handler: ((event: Event) => void) | null) {
      if (this.errorHandler) this.removeEventListener("error", this.errorHandler);
      this.errorHandler = handler;
      if (handler) this.addEventListener("error", handler);
    }

    emit(type: string, data: string, seq = 0) {
      this.dispatchEvent(new MessageEvent(type, { data, lastEventId: String(seq) }));
    }
  }

  function Probe() {
    const { connected } = useEventStream("/api/logs/staging/web", ["log", "error"], onEvent);
    return <output>{connected ? "connected" : "disconnected"}</output>;
  }

  const capturePageError = (event: ErrorEvent) => {
    pageErrors.push(event.error);
    event.preventDefault();
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    onEvent.mockReset();
    streams = [];
    pageErrors = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    window.addEventListener("error", capturePageError);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Probe />));
    act(() => streams[0].onopen?.());
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.removeEventListener("error", capturePageError);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reconnects after a native transport error without sending an absent payload to the screen", async () => {
    act(() => streams[0].emit("log", JSON.stringify({ line: "ready" }), 7));
    onEvent.mockClear();

    act(() => streams[0].dispatchEvent(new Event("error")));

    expect(onEvent).not.toHaveBeenCalled();
    expect(pageErrors).toEqual([]);
    expect(host.textContent).toBe("disconnected");
    expect(streams[0].close).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(streams).toHaveLength(2);
    expect(streams[1].url).toBe("/api/logs/staging/web?after=7");
  });

  it("ignores a non-message event with no data on a subscribed payload channel", () => {
    act(() => streams[0].dispatchEvent(new Event("log")));

    expect(onEvent).not.toHaveBeenCalled();
    expect(pageErrors).toEqual([]);
    expect(host.textContent).toBe("connected");
  });

  it("forwards a server's named error payload once without treating it as a broken connection", async () => {
    const payload = { message: "Logs unavailable", fix: "Check the provider connection." };
    act(() => streams[0].emit("error", JSON.stringify(payload), 9));

    expect(onEvent).toHaveBeenCalledExactlyOnceWith("error", payload, 9);
    expect(pageErrors).toEqual([]);
    expect(host.textContent).toBe("connected");
    expect(streams[0].close).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(streams).toHaveLength(1);
  });

  it("preserves non-JSON message text as a single callback", () => {
    act(() => streams[0].emit("log", "plain log output", 4));

    expect(onEvent).toHaveBeenCalledExactlyOnceWith("log", "plain log output", 4);
    expect(pageErrors).toEqual([]);
  });

  it("reports a callback exception once without invoking it again with raw JSON", () => {
    const failure = new Error("Screen callback failed");
    onEvent.mockImplementation(() => { throw failure; });
    act(() => streams[0].emit("log", JSON.stringify({ line: "ready" }), 2));

    expect(onEvent).toHaveBeenCalledExactlyOnceWith("log", { line: "ready" }, 2);
    expect(pageErrors).toEqual([failure]);
  });
});
