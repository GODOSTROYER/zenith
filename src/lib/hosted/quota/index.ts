/**
 * Request quotas, body limits and the honest enforcement table.
 *
 * **What "requests per day" counts (decision R3-12).** Every request that
 * resolved to a *known* app — after the unknown-host 404, before anything else
 * — counts once, whatever its outcome. A denial counts. A 403 counts. A HEAD
 * counts. A request refused *by this quota* counts, and additionally
 * increments `denied`, because a caller hammering an app past its ceiling is
 * exactly the load the counter exists to describe. Requests to a host that
 * resolves to no app never reach here at all: they are not the app's traffic.
 *
 * **The day rolls at 00:00 UTC**, not in the viewer's timezone and not on a
 * rolling window. `utcDay()` is the boundary, the counter's primary key is
 * `(app_id, day)`, and nothing sweeps yesterday: an old row is history.
 *
 * **The count lives in SQLite, never in this process.** There are no
 * module-scope counters here. Two workers, a hot reload, a restart in the
 * middle of a burst — all of them read and move the same row, and the number a
 * caller is admitted or refused on is the number that committed. The decision
 * and the increment happen in one `BEGIN IMMEDIATE` transaction, so two
 * requests arriving at once cannot both see 9 999.
 *
 * **What this module does not do**: decide who the caller is, whether the app
 * is suspended, or whether the host is known. Admission order is the gateway's
 * (W6); this is one step in it.
 *
 * Workstream W8 (hosted R3).
 */
import {
  DEFAULT_LIMITS,
  HostedError,
  type LimitEnforcement,
  type QuotaCounter,
  type RuntimeId,
} from "@/lib/hosted/contracts";
import { authority, utcDay } from "@/lib/hosted/authority";

/** What `admitRequest` answers with: the decision, the committed counter, the ceiling used. */
export interface QuotaDecision {
  /** True when this request is inside the app's daily allowance. */
  allowed: boolean;
  /** The counter as it stands *after* this request was counted. */
  counter: QuotaCounter;
  /** The ceiling the decision was made against. */
  limit: number;
}

/**
 * True for the refusal SQLite raises when `quota_counters.app_id` names no
 * app. Matched on the message rather than on the extended result code, which
 * would mean importing a file inside the authority directory past its barrel.
 */
const isUnknownApp = (error: unknown): boolean =>
  error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message);

/**
 * Count one request against the app's UTC day and say whether it is admitted.
 *
 * Atomic: the read that decides and the write that records happen in one
 * transaction, so the `requests` value in the answer is this request's own
 * position in the day, and two concurrent callers get consecutive numbers
 * rather than the same one.
 *
 * The row is written before the answer is returned, which is the ordering that
 * makes over-counting possible and under-counting impossible. A request that
 * is refused for being over the ceiling is counted twice over — once as a
 * request, once as a denial — on purpose: `requests` is "attempts", `denied`
 * is "attempts we turned away", and `requests - denied` is what was served.
 */
export function admitRequest(
  appId: string,
  opts: { now?: Date; limit?: number } = {}
): QuotaDecision {
  const limit = opts.limit ?? DEFAULT_LIMITS.requestsPerDay;
  const day = utcDay(opts.now ?? new Date());
  const a = authority();
  try {
    const counter = a.tx(() => {
      const before = a.repos.quotas.get(appId, day);
      // The decision is made on the value this request is about to take, so
      // the request numbered exactly `limit` is the last one admitted.
      const denied = before.requests + 1 > limit;
      return a.repos.quotas.increment(appId, day, denied);
    });
    return { allowed: counter.requests <= limit, counter, limit };
  } catch (error) {
    if (isUnknownApp(error))
      throw new HostedError("not_found", `No hosted app has the id ${appId}, so its requests cannot be counted.`, {
        fix: "Count a request only after the host has been resolved to an app row; an unknown host is a 404 and is not this app's traffic.",
        details: { appId },
      });
    throw error;
  }
}

/** The refusal a caller over the daily ceiling gets. */
export function quotaExceeded(decision: QuotaDecision): HostedError {
  return new HostedError(
    "quota_exceeded",
    `This app has made ${decision.counter.requests} requests today and its daily allowance is ${decision.limit}. ` +
      "The allowance resets at 00:00 UTC; data, grants and releases are untouched.",
    {
      fix: "Wait for the reset at 00:00 UTC, or ask Zenith to raise this app's daily request allowance.",
      details: {
        requests: decision.counter.requests,
        denied: decision.counter.denied,
        limit: decision.limit,
        day: decision.counter.day,
        resetsAt: `${decision.counter.day}T24:00:00Z`,
      },
    }
  );
}

/* -------------------------------- body cap -------------------------------- */

/** Content types this reader accepts. Anything else is refused before a byte is read. */
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\b|^application\/json\b/i;

/**
 * Read and parse a JSON body of at most `maxBytes`, refusing anything larger.
 *
 * Two checks, because either one alone is a hole. `Content-Length` is checked
 * first so an oversized upload is refused before it is transferred; a body
 * with no `Content-Length` (chunked) is then read through a running counter
 * that stops at `maxBytes + 1` — one byte past the limit is all that is needed
 * to know it is over, and the rest is never buffered.
 *
 * Refusals: `body_too_large` (413) for either check, `invalid_input` (400) for
 * a content type that is not JSON, a body that is not valid JSON, or a stream
 * that failed mid-read.
 */
