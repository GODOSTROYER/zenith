/**
 * OCI Monitoring availability. The fixed OCI runner service table has no
 * monitoring endpoint or summarizeMetricsData allowlist entry. No synthetic
 * metric, resource count or guessed zero substitutes for an unread series.
 */
import type { OciSession } from "@/lib/providers/oci/transport";
import { createUnavailableSource } from "./unavailable";

export const OCI_MONITORING_SOURCE_ID = "oci.monitoring";

export function createOciMonitoringSource(session?: OciSession) {
  return createUnavailableSource({
    id: OCI_MONITORING_SOURCE_ID, provider: "oci", supports: ["metric"],
    reason: session
      ? "OCI runner transport has no Monitoring service or summarizeMetricsData read allowlist."
      : "no OCI runner session: metrics require a credential-broker observe session and a Monitoring transport",
  });
}
