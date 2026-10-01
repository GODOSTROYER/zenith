/**
 * Bounded pagination for AWS list/describe calls (DRIVER-CONVENTIONS: "honour
 * `ctx.signal`; paginate with a bounded page count").
 *
 * `fetchPage` receives the previous page's continuation token (`undefined` for
 * the first page) and returns that page's items plus the next token. The loop
 * stops at the last page, at `maxPages`, or when the signal fires (an
 * `AbortError` is thrown — an abort is never a partial result). When it stops
 * because of `maxPages`, `truncated` is true: callers must not treat the
 * result as a complete inventory.
 */
import { throwIfAborted } from "./errors";

export const DEFAULT_MAX_PAGES = 20;

export interface Page<T> {
  items: T[];
  next?: string | undefined;
}

export interface PaginateOptions {
  maxPages?: number;
  signal?: AbortSignal;
}

export async function paginate<T>(
  fetchPage: (token: string | undefined) => Promise<Page<T>>,
  opts: PaginateOptions = {}
): Promise<{ items: T[]; truncated: boolean }> {
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
  const items: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    throwIfAborted(opts.signal);
    const res = await fetchPage(token);
    items.push(...res.items);
    if (!res.next) return { items, truncated: false };
    if (res.next === token) return { items, truncated: true }; // a stuck token would loop forever
    token = res.next;
  }
  return { items, truncated: true };
}

/** Split `xs` into chunks of at most `size` (AWS batch APIs take 20/100 ids at a time). */
export function chunk<T>(xs: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
