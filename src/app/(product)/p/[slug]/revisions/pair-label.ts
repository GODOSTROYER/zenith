/**
 * Revision numbers sort as numbers, never as strings.
 *
 * `["r10", "r9"].sort()` puts r10 first, which reads as a diff running
 * backwards for every revision past 9. The heading has to say older → newer.
 */

/** Unknown revisions sort last, so a missing number never claims to be oldest. */
const key = (n: number | undefined): number => (n === undefined ? Number.MAX_SAFE_INTEGER : n);

/** e.g. `[10, 9]` → "r9 → r10". */
export function revisionPairLabel(numbers: (number | undefined)[]): string {
  return [...numbers]
    .sort((a, b) => key(a) - key(b))
    .map((n) => (n === undefined ? "r?" : `r${n}`))
    .join(" → ");
}
