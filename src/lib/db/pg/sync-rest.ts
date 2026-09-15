/**
 * One blocking PostgREST call, for the two Phase-3 groups whose callers are
 * synchronous by contract.
 *
 * ## Why this exists
 *
 * `Store` is a synchronous interface and so is `src/lib/secrets` — see the
 * "sync now, async later" note in `../types.ts`. `postgres-store.ts` answers
 * that for the *organisational* slice by loading a snapshot before the handler
 * runs: one prefetch, then every `db()` reads memory. The audit log and the
 * secret store cannot be prefetched the same way, and for the same reason in
 * both cases — **the query depends on arguments the prefetch never sees**. An
 * audit page is `(filter, cursor, limit)` off the request's query string; a
 * secret read is one `(workspaceId, ref)` chosen deep inside an action. Loading
 * "enough of it" up front would mean loading the whole log, per request, to
 * throw away all but fifty rows — and `countAudit`'s `exact: true` would become
 * a guess.
 *
 * So the round trip happens where the caller stands, and this module makes a
 * round trip survivable from a synchronous frame: the fetch runs on a worker
 * thread, and the calling thread parks on `Atomics.wait` until the worker says
 * it is done. This is the same mechanism `hosted/authority/tx.ts` uses to sleep
 * — `Atomics.wait` parks a thread rather than spinning a core — and Node
 * permits it on the main thread, unlike a browser.
 *
 * ## What it costs, and why that is acceptable here
 *
 * It blocks the event loop for the duration of the query. That is the honest
 * price of a synchronous store interface over a network database, and it is
 * bounded: one worker per process (started on first use, ~100 ms; ~20 ms per
 * call after that), a hard timeout, and only these two groups use it. A request
 * that is blocked here has nothing else to do — its own handler is what is
 * waiting.
 *
 * TODO(ceiling): the real fix is widening `Store`'s audit readers and the
 * secret accessors to promises, which is a change to `../types.ts` and every
 * call site. When that lands, this file is deleted rather than optimised.
 *
 * ## Why raw REST rather than `@supabase/supabase-js`
 *
 * The worker runs an inline script (`eval: true`) so nothing has to resolve a
 * file path through the Next bundler. `fetch` is in the Node runtime; a package
 * import is not reliably resolvable from an eval'd worker. The URL and the
 * service-role key are handed over once in `workerData` and never logged —
 * failures report status codes and PostgREST messages, never headers.
 */
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";
import { storeError } from "./registry";

/** One PostgREST call. `path` is everything after `/rest/v1/`. */
export interface RestRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** table plus query, e.g. `audit_events?select=*&order=seq.desc&limit=50` */
  path: string;
  /** the table name on its own, for the error message */
  table: string;
  /** what this call was trying to do, for the error message */
  op: string;
  /** JSON body for a write */
  body?: unknown;
  /** the `Prefer` header, e.g. `count=exact` or `resolution=merge-duplicates` */
  prefer?: string;
}

/** What came back. Rows are already parsed; `total` is PostgREST's exact count. */
export interface RestResult {
  rows: Record<string, unknown>[];
  /** from `Content-Range`, present only when the call asked for a count */
  total?: number;
}

/** Options for the non-blocking transport. Production uses the environment. */
export interface RestAsyncOptions {
  /** Override the configured Supabase URL (tests and alternate deployments). */
  baseUrl?: string;
  /** Override the configured API key (tests and alternate deployments). */
  apiKey?: string;
  /** Forward the caller's request identity when one is available. */
  authorization?: string;
  /** Abort this request, without affecting any other request. */
  signal?: AbortSignal;
  /** Test seam for an inert fetch implementation. */
  fetch?: typeof fetch;
  /** Per-call deadline, capped at the bridge's hard deadline. */
  timeoutMs?: number;
}

/** How long a single query may block the calling thread before it is a failure. */
const TIMEOUT_MS = 15_000;

