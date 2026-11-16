/**
 * The shared shape of a single-capability operation, used by the day-two and
 * remediation workflows:
 *
 *   lease → policy re-check → [approval] → execute_capability → verify_application
 *     → finalize → release
 *
 * Deterministic (workflow sandbox): imports only `@temporalio/workflow` and
 * relative workflow modules.
 *
 * `executeCapability` gets one attempt (policies.ts). A failed or
 * inconclusive verification ends the operation `failed` / `uncertain`; nothing
 * re-runs the capability and nothing rolls it back automatically.
 */

import type { StepName } from "../types";
import { activities } from "./activities";
import { OperationRun } from "./runtime";

export type CapabilityKind = "day-two operation" | "remediation";

export const CAPABILITY_STEPS = ["lease", "policy", "approval", "execute_capability", "verify_application", "finalize", "release"] as const satisfies readonly StepName[];

export async function runCapabilityOperation(run: OperationRun, kind: CapabilityKind): Promise<void> {
  const { operationId } = run;

  await run.acquireLeaseStep();

  // The proposal was checked when it was made; the environment or the policy
  // bundle may have moved since, so the decision is re-taken before acting.
  const decision = await run.step(
    "policy",
    async () => {
      const result = await activities.evaluatePolicy({ operationId });
      if (result.outcome === "deny") {
        throw run.halt("failed", `Policy denied this ${kind}: ${result.reasons.slice(0, 5).join("; ") || "no reason given"}`);
      }
      return result;
    },
    (d) => `${d.outcome} (${d.decisionId})`
  );

  if (decision.outcome === "require_approval") {
    await run.approvalGate();
  } else {
    await run.skip("approval", "policy allows without approval");
  }

  const executed = await run.step(
    "execute_capability",
    async () => {
      const result = await activities.executeCapability({ operationId, lease: run.requireLease() });
      if (!result.ok) {
        // The capability reported a clean failure; it may have partially acted.
        throw run.halt("failed", `The ${kind} did not succeed: ${result.summary}`);
      }
      return result;
    },
    (r) => r.summary
  );

  await run.step(
    "verify_application",
    async () => {
      const verified = await activities.verifyApplication({ operationId });
      if (verified.status === "failed") {
        throw run.halt(
          "failed",
          `The ${kind} was applied (${executed.summary}) but verification failed (${verified.failed} of ${verified.checks} checks). It is not retried automatically and nothing was rolled back.`
        );
      }
      if (verified.status === "unknown") {
        throw run.halt("uncertain", `The ${kind} was applied (${executed.summary}) but verification was inconclusive; its result is unknown. Reconcile will observe the environment.`);
      }
      return verified;
    },
    (v) => `${v.checks} check(s) passed${v.evidenceId ? ` · evidence ${v.evidenceId}` : ""}`
  );
}
