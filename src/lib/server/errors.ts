/**
 * The JSON conventions every /api route answers with.
 *
 * One error body — `{ error: { message, fix? } }` — and one place that decides
 * what a thrown thing becomes on the wire. Split out of `server/context.ts`;
 * that module re-exports everything here, so no import path changed.
 */
import { NextResponse } from "next/server";
import { log, currentRequestId } from "@/lib/log";

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

export function errorResponse(err: unknown): NextResponse {
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
