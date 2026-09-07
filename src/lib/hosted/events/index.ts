/**
 * Activation/lifecycle events: pseudonymous, deduplicated, founder/test aware.
 *
 * STUB written by the integrator; workstream W8 replaces this file keeping
 * every signature. Recording must never throw into a request path.
 */
import type { HostedEventName, Subject } from "@/lib/hosted/contracts";

export interface RecordEventInput {
  event: HostedEventName;
  workspaceId: string;
  appId?: string;
  subject?: Subject;
  releaseId?: string;
  outcome?: "ok" | "error" | "denied";
  logicalId?: string;
  assisted?: boolean;
  props?: Record<string, string | number | boolean>;
}

/** Returns true when a new row was written (false = deduplicated or not yet available). */
export function recordEvent(input: RecordEventInput): boolean {
  void input;
  return false;
}
