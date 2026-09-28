import { ApiError, errorResponse, json } from "@/lib/server/errors";

export class WaitlistPreviewExpiredError extends ApiError {
  readonly code = "preview_expired";
  constructor() {
    super("This approval preview expired. Review a new preview before approving.", 409);
  }
}

/** Keep the preview-expiry distinction without changing the shared API format. */
export function waitlistErrorResponse(error: unknown): Response {
  if (error instanceof WaitlistPreviewExpiredError)
    return json({ error: { message: error.message, code: error.code } }, error.status);
  return errorResponse(error);
}
