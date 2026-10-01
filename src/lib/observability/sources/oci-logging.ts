/**
 * OCI logging availability over the existing runner transport contract.
 * The runner currently exposes log-group metadata, but its allowlist has no
 * Logging Search API. Metadata is never passed off as application log lines.
 * This source remains unavailable even with a runner until that contract lands.
 */
import type { OciSession } from "@/lib/providers/oci/transport";
import { createUnavailableSource } from "./unavailable";

export const OCI_LOGGING_SOURCE_ID = "oci.logging";

export function createOciLoggingSource(session?: OciSession) {
  return createUnavailableSource({
    id: OCI_LOGGING_SOURCE_ID, provider: "oci", supports: ["log"],
    reason: session
      ? "OCI runner transport does not allow Logging Search reads; log-group metadata is not log data."
      : "no OCI runner session: logs require a credential-broker observe session and a Logging Search transport",
  });
}
