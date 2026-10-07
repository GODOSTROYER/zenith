/**
 * The JSON conventions every /api route answers with.
 *
 * One error body — `{ error: { message, fix? } }` — and one place that decides
 * what a thrown thing becomes on the wire. Split out of `server/context.ts`;
 * that module re-exports everything here, so no import path changed.
 */
import { NextResponse } from "next/server";
import { log, currentRequestId } from "@/lib/log";
import { redactCredentials } from "@/lib/credentials/redact";
import { redactOutput } from "@/lib/tofu/redact";
import { backpressureBody, isBackpressureError } from "@/lib/ops/errors";

/** Every error body is `{ error: { message, fix? } }` — errors name their fix. */
export class ApiError extends Error {
  readonly status: number;
  readonly fix?: string;
  constructor(message: string, status = 400, opts: { fix?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fix = opts.fix;
  }
}

export const notFound = (what: string, fix: string) => new ApiError(`${what} was not found.`, 404, { fix });

export const json = (data: unknown, status = 200): NextResponse =>
  NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });

/**
 * Copy only bounded, redacted diagnostics; never serialize arbitrary thrown
 * objects, causes or custom toJSON methods. The original error is untouched.
 * `errorResponse` applies it to every error it answers or logs (SEC-R2), so
 * direct callers and `route()` share one boundary.
 */
export function safeRequestError(error: unknown): unknown {
  const text = (value: string, max: number) => {
    const redacted = redactOutput(redactCredentials(value));
    return redacted.length > max ? `${redacted.slice(0, max)} [truncated]` : redacted;
  };
  try {
    if (error instanceof ApiError) {
      return new ApiError(text(error.message, 2048), error.status, {
        ...(error.fix ? { fix: text(error.fix, 2048) } : {}),
      });
    }
    if (!(error instanceof Error)) return { name: "NonErrorThrown", message: "A non-Error value was thrown." };
    return { name: text(error.name, 128), message: text(error.message, 2048), stack: error.stack ? text(error.stack, 8192) : undefined };
  } catch {
    return { name: "UnreadableError", message: "Error diagnostics could not be read." };
  }
}

export function errorResponse(raw: unknown): NextResponse {
  // PROD-OPS-02: load shedding is an expected, explicit answer (429/503 + Retry-After), never a 500.
  if (isBackpressureError(raw)) return NextResponse.json(backpressureBody(raw), { status: raw.status, headers: { "cache-control": "no-store", "retry-after": String(raw.retryAfterSec) } });
  // Every error is cleaned here, whatever threw it: ApiError text is redacted for the
  // response, anything else is reduced to a redacted, bounded name/message/stack for the log.
  const err = safeRequestError(raw);
  const api = err instanceof ApiError ? err : undefined;
  if (api) return json({ error: { message: api.message, fix: api.fix } }, api.status);
  // Anything else is a bug or an environment failure, not something the
  // caller can act on from the raw message (a filesystem path, a parse
  // error). Keep the detail in the server log under the request id and give
  // the caller a fix that leads back to it.
  const requestId = currentRequestId() ?? "unknown";
  log.error("unhandled error in request", { scope: "api", requestId, error: err });
  return json(
    {
      error: {
        message: "Something went wrong on the server while handling this request.",
        fix: `Try again. If it keeps happening, quote request ${requestId} — the server log has the detail.`,
        requestId,
      },
    },
    500
  );
}
