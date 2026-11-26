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

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Time-ordered id with a random tail from the platform CSPRNG. Ids name tenant
 * resources (an AWS connection id is part of its OIDC subject), so the tail must
 * not be predictable the way `Math.random` is. Same shape as before: base-36
 * time followed by six base-36 characters.
 */
export const id = () => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  let tail = "";
  for (const byte of bytes) tail += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${Date.now().toString(36)}${tail}`;
};

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
