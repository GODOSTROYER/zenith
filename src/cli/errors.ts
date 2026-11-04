/** Stable CLI exits; diagnostics never include request headers or raw causes. */
import { PlatformApiError, PlatformInvalidResponseError, PlatformNetworkError, PlatformTimeoutError } from "@/lib/sdk";

export class CliError extends Error {
  constructor(readonly exitCode: number, readonly code: string, message: string) { super(message); }
}

export function statusExit(status: number): number {
  if (status === 401 || status === 403) return 3;
  if (status === 404) return 4;
  if (status === 409 || status === 429) return 5;
  if (status >= 500) return 6;
  return status === 0 || status === 400 || status === 413 || status === 422 ? 2 : 6;
}

const guidance: Record<number, string> = {
  401: "Authentication failed. Link a credential in the browser and use login --token-stdin or ZENITH_TOKEN.",
  403: "Access refused. Review the credential's scopes and the workspace policy in the browser.",
  404: "The target was not found or is outside this credential's grant.",
  409: "The operation conflicts with current state. Review it before retrying.",
  429: "The server is rate limiting requests. Wait before retrying.",
};

export function diagnostic(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof PlatformApiError) return new CliError(statusExit(error.status), error.code,
    `${guidance[error.status] ?? (error.status >= 500 ? "The platform is unavailable." : "The request was refused.")} ${error.message}${error.fix ? ` ${error.fix}` : ""}`);
  if (error instanceof PlatformInvalidResponseError && error.status >= 400) {
    return new CliError(statusExit(error.status), error.code, `${guidance[error.status] ?? "The platform is unavailable."} ${error.message}`);
  }
  if (error instanceof PlatformTimeoutError || error instanceof PlatformNetworkError || error instanceof PlatformInvalidResponseError) {
    return new CliError(6, error.code, error.message);
  }
  return new CliError(1, "internal_error", "The CLI could not complete this request. Use --debug for a sanitized stack trace.");
}

export const interrupted = () => new CliError(130, "interrupted", "Interrupted. Check operation state before retrying a write.");
