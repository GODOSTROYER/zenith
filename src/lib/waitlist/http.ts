import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { type NextRequest } from "next/server";
import { ApiError, json } from "@/lib/server/errors";
import { sessionUserFromRequest } from "@/lib/supabase/route";
import { isWaitlistOperator } from "./access";
import { waitlistConfig } from "./config";
import type { WaitlistRepository } from "./types";

export const WAITLIST_BODY_BYTES = 8192;

/** Cookie-authenticated mutations reject browser cross-origin submissions. */
export function sameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site"
    || (origin && origin !== request.nextUrl.origin))
    throw new ApiError("This request must come from the same site.", 403);
}

/** Enforce actual streamed bytes; Content-Length is only an early refusal. */
export async function readWaitlistJson(request: NextRequest): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    throw new ApiError("Send a JSON request.", 415);
  const length = request.headers.get("content-length");
  if (length && Number(length) > WAITLIST_BODY_BYTES)
    throw new ApiError("The request is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError("A JSON request body is required.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > WAITLIST_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError("The request is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
  catch { throw new ApiError("Send a valid JSON request.", 400); }
}

export async function requireWaitlistOperator(request: NextRequest) {
  const user = await sessionUserFromRequest(request);
  if (!user) throw new ApiError("Sign in to manage the waitlist.", 401);
  if (!isWaitlistOperator(user)) throw new ApiError("Waitlist operator access is required.", 403);
  return user;
}

/** Raw addresses never enter storage. Headers are trusted only by explicit opt-in. */
export function waitlistClientKey(request: NextRequest): string {
  const config = waitlistConfig();
  if (!config.rateLimitSecret) throw new ApiError("Waitlist intake is unavailable.", 503);
  const supplied = config.trustedIpHeader ? request.headers.get(config.trustedIpHeader)?.split(",")[0].trim() : undefined;
  const address = supplied && supplied.length <= 64 && isIP(supplied) ? supplied.toLowerCase() : "unknown";
  return createHmac("sha256", config.rateLimitSecret).update("waitlist-client:" + address).digest("hex");
}

export async function throttleWaitlist(request: NextRequest, repository: WaitlistRepository): Promise<Response | null> {
  // Count globally first to bound storage and work even when clients rotate IPs.
  const globallyAllowed = await repository.consumeRateLimit("waitlist-global", 1000, 3600);
  const locallyAllowed = globallyAllowed && await repository.consumeRateLimit(waitlistClientKey(request), 10, 3600);
  if (locallyAllowed) return null;
  const response = json({ error: { message: "Too many requests. Please try again later." } }, 429);
  response.headers.set("retry-after", "3600");
  return response;
}