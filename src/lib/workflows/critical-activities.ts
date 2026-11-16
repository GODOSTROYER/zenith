/** Activity registration for the durable critical maintenance schedule (PROD-OBS-04). */
import { Context, ApplicationFailure, CancelledFailure } from "@temporalio/activity";
import type { Sql } from "@/lib/controlplane/types";
import { runCriticalMaintenance } from "@/lib/platform/critical-jobs";
import type { CriticalMaintenanceActivities, CriticalMaintenanceActivityInput, CriticalMaintenanceResult } from "./definitions/criticalMaintenance";
import { CRITICAL_MAINTENANCE_CONTRACT } from "./critical-schedule";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createCriticalMaintenanceActivities(db: Sql): CriticalMaintenanceActivities {
  return {
    async runCriticalMaintenance(input: CriticalMaintenanceActivityInput): Promise<CriticalMaintenanceResult> {
      const keys = input && typeof input === "object" ? Object.keys(input).sort().join(",") : "";
      if (!input || Object.getPrototypeOf(input) !== Object.prototype || keys !== "contract,passId" || input.contract !== CRITICAL_MAINTENANCE_CONTRACT || typeof input.passId !== "string" || !UUID.test(input.passId))
        throw ApplicationFailure.nonRetryable("Critical maintenance activity input is invalid.", "CriticalMaintenanceContractInvalid");
      const context = Context.current();
      context.cancellationSignal.throwIfAborted();
      const signal = AbortSignal.any([context.cancellationSignal, AbortSignal.timeout(95_000)]);
      const beat = setInterval(() => context.heartbeat({ phase: "maintaining" }), 1_000);
      beat.unref();
      try {
        context.heartbeat({ phase: "maintaining" });
        return await runCriticalMaintenance(db, "temporal", signal);
      } catch (error) {
        if (context.cancellationSignal.aborted) throw new CancelledFailure(undefined);
        throw error;
      } finally { clearInterval(beat); }
    },
  };
}
