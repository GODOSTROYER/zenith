/** Typed SDK failures. Network causes, request headers and response bodies are
 * never attached: they may contain credentials. API messages are sanitized by
 * the client before construction. */
export class PlatformApiError extends Error {
  readonly name = "PlatformApiError";
  constructor(readonly status: number, readonly code: string, message: string,
    readonly fix?: string, readonly details?: Record<string, unknown>) { super(message); }
  isNotFound(): boolean { return this.status === 404 || this.code === "not_found"; }
  toJSON(): Record<string, unknown> {
    return { name: this.name, status: this.status, code: this.code, message: this.message,
      ...(this.fix ? { fix: this.fix } : {}), ...(this.details ? { details: this.details } : {}) };
  }
}
export class PlatformNetworkError extends Error {
  readonly name = "PlatformNetworkError";
  readonly code = "network_error";
  constructor() { super("The platform request could not reach the server."); }
}
export class PlatformTimeoutError extends Error {
  readonly name = "PlatformTimeoutError";
  readonly code = "timeout";
  constructor() { super("The platform request timed out. Check the operation before retrying a write."); }
}
export class PlatformInvalidResponseError extends Error {
  readonly name = "PlatformInvalidResponseError";
  readonly code = "invalid_response";
  constructor(readonly status: number) { super("The platform server returned an invalid response."); }
}
