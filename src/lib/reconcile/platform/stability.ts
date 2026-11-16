/**
 * The platform adapter of `ReconcileStability` (PROD-OBS-03): drift verdicts
 * go through hysteresis and fingerprint dedup into durable incidents, and every
 * repair proposal reserves an attempt under the deterministic gate first.
 * Every statement is workspace scoped; any store error propagates so the caller
 * fails closed (no proposal).
 */
import { digest } from "@/lib/controlplane/digest";
import {
  observeSignal,
  reserveRemediation,
  bindAttemptToOperation,
  settleAttempt,
  listRepairsAwaitingVerification,
  getStabilityIncident,
  escalateIncident,
  evaluateIncidentEscalation,
} from "@/lib/controlplane/db/repos/incident-stability";
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { incidentFingerprint, type StabilityPolicy } from "@/lib/incidents/stability";
import type { Sql } from "@/lib/controlplane/types";
import type { DriftClass } from "@/lib/resources/types";
import type { RepairVerification, ReconcileStability, StabilityFindingObservation } from "../types";

const TRACKED: readonly DriftClass[] = ["missing", "changed", "extra"];
const MAX_ITEMS = 500;

export function createPlatformStability(db: Sql, policy?: StabilityPolicy): ReconcileStability {
  return {
    async observe(environment, items, now) {
      const { workspaceId, environmentId } = environment;
      const tracked = new Set(
        (await db.query<{ fingerprint: string }>(
          "select fingerprint from platform.incident_signal_state where workspace_id = $1 and environment_id = $2 and (state = 'active' or consecutive_bad > 0)",
          [workspaceId, environmentId]
        )).map((r) => r.fingerprint)
      );
      const confirmed = new Map<string, { incidentId: string }>();
      for (const item of items.slice(0, MAX_ITEMS) as StabilityFindingObservation[]) {
        for (const cls of TRACKED) {
          const fingerprint = incidentFingerprint({ workspaceId, environmentId, problem: `drift_${cls}`, subject: item.address });
          const isThis = item.observation === "bad" && item.class === cls;
          const observation = isThis ? "bad" : item.observation === "bad" ? "good" : item.observation;
          if (observation !== "bad" && !tracked.has(fingerprint)) continue;
          const severity = item.severity === "high" ? "high" : item.severity === "medium" ? "medium" : "low";
          const result = await observeSignal(db, {
            workspaceId,
            environmentId,
            fingerprint,
            observation,
            now,
            ...(policy ? { policy } : {}),
            incident: { title: `Drift: ${item.address} is ${cls}`, severity, source: "drift", document: { address: item.address, driftClass: cls } },
          });
          if (isThis && result.incident && result.signal.state === "active") confirmed.set(`${item.address}|${cls}`, { incidentId: result.incident.id });
        }
      }
      return confirmed;
    },

    async admit(environment, input, now) {
      const reservation = await reserveRemediation(db, {
        workspaceId: environment.workspaceId,
        environmentId: environment.environmentId,
        incidentId: input.incidentId,
        proposalDigest: digest({ idempotencyKey: input.request.idempotencyKey ?? null, capability: input.request.capability, address: input.address }),
        request: {
          capability: input.request.capability,
          resourceId: input.address,
          // One resource re-applied to its own desired state; stateful, identity and widened-firewall drift never reach here.
          blastRadius: "low",
          risk: CAPABILITIES[input.request.capability].risk,
          // The cause is observed drift, not a model's hypothesis.
          confidence: 1,
          autoscalerManaged: false,
        },
        now,
        ...(policy ? { policy } : {}),
      });
      return { allowed: reservation.decision.allowed, ...(reservation.attempt ? { attemptId: reservation.attempt.id } : {}), codes: reservation.decision.codes };
    },

    async attach(environment, attemptId, operationId) {
      await bindAttemptToOperation(db, { workspaceId: environment.workspaceId, attemptId, operationId });
    },

    async release(environment, attemptId, now) {
      await settleAttempt(db, { workspaceId: environment.workspaceId, attemptId, outcome: "abandoned", now });
    },

    async awaitingVerification(environment, now) {
      const rows = await listRepairsAwaitingVerification(db, { workspaceId: environment.workspaceId, environmentId: environment.environmentId, now });
      return rows.map((r) => ({ attemptId: r.attemptId, incidentId: r.incidentId, address: r.address, operationId: r.operationId, attemptStatus: r.attemptStatus, fingerprint: r.fingerprint }));
    },

    async verifyRepairs(environment, awaiting, items, now, opts) {
      const { workspaceId, environmentId } = environment;
      const out: RepairVerification[] = [];
      for (const a of awaiting) {
        const mine = opts.simulated ? [] : items.filter((i) => i.address === a.address);
        const samePersists = mine.some((i) => i.observation === "bad" && i.class && incidentFingerprint({ workspaceId, environmentId, problem: `drift_${i.class}`, subject: i.address }) === a.fingerprint);
        const outcome = samePersists ? "still_present" : mine.some((i) => i.observation === "good") ? "cleared" : "unverifiable";
        let escalated = false;
        let reasons: string[] = [];
        let incident: RepairVerification["incident"];
        if (outcome === "cleared") {
          // `observe` already ran for this pass: hysteresis resolves the incident once enough clean passes accumulate.
          const current = await getStabilityIncident(db, workspaceId, a.incidentId);
          incident = current?.status === "resolved" ? "closed" : "closing";
          escalated = Boolean(current?.escalatedAt);
          reasons = current?.escalationReasons ?? [];
        } else if (outcome === "still_present" && a.attemptStatus === "succeeded") {
          // The operation reported success and the re-observation disagrees: a person must look.
          const e = await escalateIncident(db, { workspaceId, incidentId: a.incidentId, reasons: ["verification_failed"], now });
          escalated = Boolean(e?.escalatedAt);
          reasons = e?.escalationReasons ?? [];
        } else {
          // A failed attempt or an unreadable node: stored facts (attempt budget, age, blocks) decide, never the absence of evidence.
          const e = await evaluateIncidentEscalation(db, { workspaceId, incidentId: a.incidentId, now, ...(policy ? { policy } : {}) });
          escalated = Boolean(e.incident?.escalatedAt);
          reasons = e.incident?.escalationReasons ?? [];
        }
        out.push({ incidentId: a.incidentId, attemptId: a.attemptId, operationId: a.operationId, address: a.address, attemptStatus: a.attemptStatus, outcome, ...(incident ? { incident } : {}), escalated, escalationReasons: reasons });
      }
      return out;
    },
  };
}
