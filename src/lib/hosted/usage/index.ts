/**
 * Usage ledger and spending alerts (50/75/90 % of the approved envelope).
 *
 * STUB written by the integrator; workstream W8 replaces this file keeping
 * every signature.
 */
import { HostedError, type UsageEntry } from "@/lib/hosted/contracts";

const pending = (): never => {
  throw new HostedError("policy_unavailable", "Usage accounting is not available in this build.", {
    fix: "Workstream W8 (src/lib/hosted/usage) has not landed.",
  });
};

export function recordUsage(entry: Omit<UsageEntry, "id" | "at"> & { at?: string }): UsageEntry {
  void entry;
  return pending();
}

/** True once spending reached 90 % of `ZENITH_SPEND_ENVELOPE_USD`; running apps are never stopped by this. */
export function buildsPaused(workspaceId: string): { paused: boolean; reason?: string } {
  void workspaceId;
  return pending();
}

/** Registers the `revocation_ledger` and `spend_alert` outbox handlers. Called by `ensureHosted()`. */
export function registerOpsOutboxHandlers(): void {}