export async function readJsonBody(
  req: Request,
  maxBytes: number = DEFAULT_LIMITS.bodyBytes
): Promise<unknown> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!JSON_CONTENT_TYPE.test(contentType.trim()))
    throw new HostedError(
      "invalid_input",
      contentType.trim() === ""
        ? "This endpoint reads a JSON body and the request carried no content-type header."
        : `This endpoint reads a JSON body and the request declared content-type "${contentType}".`,
      { fix: 'Send the body as JSON with `content-type: application/json`.' }
    );

  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) throw bodyTooLarge(length, maxBytes);
  }

  const raw = await readCapped(req, maxBytes);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new HostedError("invalid_input", "The request body is not valid JSON.", {
      fix: "Send a JSON object. Check for a trailing comma, a missing quote or an empty body.",
      details: { detail: error instanceof Error ? error.message.slice(0, 200) : "unparseable" },
    });
  }
}

/** The bytes of a body, refusing one byte past `maxBytes`. Never buffers more than that. */
async function readCapped(req: Request, maxBytes: number): Promise<string> {
  const body = req.body;
  if (!body) {
    // No stream at all: `Request` built from a string still exposes one, so
    // this is a genuinely bodyless request. Fall back to text(), which is "".
    return req.text();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw bodyTooLarge(total, maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HostedError) throw error;
    throw new HostedError("invalid_input", "The request body could not be read to the end.", {
      fix: "Send the request again. If it keeps failing, the connection is dropping mid-upload.",
      details: { detail: error instanceof Error ? error.message.slice(0, 200) : "stream error" },
    });
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function bodyTooLarge(seen: number, maxBytes: number): HostedError {
  return new HostedError(
    "body_too_large",
    `This request body is ${seen > maxBytes ? `over ${maxBytes}` : String(seen)} bytes and the limit is ${maxBytes} bytes.`,
    {
      fix: `Send at most ${maxBytes} bytes per request — shorten the request's details field, or split the change into several requests.`,
      details: { limitBytes: maxBytes },
    }
  );
}

/* ------------------------------- enforcement ------------------------------ */

/**
 * Which limits the running runtime actually enforces, and which it only
 * displays.
 *
 * This table is what keeps the limits screen honest. On the local runtime the
 * CPU-millisecond and subrequest ceilings are Cloudflare's numbers and nothing
 * here measures them, so they are `not_enforced` — not "enforced" with a
 * footnote, and not hidden. On Cloudflare the platform enforces them, so they
 * are `provider`: real, but enforced by someone else, and reported as such.
 */
export function enforcementFor(runtime: RuntimeId): LimitEnforcement {
  const local: LimitEnforcement = {
    buildsPerApp: "enforced",
    buildsPilotWide: "enforced",
    buildTimeoutMs: "enforced",
    requestCpuMs: "not_enforced",
    outboundSubrequests: "not_enforced",
    bodyBytes: "enforced",
    requestsPerDay: "enforced",
    storageBytes: "enforced",
  };
  if (runtime === "local") return local;
  return { ...local, requestCpuMs: "provider", outboundSubrequests: "provider" };
}

/** One sentence per limit, for the screen that shows the table. */
export const ENFORCEMENT_LABELS: Record<LimitEnforcement[keyof LimitEnforcement], string> = {
  enforced: "Enforced here by Zenith, and tested.",
  provider: "Enforced by the provider (Cloudflare), not by Zenith.",
  not_enforced: "Not enforced by this runtime — shown because it applies on Cloudflare.",
};

/* --------------------------------- reading -------------------------------- */

/** The counters a usage screen shows for one app. */
export interface QuotaSummary {
  appId: string;
  /** The UTC day the summary was taken on. */
  today: string;
  /** Today's counter, zeroed when nothing has arrived yet. */
  current: QuotaCounter;
  /** The daily ceiling these counters are judged against. */
  limit: number;
  /** Counters for the window, newest day first. Days with no traffic are absent. */
  days: QuotaCounter[];
  /** How the number is produced, for the screen that displays it. */
  disclosure: string;
}

/** Counters for an app over the last `days` UTC days, today included. */
export function quotaSummary(
  appId: string,
  opts: { days?: number; now?: Date; limit?: number } = {}
): QuotaSummary {
  const span = Math.max(1, Math.min(365, Math.trunc(opts.days ?? 30)));
  const now = opts.now ?? new Date();
  const today = utcDay(now);
  const sinceDay = utcDay(new Date(now.getTime() - (span - 1) * 24 * 60 * 60_000));
  const a = authority();
  return {
    appId,
    today,
    current: a.repos.quotas.get(appId, today),
    limit: opts.limit ?? DEFAULT_LIMITS.requestsPerDay,
    days: a.repos.quotas.listByApp(appId, { sinceDay, limit: span }),
    disclosure:
      "Counted by Zenith on every request that resolved to this app, whatever the outcome, and reset at 00:00 UTC. It is not a provider's own metering.",
  };
}

/**
 * Tests only: forget an app's counters so a fixture can replay a day.
 *
 * With no `day` every counter for the app goes. Returns how many rows were
 * removed. Nothing in the product calls this — a quota that could be reset
 * from a request path is not a quota.
 */
export function resetDayForTests(appId: string, day?: string): number {
  const a = authority();
  return a.tx(() => {
    const statement =
      day === undefined
        ? a.db.prepare("DELETE FROM quota_counters WHERE app_id = ?")
        : a.db.prepare("DELETE FROM quota_counters WHERE app_id = ? AND day = ?");
    const result = day === undefined ? statement.run(appId) : statement.run(appId, day);
    return Number(result.changes);
  });
}

export { utcDay };
