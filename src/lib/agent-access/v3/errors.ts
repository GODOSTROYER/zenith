/**
 * Refusals as MCP v3 returns them.
 *
 * Every failure a tool can have reaches the model as one shape,
 * `{ code, message, fix?, details?, retryable }`, with a fixed message. Three
 * properties matter:
 *
 *  - **One not-found.** A foreign workspace, project, environment, service or
 *    operation and a missing one are the SAME answer — the broker's own
 *    `notFound()` — whether the refusal came from the grant check in this
 *    module or from the broker. Nothing here distinguishes "exists but not
 *    yours" from "does not exist".
 *  - **No values.** Validation errors name field paths and issue codes, never
 *    the value that was sent. Unexpected errors are logged with a request id
 *    and answered without detail.
 *  - **Broker codes pass through.** `policy_denied`, `digest_mismatch`,
 *    `operation_expired` and the rest are the broker's own stable codes.
 */
import { randomUUID } from "node:crypto";
import { BrokerError, isBrokerError, notFound } from "@/lib/capabilities/errors";
import { log } from "@/lib/log";
import { scrubMcpValue } from "./redaction";

export { notFound };

/** A refusal raised by the v3 tool layer itself (scope, execution availability, unsupported operation). */
export class McpToolError extends Error {
  readonly name = "McpToolError";
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly fix?: string,
    readonly details?: Record<string, unknown>,
    readonly retryable = false
  ) {
    super(message);
  }
}

/** The refusal for a request the client explicitly cancelled before it changed anything. */
export function requestCancelled(detail = "The client cancelled this request."): McpToolError {
  return new McpToolError("request_cancelled", detail, 499, "Nothing further was done for this request. Start it again, with the same idempotency key, if it is still wanted.");
}

export interface ErrorBody {
  code: string;
  message: string;
  fix?: string;
  details?: Record<string, unknown>;
  /** true only when repeating the SAME call is safe and may succeed */
  retryable: boolean;
  requestId?: string;
}

export interface MappedError {
  status: number;
  body: ErrorBody;
}

interface CodedError {
  code: string;
  message: string;
  status: number;
}

/** `ControlError` (v2) and `AgentError` carry code, message and an HTTP status; matched by shape so this module imports neither. */
function isCoded(error: unknown): error is CodedError {
  if (typeof error !== "object" || error === null) return false;
  const e = error as Partial<CodedError>;
  return typeof e.code === "string" && typeof e.message === "string" && typeof e.status === "number";
}

const safeKey = (key: unknown): string => String(key).replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 60);

interface IssueLike {
  path?: readonly (string | number | symbol)[];
  code?: string;
  keys?: readonly unknown[];
}

function isZodLike(error: unknown): error is { issues: IssueLike[] } {
  return typeof error === "object" && error !== null && Array.isArray((error as { issues?: unknown }).issues) && (error as { name?: unknown }).name === "ZodError";
}

/** Field paths and issue codes only. The value that failed is never echoed. */
export function describeIssues(issues: readonly IssueLike[]): string {
  const parts = issues.slice(0, 8).map((issue) => {
    const path = (issue.path ?? []).map(safeKey).join(".") || "(input)";
    if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys)) return `${path}: unrecognized_keys [${issue.keys.slice(0, 5).map(safeKey).join(", ")}]`;
    return `${path}: ${safeKey(issue.code ?? "invalid")}`;
  });
  return parts.join(", ") + (issues.length > 8 ? `, and ${issues.length - 8} more` : "");
}

export function mapError(error: unknown, requestId: string = randomUUID().slice(0, 8)): MappedError {
  if (isBrokerError(error)) {
    // A store outage or a signer problem may succeed on a repeat; a refusal never will.
    const retryable = error.code === "platform_store_unavailable" || error.code === "signer_unavailable" || error.code === "already_claimed";
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        ...(error.fix ? { fix: error.fix } : {}),
        ...(error.details ? { details: error.details } : {}),
        retryable,
      },
    };
  }
  if (error instanceof McpToolError) {
    return {
      status: error.status,
      body: { code: error.code, message: error.message, ...(error.fix ? { fix: error.fix } : {}), ...(error.details ? { details: error.details } : {}), retryable: error.retryable },
    };
  }
  if (isZodLike(error)) {
    return {
      status: 400,
      body: {
        code: "invalid_input",
        message: `The tool input is invalid (${describeIssues(error.issues)}).`,
        fix: "Send exactly the fields in the tool's input schema. Unknown fields are refused, including any approval field: approval is a person's action in the browser.",
        retryable: false,
      },
    };
  }
  if (isCoded(error)) {
    return { status: error.status, body: { code: error.code, message: error.message.slice(0, 600), retryable: error.status >= 500 } };
  }
  const diagnostic = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { type: typeof error };
  log.error("mcp v3 request failed", { scope: "agent", requestId, error: scrubMcpValue(diagnostic) });
  return {
    status: 500,
    body: { code: "internal", message: "The request failed. Nothing is shown here; the server log has the detail.", retryable: false, requestId },
  };
}

/** The refusal for a tool the credential lacks the scope for; depends only on the credential, so it reveals nothing about any tenant. */
export function scopeDenied(tool: string, scope: string): McpToolError {
  return new McpToolError(
    "insufficient_scope",
    `${tool} needs the ${scope} scope, which this connection does not have.`,
    403,
    "Ask the account owner to link the agent again with that scope."
  );
}

export { BrokerError };
