/**
 * Naming helpers shared by every AWS resource driver (DRIVER-CONVENTIONS).
 *
 *   tofu labels   `service/web` → `service_web`; suffixes for extra resources
 *                 of one node (`service_web_sg`). Lossless for the address
 *                 alphabet manifests produce (`[a-z0-9-]` plus `/`); an address
 *                 with any other character (hostnames: `.`) gets a 6-hex hash
 *                 of the RAW address appended, so `a-b.example.com` and
 *                 `a.b.example.com` can never share a label.
 *   cloud names   `${namePrefix}-<name>` restricted to `[a-z0-9-]`, cut to the
 *                 service's limit with a deterministic 6-hex fnv1a suffix of
 *                 the untruncated name when it had to be cut (or rewritten).
 *
 * Pure: no I/O, no clock, no randomness. The hash is FNV-1a 32-bit over the
 * UTF-8 bytes, so a Go or Python re-implementation reproduces it exactly.
 */

/** FNV-1a 32-bit over UTF-8 bytes, as 8 lowercase hex characters. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The 6-hex suffix convention: the first six characters of {@link fnv1a}. */
export const hash6 = (input: string): string => fnv1a(input).slice(0, 6);

const MAX_LABEL = 100;

/**
 * A tofu block label for a node address. Sanitized to `[a-z0-9_]`; never empty,
 * never starting with a digit, at most 100 characters.
 */
export function tfLabel(address: string): string {
  let label = address.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const lossy = /[^a-z0-9_/-]/.test(address);
  if (lossy) label = `${label}_${hash6(address)}`;
  if (label.length > MAX_LABEL) label = `${label.slice(0, MAX_LABEL - 7)}_${hash6(address)}`;
  if (label === "") label = "_";
  return /^[0-9]/.test(label) ? `_${label}` : label;
}

/** `service/web` → `web`; an address with no `/` is returned whole. */
export function nodeName(address: string): string {
  const i = address.indexOf("/");
  return i < 0 ? address : address.slice(i + 1);
}

/** `service/web` → `service`. */
export function nodeKindPrefix(address: string): string {
  const i = address.indexOf("/");
  return i < 0 ? address : address.slice(0, i);
}

/**
 * `${prefix}-${name}` as a provider-safe name: lowercase `[a-z0-9-]`, no leading,
 * trailing or doubled hyphens, at most `max` characters. `_`, `/` and `.` become
 * hyphens without a hash (they are the normal address alphabet); any other
 * rewritten character, or truncation, appends `-<hash6>` of the raw input so
 * two inputs can only collide by a 24-bit hash collision.
 */
export function cloudName(prefix: string, name: string, max: number): string {
  if (!Number.isInteger(max) || max < 12) throw new RangeError("cloudName: max must be an integer of at least 12.");
  const raw = prefix === "" ? name : `${prefix}-${name}`;
  const lowered = raw.toLowerCase();
  const rewritten = /[^a-z0-9\-_/.]/.test(lowered);
  const clean = lowered
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = clean === "" ? "x" : clean;
  if (!rewritten && base.length <= max) return base;
  const keep = Math.max(1, Math.min(base.length, max - 7));
  return `${base.slice(0, keep).replace(/-+$/, "") || "x"}-${hash6(raw)}`;
}

/** `service/web` → `service-web`, the slug used in names that must be unique across kinds. */
export function addressSlug(address: string): string {
  return address.replace(/[/_.]/g, "-");
}
