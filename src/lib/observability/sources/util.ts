/** Small helpers shared by the AWS sources. */
import { raceAbort, throwIfAborted } from "../abort";

/**
 * Map `items` through `fn` with at most `concurrency` in flight. Results keep
 * input order. Stops starting new work once `signal` aborts and rejects with
 * the abort reason.
 */
export async function mapPool<T, R>(items: readonly T[], concurrency: number, signal: AbortSignal, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      throwIfAborted(signal);
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}

/** An AWS SDK / fetch call that stops waiting the moment `signal` aborts. */
export const abortable = <T>(promise: Promise<T> | T, signal: AbortSignal): Promise<T> => raceAbort(promise, signal);

export const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
