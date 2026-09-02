import { describe, expect, it } from "vitest";
import { MAX_IDLE_STEPS, pollDelay } from "@/lib/client/api";

/**
 * The polling backoff behind useJson. The whole point is that a tab with
 * nothing happening costs less while a tab watching a deployment does not slow
 * down, so both halves are worth pinning.
 */
describe("pollDelay", () => {
  it("polls at the requested interval while responses keep changing", () => {
    expect(pollDelay(5000, 0)).toBe(5000);
    expect(pollDelay(10_000, 0)).toBe(10_000);
  });

  it("doubles for each consecutive unchanged response", () => {
    expect(pollDelay(5000, 1)).toBe(10_000);
    expect(pollDelay(5000, 2)).toBe(20_000);
  });

  it("caps the backoff so a quiet tab still notices change eventually", () => {
    const capped = pollDelay(5000, MAX_IDLE_STEPS);
    expect(pollDelay(5000, 50)).toBe(capped);
    expect(pollDelay(5000, 999)).toBe(capped);
    expect(capped).toBe(20_000);
  });

  it("never goes below the base interval, whatever it is handed", () => {
    expect(pollDelay(5000, -3)).toBe(5000);
  });
});
