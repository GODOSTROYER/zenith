/**
 * The diagnose stage for symptom-driven investigations (PROD-OBS-01).
 *
 * The incident engine's investigations used to be returned to the caller and
 * forgotten, so an inconclusive diagnosis could never escalate. This wrapper
 * records every finished investigation that belongs to a tracked incident
 * through `recordInvestigation`, which stores it and escalates an
 * inconclusive diagnosis to a person (PROD-OBS-03). The investigation itself
 * is unchanged and read-only; remediation options in it remain exact
 * proposals that are submitted through the capability broker and approvals.
 *
 * Recording is bound to the request's scope: an investigation whose
 * workspace or environment differs from the request is never stored.
 */
import type { InvestigationRequest, Investigator } from "@/lib/agent-access/v3/ports";
import type { Investigation } from "@/lib/incidents/types";
import { log } from "@/lib/log";

export type RecordInvestigation = (investigation: Investigation) => Promise<unknown>;

export function withDiagnosisRecording(inner: Investigator, record: RecordInvestigation): Investigator {
  return {
    get available() {
      return inner.available;
    },
    get reason() {
      return inner.reason;
    },
    async investigate(request: InvestigationRequest): Promise<Investigation> {
      const investigation = await inner.investigate(request);
      if (investigation.incidentId && investigation.workspaceId === request.workspaceId && investigation.environmentId === request.environmentId) {
        try {
          await record(investigation);
        } catch {
          // The read result is still correct; a store failure must not hide it.
          log.warn("diagnosis could not be recorded for escalation review", { scope: "repair" });
        }
      }
      return investigation;
    },
  };
}
