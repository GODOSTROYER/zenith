/** Display heuristic only: 15 minutes is a UI freshness threshold, not a provider SLA or new observation. */
export const STALE_AFTER_MS = 15 * 60 * 1000;
export function freshness(at: string, nowMs: number): "stale" | "recent" | "unknown" {
  const time = Date.parse(at);
  if (!Number.isFinite(time) || time > nowMs) return "unknown";
  return nowMs - time > STALE_AFTER_MS ? "stale" : "recent";
}
