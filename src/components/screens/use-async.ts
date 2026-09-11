"use client";
/**
 * The busy/error pair every async button hand-wrote: flip busy on, clear the
 * last error, run the work, keep whatever it threw, always flip busy back.
 * Returns `undefined` when the work threw, so callers can `if (!r) return`.
 */
import { useCallback, useState } from "react";

export function useAsync<T>() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const clearError = useCallback(() => setError(undefined), []);

  const run = useCallback(async (work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      return await work();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, run, clearError };
}
