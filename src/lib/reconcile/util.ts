/**
 * Small concurrency helpers: a bounded worker pool and a timeout race that
 * also aborts the work it started.
 *
 * Nothing here knows about resources. Kept apart so the observation step and
 * the pass loop share one implementation of "bounded" and "timed out".
 */

/** The reason attached to an aborted signal when a deadline, not a caller, stopped the work. */
export class TimeoutError extends Error {
  readonly code = "timeout";
  constructor(readonly ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order
 * in the result. `fn` must not reject: a rejection is left to the caller's
 * `Promise.all` semantics (the other workers finish their current item, then
 * stop taking new ones). Every call site in this module catches inside `fn`.
 */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  await Promise.all(Array.from({ length: items.length === 0 ? 0 : width }, worker));
  return out;
}

/**
 * Race `run` against a timer. `run` receives an AbortSignal that aborts when
 * the timer fires or when `parent` aborts, so a well-behaved driver stops its
 * provider call; a driver that ignores the signal is still abandoned (its late
 * result is swallowed, never an unhandled rejection).
 */
export function raceTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const budget = Math.max(0, Math.trunc(ms));
  if (budget === 0) return Promise.reject(new TimeoutError(0));
  if (parent?.aborted) return Promise.reject(parent.reason ?? new TimeoutError(budget));
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new TimeoutError(budget);
      controller.abort(err);
      reject(err);
    }, budget);
    const onParentAbort = (): void => {
      clearTimeout(timer);
      reject(parent?.reason ?? new TimeoutError(budget));
    };
    parent?.addEventListener("abort", onParentAbort, { once: true });
    const settle = (): void => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    };
    const work = Promise.resolve().then(() => run(signal));
    work.then(
      (value) => {
        settle();
        resolve(value);
      },
      (err: unknown) => {
        settle();
        reject(err);
      }
    );
    // A late settlement after the race was lost must never surface as unhandled.
    work.catch(() => undefined);
  });
}

/** FNV-1a, 32 bit. Deterministic, dependency-free; used for jitter and ids, never for security. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const iso = (d: Date): string => d.toISOString();
