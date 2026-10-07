/** Calendar-day helpers for billing periods (UTC dates, no clock). */
const DAY_MS = 86_400_000;

export function addDays(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(t)) throw new RangeError(`"${day}" is not a date.`);
  return new Date(t + delta * DAY_MS).toISOString().slice(0, 10);
}
