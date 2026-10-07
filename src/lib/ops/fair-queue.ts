/**
 * Weighted-fair dequeue across tenants (PROD-OPS-02).
 *
 * `WeightedFairQueue` is stride scheduling: each backlogged tenant has a
 * virtual "pass"; the next item comes from the backlogged tenant with the
 * smallest pass, and serving a tenant advances its pass by `1 / weight`. A
 * tenant with weight 2 therefore gets twice the contested service of a tenant
 * with weight 1, and a tenant cannot bank credit while idle: when it becomes
 * backlogged again its pass starts at the queue's current virtual time.
 *
 * The queue is hard-bounded twice (per tenant and in total). `push` returns
 * false when full; the caller turns that into a 429/503. There is no unbounded
 * buffer anywhere in this file.
 *
 * `FairSemaphore` uses the queue to hand out a fixed number of execution
 * permits. Waiting is bounded in count AND time: after `maxWaitMs` the waiter
 * is released as "bypassed" instead of failing. That choice is deliberate for
 * the Temporal worker: an activity that has not started has done nothing, but
 * failing it would make the workflow classify a mutating step as `uncertain`
 * (definitions/policies.ts), so fairness may delay work but never fail it.
 *
 * Leaf module (no imports) apart from the error vocabulary.
 */
import { BackpressureError } from "./errors";

interface Lane<T> { items: T[]; weight: number; pass: number; seq: number }

export interface FairQueueOptions {
  maxPerTenant: number;
  maxTotal: number;
}

export class WeightedFairQueue<T> {
  private readonly lanes = new Map<string, Lane<T>>();
  private vtime = 0;
  private total = 0;
  private arrivals = 0;
  constructor(private readonly opts: FairQueueOptions) {
    if (!Number.isInteger(opts.maxPerTenant) || opts.maxPerTenant < 1 || !Number.isInteger(opts.maxTotal) || opts.maxTotal < 1)
      throw new RangeError("queue bounds must be positive integers");
  }

  get size(): number { return this.total; }
  depthOf(tenant: string): number { return this.lanes.get(tenant)?.items.length ?? 0; }
  get tenantCount(): number { return this.lanes.size; }

  /** Enqueue; false when the tenant's lane or the whole queue is full. */
  push(tenant: string, item: T, weight = 1): boolean {
    if (this.total >= this.opts.maxTotal) return false;
    let lane = this.lanes.get(tenant);
    if (!lane) {
      lane = { items: [], weight: sanitizeWeight(weight), pass: this.vtime, seq: this.arrivals++ };
      this.lanes.set(tenant, lane);
    } else {
      lane.weight = sanitizeWeight(weight);
    }
    if (lane.items.length >= this.opts.maxPerTenant) {
      if (lane.items.length === 0) this.lanes.delete(tenant);
      return false;
    }
    if (lane.items.length === 0) {
      lane.pass = Math.max(lane.pass, this.vtime);
      lane.seq = this.arrivals++;
    }
    lane.items.push(item);
    this.total++;
    return true;
  }

  /** The next item by weighted-fair order, or undefined when empty. */
  shift(): { tenant: string; item: T } | undefined {
    let best: [string, Lane<T>] | undefined;
    for (const entry of this.lanes) {
      if (entry[1].items.length === 0) continue;
      if (!best || entry[1].pass < best[1].pass || (entry[1].pass === best[1].pass && entry[1].seq < best[1].seq)) best = entry;
    }
    if (!best) return undefined;
    const [tenant, lane] = best;
    const item = lane.items.shift() as T;
    this.total--;
    this.vtime = lane.pass;
    lane.pass += 1 / lane.weight;
    if (lane.items.length === 0) this.lanes.delete(tenant);
    return { tenant, item };
  }

  /** Remove a specific queued item (cancellation, timeout). */
  remove(tenant: string, item: T): boolean {
    const lane = this.lanes.get(tenant);
    if (!lane) return false;
    const index = lane.items.indexOf(item);
    if (index < 0) return false;
    lane.items.splice(index, 1);
    this.total--;
    if (lane.items.length === 0) this.lanes.delete(tenant);
    return true;
  }
}

const sanitizeWeight = (w: number): number => (Number.isFinite(w) && w > 0 ? Math.min(w, 1000) : 1);

/* ------------------------------- semaphore ------------------------------- */

export interface Permit {
  /** true when the wait budget ran out and the work proceeds without holding a permit */
  bypassed: boolean;
  waitedMs: number;
  release(): void;
}

export interface AcquireOptions {
  weight?: number;
  /** after this long the waiter proceeds as `bypassed`; default 15 s */
  maxWaitMs?: number;
  signal?: AbortSignal;
}

interface Waiter {
  resolve: (p: Permit) => void;
  reject: (e: unknown) => void;
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export interface FairSemaphoreOptions extends FairQueueOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export class FairSemaphore {
  private held = 0;
  private bypassedInFlight = 0;
  private readonly waiting: WeightedFairQueue<Waiter>;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<FairSemaphoreOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<FairSemaphoreOptions["clearTimer"]>;
  constructor(readonly capacity: number, opts: FairSemaphoreOptions) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
    this.waiting = new WeightedFairQueue<Waiter>(opts);
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
  }

  get inFlight(): number { return this.held; }
  get waitingCount(): number { return this.waiting.size; }
  get bypassed(): number { return this.bypassedInFlight; }
  waitingFor(tenant: string): number { return this.waiting.depthOf(tenant); }

  acquire(tenant: string, options: AcquireOptions = {}): Promise<Permit> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error("aborted"));
    const startedAt = this.now();
    if (this.held < this.capacity && this.waiting.size === 0) {
      this.held++;
      return Promise.resolve(this.permit(0, false));
    }
    return new Promise<Permit>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, startedAt, signal: options.signal };
      if (!this.waiting.push(tenant, waiter, options.weight ?? 1)) {
        reject(new BackpressureError("queue_full", "worker", "The worker's fair queue is full for this tenant.", 5, tenant));
        return;
      }
      const maxWait = Math.max(0, options.maxWaitMs ?? 15_000);
      waiter.timer = this.setTimer(() => {
        if (!this.waiting.remove(tenant, waiter)) return;
        this.detach(waiter);
        this.bypassedInFlight++;
        let done = false;
        resolve({ bypassed: true, waitedMs: this.now() - startedAt, release: () => { if (!done) { done = true; this.bypassedInFlight--; } } });
      }, maxWait);
      if (options.signal) {
        waiter.onAbort = () => {
          if (!this.waiting.remove(tenant, waiter)) return;
          this.detach(waiter);
          reject(options.signal?.reason ?? new Error("aborted"));
        };
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  private detach(waiter: Waiter): void {
    if (waiter.timer !== undefined) this.clearTimer(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  private permit(waitedMs: number, bypassed: boolean): Permit {
    let released = false;
    return {
      bypassed,
      waitedMs,
      release: () => {
        if (released) return;
        released = true;
        this.held--;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.held < this.capacity) {
      const next = this.waiting.shift();
      if (!next) return;
      this.detach(next.item);
      this.held++;
      next.item.resolve(this.permit(this.now() - next.item.startedAt, false));
    }
  }
}
