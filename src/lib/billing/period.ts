/** Calendar-month billing periods in UTC, keyed `YYYY-MM`. Pure. */
export const PERIOD = /^[0-9]{4}-(?:0[1-9]|1[0-2])$/;

export const isPeriod = (value: unknown): value is string => typeof value === "string" && PERIOD.test(value);

export function periodOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** [start, end) of the period. */
export function periodBounds(period: string): { start: Date; end: Date } {
  if (!isPeriod(period)) throw new RangeError("period must be YYYY-MM");
  const [y, m] = period.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

export function previousPeriod(period: string): string {
  const { start } = periodBounds(period);
  return periodOf(new Date(start.getTime() - 1));
}

/** A period can be invoiced only once it has ended. */
export const periodEnded = (period: string, now: Date): boolean => now.getTime() >= periodBounds(period).end.getTime();
