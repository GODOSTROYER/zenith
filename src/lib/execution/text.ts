/**
 * Small pure helpers every activity uses to keep what it returns, stores and
 * emits short, single-line and free of credential shapes.
 *
 * `safeText` is defense in depth, not the mechanism: activities are written so
 * that secret values never reach a string in the first place (plans are masked
 * by the engine, credentials live only inside a broker callback, drivers return
 * redacted bags). What arrives from outside — a tofu diagnostic, a driver
 * `detail`, a cloud error message, a worker exception — is data, may contain
 * anything, and passes through here before it is stored or returned.
 */
import { redactOutput } from "@/lib/tofu/redact";

const ch = String.fromCharCode;
/** C0 and C1 control characters, DEL, and the two Unicode line separators. */
const CONTROL = new RegExp(`[${ch(0)}-${ch(31)}${ch(127)}-${ch(159)}${ch(0x2028)}${ch(0x2029)}]+`, "g");

/** Redact credential shapes, flatten control characters, and cap the length. */
export function safeText(input: unknown, max = 500): string {
  let text: string;
  if (typeof input === "string") text = input;
  else if (input instanceof Error) text = input.message;
  else if (input === undefined || input === null) text = "";
  else {
    try {
      text = JSON.stringify(input) ?? "";
    } catch {
      text = String(input);
    }
  }
  const cleaned = redactOutput(text).replace(CONTROL, " ").replace(/\s{2,}/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, Math.max(0, max - 1))}…` : cleaned;
}

/** The text of an error for a message or a log line: its message, scrubbed and capped. */
export function errorText(err: unknown, max = 300): string {
  return safeText(err instanceof Error ? err.message : err, max);
}

/** Sorted, de-duplicated copy. */
export const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** `values` with each string passed through `safeText`, capped to `count` entries. */
export function safeList(values: readonly unknown[], count: number, max = 300): string[] {
  return values.slice(0, count).map((v) => safeText(v, max));
}
