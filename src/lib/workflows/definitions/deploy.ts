/**
 * infrastructureDeployWorkflow — the deploy step sequence (spec §16):
 *
 *   validate → lease → plan → policy → [approval] → final_plan
 *     → apply_infrastructure → build → deploy → migrate
 *     → verify_infrastructure → verify_application → observe → finalize → release
 *
 * Deterministic (workflow sandbox): imports only `@temporalio/workflow` and
 * relative workflow modules. Every effect is an activity; every number is in
 * policies.ts; the failure -> status mapping is in failures.ts.
 *
 * What it will not do: destroy, roll back or "compensate" anything. If a step
 * fails after a mutation started the operation ends `failed` or `uncertain`
 * and reconciliation observes reality. Rolling back stateful resources
 * (databases, volumes, buckets) automatically would destroy data; only
 * non-stateful workload rollback could be added later, and not here.
 *
 * `input.preApproved` records that the control plane's policy check already
 * allowed this operation without approval. It is informational: the policy step
 * re-evaluates against the concrete plan, and if it now says `require_approval`
 * the workflow waits for one. Policy is authoritative, never the hint.
 */

import type { DeployWorkflowInput, PlanSummary, WorkflowResult } from "../types";
import { activities } from "./activities";
import { redactDetail } from "./failures";
import { OperationRun } from "./runtime";

const DEPLOY_STEPS = [
  "validate",
  "lease",
  "plan",
  "policy",
  "approval",
  "final_plan",
  "apply_infrastructure",
  "build",
  "deploy",
  "migrate",
  "verify_infrastructure",
  "verify_application",
  "observe",
  "finalize",
  "release",
] as const;

const short = (digest: string): string => (digest.length > 19 ? digest.slice(0, 19) : digest);

const describePlan = (plan: PlanSummary): string =>
  `${plan.create} create · ${plan.update} update · ${plan.delete} delete · ${plan.replace} replace` +
  (plan.destroysData ? " · destroys data" : "") +
  (plan.empty ? " · no changes" : "") +
  ` · ${short(plan.planDigest)}`;

export async function infrastructureDeployWorkflow(input: DeployWorkflowInput): Promise<WorkflowResult> {
  const { operationId } = input;
  const run = new OperationRun({
    operationId,
    deploymentId: input.deploymentId,
    leaseScope: `env:${input.environmentId}`,
    steps: DEPLOY_STEPS,
  });

  return run.run(async () => {
    await run.step(
      "validate",
      async () => {
        const validation = await activities.validateDesiredState({ operationId });
        if (validation.problems.length > 0) {
          const shown = validation.problems.slice(0, 3).join("; ");
          const more = validation.problems.length > 3 ? ` (+${validation.problems.length - 3} more)` : "";
          throw run.halt("failed", `The desired state is invalid: ${shown}${more}`);
        }
        return validation;
      },
      (v) => `${v.nodes} node(s) · ${short(v.graphDigest)}`
    );

    await run.acquireLeaseStep();

    const plan = await run.step("plan", () => activities.planInfrastructure({ operationId, lease: run.requireLease() }), describePlan);

    const policy = await run.step(
      "policy",
      async () => {
        const decision = await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest });
        if (decision.outcome === "deny") {
          throw run.halt("failed", `Policy denied this deployment: ${decision.reasons.slice(0, 5).join("; ") || "no reason given"}`);
        }
        return decision;
      },
      (d) => `${d.outcome} (${d.decisionId})`
    );

    if (policy.outcome === "require_approval") {
      await run.approvalGate();
    } else {
      await run.skip("approval", input.preApproved ? "policy allows; pre-approved" : "policy allows without approval");
    }

    // Re-plan and compare against the digest that was reviewed. The activity
    // throws a non-retryable `plan_changed`; the digest check below is the
    // workflow's own belt and braces.
    const finalPlan = await run.step(
      "final_plan",
      async () => {
        const summary = await activities.finalPlan({ operationId, approvedPlanDigest: plan.planDigest, lease: run.requireLease() });
        if (summary.planDigest !== plan.planDigest) {
          throw run.halt(
            "failed",
            `The infrastructure plan changed after it was reviewed (${short(plan.planDigest)} → ${short(summary.planDigest)}); nothing was applied. A new plan and a new approval are required.`
          );
        }
        return summary;
      },
      (p) => `unchanged · ${short(p.planDigest)}`
    );

    await run.step(
      "apply_infrastructure",
      () => activities.applyInfrastructure({ operationId, planDigest: finalPlan.planDigest, lease: run.requireLease() }),
      (r) => `${r.applied} change(s) applied · outputs ${short(r.outputsDigest)}`
    );

    let images: { service: string; imageUri: string; digest: string }[] = [];
    if (input.build) {
      const built = await run.step("build", () => activities.buildArtifacts({ operationId, lease: run.requireLease() }), (r) => `${r.images.length} image(s)`);
      images = built.images;
    } else {
      await run.skip("build", "images are pinned by the manifest");
    }

    await run.step("deploy", () => activities.deployWorkloads({ operationId, lease: run.requireLease(), images }), (r) => `${r.services} service(s)`);

    await run.step("migrate", () => activities.runMigrations({ operationId, lease: run.requireLease() }), (r) => (r.ran ? r.detail : `no migrations: ${r.detail}`));

    await run.step("verify_infrastructure", async () => {
      const verified = await activities.verifyInfrastructure({ operationId });
      if (verified.status === "failed") {
        throw run.halt(
          "failed",
          `Infrastructure verification failed (${verified.failed} of ${verified.checks} checks). The changes were applied and nothing was rolled back.`
        );
      }
      if (verified.status === "unknown") {
        throw run.halt("uncertain", "Infrastructure verification was inconclusive; the changes were applied and their health is unknown. Reconcile will observe the environment.");
      }
      return verified;
    }, (v) => `${v.checks} check(s) passed`);

    await run.step("verify_application", async () => {
      const verified = await activities.verifyApplication({ operationId });
      if (verified.status === "failed") {
        throw run.halt(
          "failed",
          `Application verification failed (${verified.failed} of ${verified.checks} checks). The deployment was applied and nothing was rolled back.`
        );
      }
      if (verified.status === "unknown") {
        throw run.halt("uncertain", "Application verification was inconclusive; the deployment was applied and its health is unknown. Reconcile will observe the environment.");
      }
      return verified;
    }, (v) => redactDetail(`${v.checks} check(s) passed${v.url ? ` · ${v.url}` : ""}`));

    // Diagnostic: a failed observation does not undo a verified deployment.
    await run.optionalStep("observe", () => activities.observeEnvironment({ operationId }), (o) => `drift ${o.drift} · unknown ${o.unknown}`);
  });
}
