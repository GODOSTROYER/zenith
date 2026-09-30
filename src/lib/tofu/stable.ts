/**
 * Deterministic serialization of tf.json files.
 *
 * Object keys are sorted (UTF-16 code unit order, same as `canonical()` in the
 * control-plane digest module), arrays keep their order, `undefined` members
 * are dropped, output is 2-space indented with a trailing newline. Two
 * workspaces built from the same fragments in any order therefore produce
 * byte-identical files and the same `configDigest`.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}
