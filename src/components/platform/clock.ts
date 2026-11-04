"use client";
/**
 * A ticking "now" for countdowns.
 *
 * `override` (an ISO string or Date) freezes the clock: tests and stories pass
 * one so output is deterministic, and a host that already owns a clock can share
 * it. Without it the value refreshes every `intervalMs`. Server render and first
 * client render both use the moment of render, so a countdown never claims more
 * precision than its interval.
 */
import { useEffect, useState } from "react";

export function useNow(override?: Date | string, intervalMs = 30_000): number {
  const fixed = override === undefined ? undefined : new Date(override).getTime();
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const t = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [fixed, intervalMs]);
  return fixed !== undefined && Number.isFinite(fixed) ? fixed : tick;
}
