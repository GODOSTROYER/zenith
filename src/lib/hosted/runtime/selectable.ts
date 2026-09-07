/**
 * The sync half of `availability()`.
 *
 * `HostedRuntime.availability()` is async because a real provider check may
 * have to ask the provider. But `selectedHostedRuntime()` is synchronous — it
 * is called from a route that has already decided it needs a runtime — and it
 * has to refuse with the *reason*, not with a generic "unavailable". Every
 * runtime here therefore also answers, without I/O, "is anything missing from
 * this machine's configuration?".
 *
 * A runtime that answers `null` may still fail later; what it promises is only
 * that nothing is missing before it starts.
 *
 * Workstream W6 (hosted R3).
 */
import type { HostedRuntime } from "@/lib/hosted/contracts";

export interface SelectableRuntime extends HostedRuntime {
  /** Why this runtime cannot run on this machine, decided without I/O. */
  blockedReason(): { reason: string; fix: string } | null;
}
