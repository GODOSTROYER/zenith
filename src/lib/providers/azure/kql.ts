/**
 * KQL construction from PARAMETERS. Query text is never assembled from raw
 * user text: every value is a typed parameter that is validated and then
 * rendered as a KQL literal with proper escaping, and the query shapes
 * themselves are a closed set of templates in this repository.
 *
 * KQL string literals used here are double-quoted; inside them a backslash and
 * a double quote are escaped with a backslash, and control characters are
 * refused outright (a newline in a value is a bug or an attack, not data).
 */

export class KqlError extends Error {
  readonly code = "kql_invalid_parameter";
}

/** `"…"` with `\` and `"` escaped. Refuses control characters and absurd lengths. */
export function kqlString(value: string, max = 512): string {
  if (typeof value !== "string") throw new KqlError("KQL string parameter must be a string.");
  if (value.length > max) throw new KqlError(`KQL string parameter exceeds ${max} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new KqlError("KQL string parameter contains a control character.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A KQL `dynamic`/timespan-free integer literal. */
export function kqlInt(value: number, min: number, max: number): string {
  if (!Number.isInteger(value) || value < min || value > max) throw new KqlError(`KQL integer parameter must be an integer in ${min}..${max}.`);
  return String(value);
}

/** `datetime(2026-09-30T12:00:00.0000000Z)` from a Date (UTC, fixed shape). */
export function kqlDatetime(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new KqlError("Invalid date.");
  return `datetime(${d.toISOString()})`;
}

/** Column/identifier names come from code, never from callers; this guards a mistake. */
export function kqlIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new KqlError("Invalid KQL identifier.");
  return name;
}
