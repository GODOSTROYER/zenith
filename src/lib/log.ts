/**
 * Structured logging. One JSON object per line, so `docker logs | jq` works
 * and so a log shipper has fields instead of a prose string to regex.
 *
 * Deliberately tiny: level, message, fields, request id. No transports, no
 * child loggers, no formatting options — the console is the only sink this
 * product has, and adding one is a smaller change than removing four.
 *
 * The request id comes from `AsyncLocalStorage`, so a log line written deep
 * inside an action carries the id of the request that caused it without every
 * function in between having to pass it down.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { redactCredentials } from "@/lib/credentials/redact";
import { redactText } from "@/lib/observability/redact";
import { env } from "@/lib/env";
import { currentTraceId } from "@/lib/ops/telemetry/tracing";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

/** Run `fn` with a request id attached to every log line it produces. */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

/** The current request id, if this code is running inside `withRequestId`. */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/** Fields are structured data; an Error value is flattened to name/message/stack. */
export type LogFields = Record<string, unknown>;

/**
 * Every string field passes two shared redactors on its way to the sink (PROD-OPS-06): the credential redactor
 * (AWS keys, JWTs, PEM blocks, bearer values, Zenith tokens) and the observability redactor (`scheme://user:pw@`
 * URLs, `password=` style pairs, vendor token prefixes). Plain objects and arrays are walked (bounded depth, cycles
 * become "[Circular]"); anything else (Date, Buffer, class instances with toJSON such as SecretString) is left for
 * JSON.stringify exactly as before. This is a backstop, not a secret detector: a secret with no recognisable shape
 * or key name is written as given, so callers must still keep credentials out of log fields. Messages, stacks and
 * field names are otherwise intact for operators.
 */
const MAX_LOG_DEPTH = 8;

function scrubString(text: string): string {
  return redactText(redactCredentials(text)).text;
}

function scrub(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message), stack: value.stack === undefined ? undefined : scrubString(value.stack) };
  const proto = Object.getPrototypeOf(value) as unknown;
  const plain = Array.isArray(value) || proto === Object.prototype || proto === null;
  if (!plain) return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_LOG_DEPTH) return "[truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[scrubString(key)] = scrub((value as Record<string, unknown>)[key], depth + 1, seen);
  return out;
}

function serialise(value: unknown): unknown {
  return scrub(value, 0, new WeakSet());
}

/**
 * The threshold, resolved at most once per distinct `ZENITH_LOG_LEVEL`.
 *
 * `env()` re-fingerprints every variable it knows about on each call, which is
 * real work to repeat per log line. The raw variable is the only input to this
 * answer, so reading it directly is the cheap way to know whether the
 * validated one still applies. A test that reassigns it is still seen.
 */
let threshold: { raw: string | undefined; min: LogLevel } | undefined;

function minLevel(): LogLevel {
  const raw = process.env.ZENITH_LOG_LEVEL;
  if (threshold && threshold.raw === raw) return threshold.min;
  let min: LogLevel = "info";
  try {
    min = env().ZENITH_LOG_LEVEL;
  } catch {
    // A broken environment must not silence the logging that would explain it.
  }
  threshold = { raw, min };
  return min;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (RANK[level] < RANK[minLevel()]) return;

  const record: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    msg: scrubString(message),
  };
  const requestId = currentRequestId();
  if (requestId) record.requestId = requestId;
  // PROD-OPS-02: joins a log line to its trace and, through the span attributes, to tenant and operation.
  const traceId = currentTraceId();
  if (traceId) record.traceId = traceId;
  // Object.keys, not Object.entries: the same own enumerable keys, without a
  // two-element array allocated per field on a path this hot.
  if (fields) for (const k of Object.keys(fields)) record[k] = serialise(fields[k]);

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // A circular field must not take the process down.
    line = JSON.stringify({ level, ts: record.ts, msg: record.msg, fieldsError: "not serialisable" });
  }

  // Warnings and errors go to stderr so they survive a stdout-only pipeline.
  if (level === "warn" || level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
