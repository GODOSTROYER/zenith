/** Explicitly gated: real default API, PostgreSQL, Temporal and signed registered zenithd. */
import { describe, expect, it } from "vitest";
import { defaultMaintenanceAcceptance } from "../../scripts/acceptance/maintenance/default";
import { registeredRunbookAcceptance } from "../../scripts/acceptance/maintenance/runbooks";
describe("J4 default local-engine acceptance (requires Mac default stack)", () => {
  it.skipIf(process.env.ZENITH_TEST_MAINTENANCE !== "1")("executes seven critical jobs plus billing on natural timers across worker restart without overlap", async () => {
    expect(await defaultMaintenanceAcceptance()).toMatchObject({ naturalTimers: true, criticalJobs: 7, billing: true, billingFallback: true, billingFallbackIdempotent: true, workerRestart: true, fallbackResumed: true, jobLeaseExclusion: true, epochPreserved: true });
  }, 600_000);
  it.skipIf(process.env.ZENITH_TEST_RUNBOOK_DELIVERY !== "1")("joins real signed registered delivery, broker semantics, evidence and cancellation audit", async () => {
    expect(await registeredRunbookAcceptance()).toMatchObject({ registeredSignedDelivery: true, oneDelivery: true, auditJoin: true, pendingCancellation: true, rawExecApprovalRequired: true });
  }, 240_000);
});
