import { describe, expect, it } from "vitest";
import { pollDelay, streamedPollMs } from "@/lib/client/api";

/**
 * The fallback behind ProjectProvider. The project screen prefers
 * `/api/projects/:id/stream` and keeps the 5s poll behind it; this is the
 * decision that switches between them, so the failure modes are pinned here
 * rather than in a render test that can only reach one of them.
 */
const BASE = 5000;

describe("streamedPollMs", () => {
  it("turns the poll off only while the stream is delivering", () => {
    expect(streamedPollMs(true, BASE)).toBe(0);
  });

  it("falls back to the unchanged poll interval when the stream is not live", () => {
    // Covers every way the stream can be unavailable, because the provider
    // collapses them all into one flag: no EventSource in this browser, a
    // connection that errored, one that is still reconnecting, and — the one
    // a `connected` check alone would miss — a socket that opened but has
    // never delivered a payload (a buffering proxy, a route that throws after
    // the first frame). A screen must never be left with neither transport.
    expect(streamedPollMs(false, BASE)).toBe(BASE);
  });

  it("still backs off while it is polling", () => {
    const ms = streamedPollMs(false, BASE);
    expect(pollDelay(ms, 2)).toBe(20_000);
  });
});
