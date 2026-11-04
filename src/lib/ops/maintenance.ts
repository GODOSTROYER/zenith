/**
 * Maintenance mode (PROD-OPS-02): an operator-controlled brake on the control plane.
 *
 *   off              normal.
 *   dispatch_paused  no NEW work starts (workflow starts and runner-job enqueue are refused with
 *                    503 + Retry-After); the API stays writable; in-flight work finishes.
 *   read_only        dispatch paused AND every mutating API call is refused, except the paths
 *                    below that must keep working for a safe drain.
 *
 * "Drain" is not a third mode: it is what an operator observes while a mode other than `off` is
 * set. `GET /api/admin/ops/maintenance` reports `drainStatus` (queued/running operations and
 * runner jobs); `drained: true` means nothing is in flight and workers or the store can stop.
 *
 * What keeps working in read_only, and why (each is asserted in tests/ops/maintenance.test.ts):
 *   - safe methods (GET/HEAD/OPTIONS);
 *   - runner and machine poll/heartbeat/result/log endpoints (signed): in-flight jobs must settle;
 *   - /api/internal/tick/* (cron-secret authenticated): the reaper and reconcile passes drain work;
 *   - /api/admin/ops/*: the operator must be able to turn maintenance off;
 *   - hosted data plane: /hosted-gateway/* (never under /api) and the two hosted admission endpoints;
 *   - MCP JSON-RPC endpoints are POST transports for reads too, so they are not method-gated;
 *     what they could START is stopped by the dispatch pause, and approvals are browser-only POSTs.
 *
 * The state is read through `MaintenanceCache`: bounded staleness, one refresh in flight, a short
 * timeout, and the last known state on failure. An unreachable store therefore never turns into a
 * request-path outage, and never silently clears a maintenance window that was already seen.
 *
 * Leaf module: no node imports; the edge middleware uses `exemptFromReadOnly` with the env override.
 */
import { BackpressureError } from "./errors";

export const MAINTENANCE_MODES = ["off", "dispatch_paused", "read_only"] as const;
export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number];

export interface MaintenanceState {
  mode: MaintenanceMode;
  reason: string;
  /** 0 when no row exists */
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  source: "database" | "environment" | "default";
}

export const MAINTENANCE_RETRY_AFTER_SEC = 30;

const RANK: Record<MaintenanceMode, number> = { off: 0, dispatch_paused: 1, read_only: 2 };

/** The stricter of the stored state and the host-level environment override. */
export function effectiveMaintenance(stored: MaintenanceState, override?: { mode: "dispatch_paused" | "read_only"; reason: string }): MaintenanceState {
  if (override && RANK[override.mode] >= RANK[stored.mode]) {
    return { mode: override.mode, reason: override.reason, version: stored.version, source: "environment" };
  }
  return stored;
}

const SEGMENT = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9_.:-]{1,128}`;
const COLLECTION = "(?:runners|machines)";
/**
 * Control lanes: paths that must stay reachable under overload and maintenance because draining and
 * recovery depend on them. They bypass the rate limiter and the in-flight caps (they are still
 * measured), so a flood of tenant traffic can never starve a runner settling a job, the reaper tick,
 * the operator turning maintenance off, or the hosted data plane.
 */
const CONTROL_LANES: readonly RegExp[] = [
  new RegExp(`^/api/platform/v1/${COLLECTION}/${SEGMENT}/(?:poll|heartbeat)$`),
  new RegExp(`^/api/platform/v1/${COLLECTION}/${SEGMENT}/jobs/${SEGMENT}/(?:result|logs)$`),
  /^\/api\/internal\/tick\//,
  /^\/api\/admin\/ops(?:\/|$)/,
  /^\/api\/hosted\/policy\/admit$/,
  /^\/api\/hosted\/session\/terminate$/,
  /^\/hosted-gateway(?:\/|$)/,
];
/** MCP is a POST transport for reads as well, so it is limited but not method-gated. */
const READ_ONLY_EXEMPT: readonly RegExp[] = [...CONTROL_LANES, /^\/api\/agent\/v[23]\/mcp$/];

export const isControlLane = (pathname: string): boolean => CONTROL_LANES.some((re) => re.test(pathname));

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for requests that read-only maintenance must still serve. */
export function exemptFromReadOnly(pathname: string, method: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  return READ_ONLY_EXEMPT.some((re) => re.test(pathname));
}

/** Throws the 503 for a mutating API call during read-only maintenance. */
export function assertApiWritable(state: MaintenanceState, pathname: string, method: string): void {
  if (state.mode !== "read_only" || exemptFromReadOnly(pathname, method)) return;
  throw new BackpressureError("maintenance_read_only", "maintenance",
    `Zenith is in read-only maintenance${state.reason ? `: ${state.reason}` : "."} Reads still work; nothing was changed.`, MAINTENANCE_RETRY_AFTER_SEC);
}

/** Throws the 503 for new dispatch (workflow start, runner job enqueue) during any maintenance mode. */
export function assertDispatchAllowed(state: MaintenanceState, tenant?: string): void {
  if (state.mode === "off") return;
  throw new BackpressureError("maintenance_dispatch_paused", "maintenance",
    `New work is paused for maintenance${state.reason ? `: ${state.reason}` : "."} The operation was not claimed; retry after maintenance ends.`, MAINTENANCE_RETRY_AFTER_SEC, tenant);
}

/* --------------------------------- cache ---------------------------------- */

export interface MaintenanceCacheOptions {
  ttlMs: number;
  /** a slow store must not stall requests; the last known state is used instead */
  timeoutMs?: number;
  now?: () => number;
}

export class MaintenanceCache {
  private value: MaintenanceState = { mode: "off", reason: "", version: 0, source: "default" };
  private at = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | undefined;
  /** how many consecutive refreshes failed; 0 when the last one succeeded */
  failures = 0;
  private readonly now: () => number;
  constructor(private readonly load: () => Promise<MaintenanceState>, private readonly opts: MaintenanceCacheOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** The last known state without any I/O. */
  peek(): MaintenanceState { return this.value; }

  invalidate(): void { this.at = Number.NEGATIVE_INFINITY; }

  /** Set the cached value directly (the operator route just wrote it). */
  prime(state: MaintenanceState): void {
    this.value = state;
    this.at = this.now();
    this.failures = 0;
  }

  async get(): Promise<MaintenanceState> {
    if (this.now() - this.at < this.opts.ttlMs) return this.value;
    this.inflight ??= this.refresh().finally(() => { this.inflight = undefined; });
    const timeoutMs = this.opts.timeoutMs ?? 1500;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.inflight, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
    if (timer) clearTimeout(timer);
    return this.value;
  }

  private async refresh(): Promise<void> {
    try {
      this.value = await this.load();
      this.failures = 0;
    } catch {
      this.failures++;
    }
    // Failures are retried after one TTL as well: a down store is not hammered per request.
    this.at = this.now();
  }
}