/**
 * The worker's whole program. CommonJS, because an eval'd worker is evaluated
 * as CJS and `require("node:worker_threads")` is the only import it needs.
 *
 * The order at the end is load-bearing: post the reply to the port *first*, so
 * `receiveMessageOnPort` on the other side has something to collect, and only
 * then release the waiting thread.
 */
const WORKER = `
const { workerData } = require("node:worker_threads");
const { signal, port, url, key } = workerData;
port.on("message", (req) => {
  (async () => {
    let out;
    try {
      const headers = {
        apikey: key,
        authorization: "Bearer " + key,
        "content-type": "application/json",
        accept: "application/json",
      };
      if (req.prefer) headers.prefer = req.prefer;
      const res = await fetch(url + "/rest/v1/" + req.path, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      });
      out = {
        status: res.status,
        body: await res.text(),
        range: res.headers.get("content-range"),
      };
    } catch (err) {
      out = { status: 0, body: "", range: null, failure: String((err && err.message) || err) };
    }
    port.postMessage(out);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  })();
});
`;

interface Bridge {
  port: MessagePort;
  signal: Int32Array;
  worker: Worker;
}

type GBridge = typeof globalThis & { __zenithRestBridge?: Bridge };

/** The URL and service-role key, read live so a test can export them late. */
function config(): { url: string; key: string } {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key)
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when ZENITH_STORE=postgres. " +
        "Add them to .env.local (the service role key is server-only and must never ship to the browser), or set ZENITH_STORE=file."
    );
  return { url, key };
}

/**
 * One worker per process, started on first use. `unref()` on both ends so a
 * script that finished its work still exits; the worker is only alive for as
 * long as something holds the process open anyway.
 */
function bridge(): Bridge {
  const g = globalThis as GBridge;
  if (g.__zenithRestBridge) return g.__zenithRestBridge;
  const { url, key } = config();
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(WORKER, {
    eval: true,
    workerData: { signal, port: port2, url, key },
    transferList: [port2],
  });
  worker.unref();
  port1.unref();
  return (g.__zenithRestBridge = { port: port1, signal, worker });
}

/** Drop the worker (tests, and anything that wants the process to wind down). */
export function closeRestBridge(): void {
  const g = globalThis as GBridge;
  const open = g.__zenithRestBridge;
  if (!open) return;
  delete g.__zenithRestBridge;
  open.port.close();
  void open.worker.terminate();
}

interface WorkerReply {
  status: number;
  body: string;
  range: string | null;
  failure?: string;
}

