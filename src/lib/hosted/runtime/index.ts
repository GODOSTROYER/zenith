/**
 * Hosted runtimes: `local` (this process) and `cloudflare` (Workers for
 * Platforms, gated on credentials).
 *
 * STUB written by the integrator; workstream W6 replaces this file keeping
 * every signature.
 */
import { HostedError, type HostedRuntime } from "@/lib/hosted/contracts";

const pending = (): never => {
  throw new HostedError("runtime_unavailable", "No hosted runtime is available in this build.", {
    fix: "Workstream W6 (src/lib/hosted/runtime) has not landed.",
  });
};

/** Every runtime this build knows, available or blocked-with-reason. */
export function hostedRuntimes(): HostedRuntime[] {
  return pending();
}

/** The runtime `ZENITH_RUNTIME` selects. Throws `runtime_unavailable` when it cannot run. */
export function selectedHostedRuntime(): HostedRuntime {
  return pending();
}
