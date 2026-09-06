/**
 * Read-only operations the Navigator plans but the UI can run too.
 *
 * `investigate` used to live inside the executor as a hardcoded branch, which
 * meant one step in every plan was not a registered action: nothing audited
 * it, no other surface could call it, and the plan preview had to special-case
 * it. It is an action like the rest now — viewer role, `mutates: false`.
 */
import { z } from "zod";
import { defineAction, type ActionResult } from "@/lib/actions/core";
import { db, q } from "@/lib/db/store";
import { environmentHealth } from "@/lib/logsim";
import { requireEnvironment, requireProject } from "./_shared";

const Investigate = z.object({
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
});
type Investigate = z.infer<typeof Investigate>;

/**
 * Environment health is a seeded simulation (lib/logsim), and the map and the
 * deploy panel both label it "simulated health". Prose that says a service
 * "reads healthy" without that word is the one place the simulation passed
 * itself off as a measurement, so it carries the same qualifier here.
 */
function report(projectId: string, environmentId?: string): ActionResult {
  const failed = db()
    .deployments.filter(
      (d) =>
        d.projectId === projectId &&
        (!environmentId || d.environmentId === environmentId) &&
        (d.status === "failed" || d.status === "rolled_back")
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];

  if (!failed)
    return {
      ok: true,
      summary:
        "No failed deployment in this project's history — every deployment either succeeded, was cancelled, or is still running.",
    };

  // Unscoped lookups, deliberately: both ids come off a deployment that was
  // already filtered to the caller's own project, so they are that project's
  // own environment and revision. Nothing caller-supplied reaches this far.
  const env = q.environment(failed.environmentId);
  const revision = q.revision(failed.revisionId);
  const step = failed.steps.find((s) => s.status === "failed");
  const skipped = failed.steps.filter((s) => s.status === "skipped").length;
  const health = env ? environmentHealth(env.id) : {};
  const unhealthy = Object.entries(health).filter(
    ([, h]) => (h as { status?: string }).status !== "ok"
  );

  const lines = [
    `${env?.name ?? "An environment"} failed on revision ${revision?.number ?? "?"}: ${failed.changeSummary}.`,
    step
      ? `The ${step.phase} step "${step.title}" failed — ${(step.error ?? "no provider detail was recorded").replace(/\.$/, "")}.`
      : "No individual step recorded a failure; the deployment failed as a whole.",
    skipped ? `${skipped} later step(s) were skipped, so that revision is not fully applied.` : "",
    unhealthy.length
      ? `${unhealthy.length} service(s) in ${env?.name} report simulated health that is not fully healthy right now.`
      : env?.deployedRevisionId
        ? `${env.name} is still serving the revision that was live before this attempt, and its simulated health reads healthy.`
        : `${env?.name ?? "That environment"} has nothing running.`,
    failed.previousRevisionId
      ? "There is an earlier revision to roll back to if you need the environment consistent."
      : "There is no earlier revision to roll back to — fix the cause and deploy again.",
  ].filter(Boolean);

  return { ok: true, summary: lines.join(" "), data: { deploymentId: failed.id } };
}

defineAction<Investigate>({
  id: "ops.investigate",
  title: "Investigate the last failure",
  category: "operations",
  risk: "low",
  requiredRole: "viewer",
  mutates: false,
  input: Investigate,
  plan(ctx, input) {
    const project = requireProject(ctx, input.projectId);
    /*
     * TENANCY. `q.environment` read the whole store, and the summary below puts
     * `env.name` in front of the caller — so a read-only action anyone with the
     * viewer role could run turned an environment id from another workspace
     * into that environment's name. A plan that renders is already the leak,
     * whether or not execute would go on to refuse, so the scoped lookup goes
     * here as well as in execute.
     *
     * Resolution stays optional: investigating a whole project (no
     * environmentId) is the common case and must keep working. The id is
     * scoped when there is one, and `requireEnvironment` refuses a foreign one
     * with the same sentence a fabricated one gets.
     */
    const env = input.environmentId ? requireEnvironment(ctx, input.environmentId) : undefined;
    return {
      summary: `Read the most recent failed deployment in ${env?.name ?? project.name}.`,
      details: [
        "Reads the failed deployment, the step that failed and the provider error it recorded.",
        "Reports the environment's health, which is simulated in Zenith.ai.",
        "Changes nothing: no revision, no deployment, no manifest edit.",
      ],
      costDeltaUsd: 0,
      risk: "low",
      warnings: [],
      requiresApproval: false,
    };
  },
  execute(ctx, input) {
    const project = requireProject(ctx, input.projectId);
    // Scoped the same way as the plan, and the report reads the resolved
    // environment's id rather than the raw input — nothing unscoped reaches
    // the deployment filter.
    const env = input.environmentId ? requireEnvironment(ctx, input.environmentId) : undefined;
    return report(project.id, env?.id);
  },
});
