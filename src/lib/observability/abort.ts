/**
 * Cancellation helpers.
 *
 * Provider SDKs and `fetch` honour an AbortSignal, but a wrapper, a mock or a
 * driver bug may not — and the fabric's promise to the caller is that a slow or
 * hung source costs at most its timeout, and a caller abort returns promptly.
 * `raceAbort` makes that true regardless of whether the underlying call ever
 * settles: the call is abandoned (its late result or rejection is swallowed),
 * not leaked as an unhandled rejection.
 */

/** The reason a signal was aborted, as an Error. */
export function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new DOMException("The operation was aborted.", "AbortError");
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Settle with `promise`, or reject as soon as `signal` aborts. */
export function raceAbort<T>(work: Promise<T> | T, signal: AbortSignal): Promise<T> {
  const promise = Promise.resolve(work);
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

/** Resolve after `ms`, or reject as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class SourceTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Run `fn` with a signal that aborts when `parent` aborts or after `ms`,
 * whichever is first. The returned promise is `raceAbort`ed against that
 * signal, so it settles even if `fn` ignores it.
 */
export async function withLinkedDeadline<T>(parent: AbortSignal | undefined, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new SourceTimeoutError(ms)), ms);
  const onParent = () => ctl.abort(parent ? abortReason(parent) : undefined);
  if (parent?.aborted) onParent();
  else parent?.addEventListener("abort", onParent, { once: true });
  try {
    throwIfAborted(ctl.signal);
    // `Promise.resolve().then` so a synchronous throw inside fn is a rejection
    return await raceAbort(
      Promise.resolve().then(() => fn(ctl.signal)),
      ctl.signal
    );
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParent);
  }
}
