/**
 * HTTP plumbing shared by every /api/platform/v1 route.
 *
 * Conventions (matching the rest of /api):
 *  - Success is the payload itself as JSON, `cache-control: no-store`.
 *  - Failure is `{ error: { code, message, fix?, details? } }` with the status
 *    the code maps to. `code` is additive to the product's `{ message, fix }`.
 *  - A foreign id, a missing id and a non-member are the SAME 404 body.
 *  - Bodies are size-capped and validated with zod; errors name field paths and
 *    issue codes, never values.
 *  - Nothing here returns a grant, a token, a credential or a secret: the
 *    services behind it never hold one in a response shape, and operation
 *    payloads are scrubbed on the way out.
 *
 * Errors that are not ours (`ApiError` from the workspace helpers, anything
 * unexpected) are rethrown so `route()` answers them exactly like every other
 * route: the product's own error body, and a generic 500 that leaks nothing.
 */
import type { NextRequest } from "next/server";
import type { ZodTypeAny, z } from "zod";
import { AgentError } from "@/lib/agent-access/security";
import { BrokerError, isBrokerError } from "@/lib/capabilities/errors";
import { json } from "@/lib/server/errors";
import { route } from "@/lib/server/request";

export const MAX_BODY_BYTES = 64 * 1024;

export interface Answer {
  status?: number;
  body: unknown;
}

export function errorBody(error: BrokerError): { error: { code: string; message: string; fix?: string; details?: Record<string, unknown> } } {
  return { error: { code: error.code, message: error.message, ...(error.fix ? { fix: error.fix } : {}), ...(error.details ? { details: error.details } : {}) } };
}

/** Read a JSON body with a hard size cap; an absent body is `{}`. */
export async function readJson(req: NextRequest, max = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) throw new BrokerError("invalid_request", `The request body is too large (max ${max / 1024} KiB).`);
  const text = await req.text();
  if (text.length > max) throw new BrokerError("invalid_request", `The request body is too large (max ${max / 1024} KiB).`);
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BrokerError("invalid_request", "The request body is not valid JSON.");
  }
}

/** Validate with zod; the error lists field paths and issue codes only. */
export function parseWith<S extends ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`);
    throw new BrokerError("invalid_request", `The request is invalid (${issues.join(", ")}).`);
  }
  return parsed.data as z.infer<S>;
}

function failure(error: unknown): Response | undefined {
  if (isBrokerError(error)) return json(errorBody(error), error.status);
  if (error instanceof AgentError) return json({ error: { code: error.code, message: error.message } }, error.status);
  return undefined;
}

/**
 * Wrap a handler in `route()` (auth, workspace resolution, store snapshot,
 * flush) and translate broker failures into the platform error body.
 */
export function platformRoute<P extends Record<string, string> = Record<string, string>>(fn: (req: NextRequest, params: P) => Promise<Answer>) {
  return route<P>(async (req, params) => {
    try {
      const out = await fn(req, params);
      return json(out.body, out.status ?? 200);
    } catch (error) {
      const response = failure(error);
      if (response) return response;
      throw error;
    }
  });
}
