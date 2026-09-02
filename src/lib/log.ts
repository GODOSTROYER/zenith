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
import { env } from "@/lib/env";

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

function serialise(value: unknown): unknown {
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  let min: LogLevel = "info";
  try {
    min = env().ORRERY_LOG_LEVEL;
  } catch {
    // A broken environment must not silence the logging that would explain it.
  }
  if (RANK[level] < RANK[min]) return;

  const record: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    msg: message,
  };
  const requestId = currentRequestId();
  if (requestId) record.requestId = requestId;
  for (const [k, v] of Object.entries(fields ?? {})) record[k] = serialise(v);

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // A circular field must not take the process down.
    line = JSON.stringify({ level, ts: record.ts, msg: message, fieldsError: "not serialisable" });
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
