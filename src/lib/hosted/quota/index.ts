/**
 * Request quotas, body limits and enforcement labels.
 *
 * STUB written by the integrator; workstream W8 replaces this file keeping
 * every signature. Until then admission refuses (`policy_unavailable`).
 */
import {
  DEFAULT_LIMITS,
  HostedError,
  type LimitEnforcement,
  type QuotaCounter,
  type RuntimeId,
} from "@/lib/hosted/contracts";

const pending = (): never => {
  throw new HostedError("policy_unavailable", "Quota accounting is not available in this build.", {
    fix: "Workstream W8 (src/lib/hosted/quota) has not landed.",
  });
};

/** Count one request against the app's UTC day and say whether it is admitted. Atomic. */
export function admitRequest(
  appId: string,
  opts: { now?: Date; limit?: number } = {}
): { allowed: boolean; counter: QuotaCounter; limit: number } {
  void appId;
  void opts;
  return pending();
}

/** Read a JSON body of at most `maxBytes`; throws `body_too_large` / `invalid_input`. */
export async function readJsonBody(req: Request, maxBytes: number = DEFAULT_LIMITS.bodyBytes): Promise<unknown> {
  void req;
  void maxBytes;
  return pending();
}

/** Which limits this runtime enforces itself; the rest are provider limits or not enforced. */
export function enforcementFor(runtime: RuntimeId): LimitEnforcement {
  void runtime;
  return pending();
}
