/**
 * How the gateway refuses.
 *
 * One envelope for programs, one small page for people, the response guard on
 * both, and `no-store` always — a refusal that a shared cache could replay is
 * a refusal that outlives the reason for it.
 *
 * Nothing here reads app state or app code: `respondWithError` is reachable
 * from the very first line of the pipeline, before the host is even known.
 *
 * Workstream W6 (hosted R3).
 */
import { HostedError, hostedErrorBody, type HostedErrorBody } from "@/lib/hosted/contracts";
import { gatewayHtml, gatewayJson } from "./guard";

/** How to shape a refusal for the caller that hit it. */
export interface RespondWithErrorOptions {
  /** A browser navigation (GET + `Accept: text/html`) gets the page, not JSON. */
  wantsHtml: boolean;
  /** Extra gateway-set headers, e.g. `retry-after` on a quota refusal. */
  headers?: Record<string, string>;
  /** Stamped for attribution when the refusal happened while a release was known. */
  releaseId?: string;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The refusal page. Inline CSS only and no script at all, so it renders under
 * the gateway's own CSP without an exception being carved for it.
 */
export function errorPage(body: HostedErrorBody): string {
  const { code, message, fix } = body.error;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(code)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #f6f7f9; color: #14171f; padding: 24px; }
  main { max-width: 30rem; background: #fff; border: 1px solid #e3e6ec; border-radius: 12px; padding: 28px; }
  h1 { font-size: 1.15rem; margin: 0 0 12px; }
  p { margin: 0 0 10px; }
  .fix { color: #414855; }
  code { font: 0.85rem ui-monospace, SFMono-Regular, Menlo, monospace; color: #5a6172; }
  @media (prefers-color-scheme: dark) {
    body { background: #101319; color: #e8eaf0; }
    main { background: #171b23; border-color: #262b36; }
    .fix { color: #b6bcc9; }
    code { color: #98a0b0; }
  }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(message)}</h1>
  ${fix ? `<p class="fix">${escapeHtml(fix)}</p>` : ""}
  <p><code>${escapeHtml(code)}</code></p>
</main>
</body>
</html>
`;
}

/**
 * A refusal that needs a header of its own — `retry-after` on a daily quota,
 * `allow` on a wrong method. Thrown by the pipeline, unwrapped here, so the
 * header travels with the refusal instead of being re-derived from its code at
 * the catch site (where `quota_exceeded` from the storage limit and
 * `quota_exceeded` from the daily counter are indistinguishable).
 */
export class RefusalWithHeaders extends Error {
  readonly error: HostedError;
  readonly headers: Record<string, string>;

  constructor(error: HostedError, headers: Record<string, string>) {
    super(error.message);
    this.name = "RefusalWithHeaders";
    this.error = error;
    this.headers = headers;
  }
}

/**
 * Turn anything thrown into the response the caller gets. A `HostedError`
 * keeps its code, status, fix and details; anything else becomes a 500 with no
 * internal detail attached — `hostedErrorBody` is the one place that decides.
 */
export function respondWithError(err: unknown, opts: RespondWithErrorOptions): Response {
  const carried = err instanceof RefusalWithHeaders ? err : null;
  const { status, body } = hostedErrorBody(carried ? carried.error : err);
  const headers = { ...(carried?.headers ?? {}), ...(opts.headers ?? {}) };
  if (opts.wantsHtml)
    return gatewayHtml(errorPage(body), { status, headers, releaseId: opts.releaseId });
  return gatewayJson(body, { status, headers, releaseId: opts.releaseId });
}

/** The `HostedError` inside anything the pipeline threw, or null. */
export const hostedErrorOf = (err: unknown): HostedError | null =>
  err instanceof RefusalWithHeaders ? err.error : err instanceof HostedError ? err : null;

/** True when this request is a browser navigation rather than a program call. */
export function wantsHtml(req: Request): boolean {
  if (req.method !== "GET") return false;
  return (req.headers.get("accept") ?? "").toLowerCase().includes("text/html");
}

/** Seconds from `now` until the next UTC midnight — when the daily quota resets. */
export function secondsToNextUtcMidnight(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** The refusal a request for an app host nobody knows gets. Never says why. */
export const unknownHost = (): HostedError =>
  new HostedError("unknown_host", "There is no application at this address.", {
    fix: "Open the app from its Zenith page, which links to the address it is actually served on.",
  });

/**
 * A 405 with the `allow` header the contract requires.
 *
 * The hosted vocabulary has no `method_not_allowed` code — every refusal names
 * a fix, and "use one of these methods" is an input problem — so the envelope
 * carries `invalid_input` while the status stays 405, which is what a browser
 * and a cache need to see.
 */
export function methodNotAllowed(
  allow: readonly string[],
  opts: { wantsHtml: boolean; releaseId?: string; what?: string }
): Response {
  const list = [...allow].join(", ");
  const body: HostedErrorBody = {
    error: {
      code: "invalid_input",
      message: `${opts.what ?? "That path"} does not answer this method.`,
      fix: `Use one of: ${list}.`,
    },
  };
  const headers = { allow: list };
  if (opts.wantsHtml)
    return gatewayHtml(errorPage(body), { status: 405, headers, releaseId: opts.releaseId });
  return gatewayJson(body, { status: 405, headers, releaseId: opts.releaseId });
}