/** `0-24/1337` → 1337. A star total, or no header at all, means no count was asked for. */
function countFrom(range: string | null): number | undefined {
  const total = range?.split("/")[1];
  if (total === undefined || total === "*") return undefined;
  const n = Number(total);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Run one query and return its rows, blocking until the worker answers.
 *
 * Throws the same `storeError` shape every other Postgres failure wears, so a
 * misapplied migration reads the same here as it does in the snapshot loader.
 */
export function restSync(req: RestRequest): RestResult {
  const { port, signal } = bridge();
  Atomics.store(signal, 0, 0);
  port.postMessage({ method: req.method, path: req.path, body: req.body, prefer: req.prefer });

  // `not-equal` means the worker finished before this thread got here, which is
  // a success, not a miss. Only `timed-out` is a failure.
  if (Atomics.wait(signal, 0, 0, TIMEOUT_MS) === "timed-out")
    throw storeError(
      req.table,
      req.op,
      `the database did not answer within ${TIMEOUT_MS} ms`
    );

  // The reply is posted before the signal is released, so it is normally here
  // already; the retry covers the window where the two threads interleave.
  let reply: WorkerReply | undefined;
  for (let attempt = 0; attempt < 100 && !reply; attempt++) {
    reply = receiveMessageOnPort(port)?.message as WorkerReply | undefined;
    if (!reply) Atomics.wait(signal, 0, 1, 10);
  }
  if (!reply) throw storeError(req.table, req.op, "the database worker answered with nothing");
  if (reply.failure) throw storeError(req.table, req.op, reply.failure);

  if (reply.status < 200 || reply.status >= 300) {
    let message = `HTTP ${reply.status}`;
    try {
      const parsed = JSON.parse(reply.body) as { message?: string; hint?: string };
      if (parsed.message) message = `${parsed.message}${parsed.hint ? ` (${parsed.hint})` : ""}`;
    } catch {
      if (reply.body) message = `${message}: ${reply.body.slice(0, 200)}`;
    }
    throw storeError(req.table, req.op, message);
  }

  let rows: Record<string, unknown>[] = [];
  if (reply.body.trim()) {
    try {
      const parsed = JSON.parse(reply.body) as unknown;
      rows = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [parsed as Record<string, unknown>];
    } catch {
      throw storeError(req.table, req.op, "the database returned a body that is not JSON");
    }
  }
  return { rows, total: countFrom(reply.range) };
}

/**
 * Run one PostgREST query without parking the Node thread.
 *
 * This is deliberately separate from `restSync`: callers must await it, and
 * each request owns its controller and deadline. Caller cancellation is
 * allowed through unchanged so route handlers can distinguish it from a DB
 * failure.
 */
export async function restAsync(
  req: RestRequest,
  options: RestAsyncOptions = {}
): Promise<RestResult> {
  const configured =
    options.baseUrl === undefined || options.apiKey === undefined ? config() : undefined;
  const baseUrl = (options.baseUrl ?? configured?.url ?? "").replace(/\/+$/, "");
  const apiKey = options.apiKey ?? configured?.key ?? "";
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw storeError(req.table, req.op, "fetch is not available in this runtime");

  const requestedTimeout = options.timeoutMs ?? TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(TIMEOUT_MS, Math.max(1, Math.floor(requestedTimeout)))
    : TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const headers: Record<string, string> = {
      apikey: apiKey,
      authorization: options.authorization ?? `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    };
    if (req.prefer) headers.prefer = req.prefer;
    const response = await fetchImpl(`${baseUrl}/rest/v1/${req.path}`, {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
    });
    if (timedOut) throw new Error("async database request timed out");
    const body = await response.text();
    if (timedOut) throw new Error("async database request timed out");
    if (response.status < 200 || response.status >= 300) {
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(body) as { message?: string; hint?: string };
        if (parsed.message) message = `${parsed.message}${parsed.hint ? ` (${parsed.hint})` : ""}`;
      } catch {
        if (body) message = `${message}: ${body.slice(0, 200)}`;
      }
      throw storeError(req.table, req.op, message);
    }

    let rows: Record<string, unknown>[] = [];
    if (body.trim()) {
      try {
        const parsed = JSON.parse(body) as unknown;
        rows = Array.isArray(parsed)
          ? (parsed as Record<string, unknown>[])
          : [parsed as Record<string, unknown>];
      } catch {
        throw storeError(req.table, req.op, "the database returned a body that is not JSON");
      }
    }
    return { rows, total: countFrom(response.headers.get("content-range")) };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (timedOut)
      throw storeError(req.table, req.op, `the database did not answer within ${timeoutMs} ms`);
    if (error instanceof Error && error.message.startsWith("Postgres store could not ")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw storeError(req.table, req.op, message);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

/* ------------------------------ query building ----------------------------- */

/** One `column=op.value` filter, percent-encoded. */
export const eq = (column: string, value: string): string =>
  `${column}=eq.${encodeURIComponent(value)}`;

/**
 * `column=in.("a","b")`. Each value is double-quoted so a comma or a parenthesis
 * inside an id cannot forge a list boundary; an embedded quote is doubled.
 */
export const inList = (column: string, values: readonly string[]): string =>
  `${column}=in.(${values.map((v) => encodeURIComponent(`"${v.replace(/"/g, '""')}"`)).join(",")})`;
