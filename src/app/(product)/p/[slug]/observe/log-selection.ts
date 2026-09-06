export const ALL_SERVICES = "__all__";

/** Preserve an operator's filter when a refreshed manifest has the same services. */
export function resolveLogSelection(current: string, liveIds: string[], undeployedIds: string[]): string {
  if (current === ALL_SERVICES && liveIds.length > 1) return current;
  if (current && [...liveIds, ...undeployedIds].includes(current)) return current;
  return liveIds[0] ?? "";
}
