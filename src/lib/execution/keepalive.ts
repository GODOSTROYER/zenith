/**
 * Keep a long activity alive and exclusive while it runs.
 *
 * Every long activity (plan, apply, build, rollout, migration, capability) runs
 * its body inside `withKeepAlive`, which does three things on an interval:
 *
 *   1. heartbeats (Temporal's heartbeat timeout is 60 s; cancellation is also
 *      delivered through the activity's cancellation signal, which is chained
 *      into the signal handed to the body);
 *   2. renews the environment lease, on the platform store's clock, and extends
 *      the operation's own execution lease in the ledger (a running operation
 *      whose execution lease lapses is marked `uncertain` by the reconciler);
 *   3. if a renewal reports the lease LOST — or the store has been unreachable
 *      for two thirds of the lease TTL, so it is about to lapse under us —
 *      aborts the body's signal with a `LeaseLostError`.
 *
 * Like the store's own `withLease`, a lost lease wins over everything: even if
 * the body returns normally or fails with some other error, `withKeepAlive`
 * throws `LeaseLostError`, because the work ran without exclusion for an unknown
 * interval and its outcome cannot be proven. The workflow finalizes that
 * `uncertain` when the step may have acted; it never retries.
 *
 * Aborting the body's signal is how a running `tofu apply` is stopped: the
 * runner interrupts the process tree. That is the lesser evil compared with
 * letting a second writer and a first one both change the environment.
 */
import type { Lease } from "@/lib/controlplane/types";
import type { LeaseRef } from "@/lib/workflows/types";
import { LeaseLostError } from "./errors";
import type { Runtime } from "./runtime";
import { errorText } from "./text";

export interface KeepAliveOptions {
  /** the lease to renew; omit for read-only activities that hold none */
  lease?: LeaseRef;
  /** what to report in each heartbeat */
  detail: string;
  /** the operation whose execution lease to extend; omit for work with no operation row (reconcile passes) */
  operation?: { workspaceId: string; operationId: string };
}

export async function withKeepAlive<T>(rt: Runtime, opts: KeepAliveOptions, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const outer = rt.d.activitySignal?.();
  const onOuterAbort = (): void => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }

  const { lease } = opts;
  const ttl = rt.limits.leaseTtlMs;
  let lost: LeaseLostError | undefined;
  let lastRenewed = performance.now();
  let busy = false;

  const fail = (why: string): void => {
    if (lost || !lease) return;
    lost = new LeaseLostError(lease.scope, lease.fenceToken);
    rt.log("error", "lease lost while an activity was running", { scope: lease.scope, fenceToken: lease.fenceToken, why });
    controller.abort(lost);
  };

  const tick = async (): Promise<void> => {
    if (busy || lost || controller.signal.aborted) return;
    busy = true;
    try {
      rt.heartbeat(opts.detail);
      if (!lease) return;
      let renewed: Lease | null;
      try {
        renewed = await rt.d.leases.renew(lease, ttl);
      } catch (err) {
        // The store is unreachable or erroring: keep trying, but stop before the lease can lapse.
        rt.log("warn", "lease renewal failed", { error: errorText(err) });
        if (performance.now() - lastRenewed >= (ttl * 2) / 3) fail("the store has been unreachable for two thirds of the lease ttl");
        return;
      }
      if (renewed) lastRenewed = performance.now();
      else fail("renewal reported the lease is no longer held");
      if (!lost && opts.operation) {
        try {
          if (!(await rt.d.ops.heartbeat(opts.operation))) fail("the operation is no longer running in the ledger");
        } catch (err) {
          rt.log("warn", "operation heartbeat failed", { error: errorText(err) });
        }
      }
    } finally {
      busy = false;
    }
  };

  rt.heartbeat(opts.detail);
  const timer = setInterval(() => void tick(), rt.limits.heartbeatIntervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const value = await body(controller.signal);
    if (lost) throw lost;
    return value;
  } catch (err) {
    throw lost ?? err;
  } finally {
    clearInterval(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
