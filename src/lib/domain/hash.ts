/**
 * Id minting and non-cryptographic hashing — the small, pure primitives the
 * domain model leans on.
 *
 * These used to sit at the top of `types.ts`, which made every consumer of a
 * hash import the whole canonical model (and zod with it). They describe no
 * domain shape, so they live here; `types.ts` re-exports them and no importer
 * had to change.
 *
 * Nothing here is cryptographic. These are fingerprints for caches, ETags,
 * deterministic jitter and idempotency keys — never for authentication.
 */

/* ---------------------------------- ids ---------------------------------- */

export const id = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/* -------------------------------- hashing -------------------------------- */

/**
 * FNV-1a, as a raw 32-bit unsigned number. Not cryptographic. The one copy of
 * this loop: the sandbox's deterministic jitter and the log simulator's seeds
 * both call it, so "same input, same output" holds across the whole product.
 */
export function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The same hash as an 8-char hex fingerprint — for caches, ETags and ids. */
export const hash32 = (s: string): string => fnv1a(s).toString(16).padStart(8, "0");

/** Key order must not change the hash: two clients serialize differently. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])])
    );
  return v;
}

/** Content fingerprint of a manifest — the optimistic-concurrency token. */
export const contentHash = (v: unknown): string => hash32(JSON.stringify(stable(v)));
