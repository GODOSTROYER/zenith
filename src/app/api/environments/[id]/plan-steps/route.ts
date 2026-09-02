/**
 * The steps a deploy of the working copy *would* run, without starting one.
 *
 * `provider.planSteps` is pure and is exactly what `engine.start()` calls to
 * build a deployment's step list (engine.ts), so this preview is the real plan
 * and not a second guess at it. Nothing is written: no deployment record, no
 * revision, no audit entry.
 *
 * A provider that cannot plan (every Planned adapter throws) is refused the way
 * an action plan refuses — `{ blocked }` with the reason and the way out — not
 * as an error, because "this provider cannot preview" is an answer.
 */
import { z } from "zod";
import { db, inWorkspace, q } from "@/lib/db/store";
import { getProvider, providerRegistry, type ProviderPlanStep } from "@/lib/providers/types";
import type { DeploymentStep } from "@/lib/domain/types";
import { ApiError, notFound, requireWorkspace, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

/** Only the working copy today; the field exists so a revision source can be added without a new route. */
const Body = z.object({ revisionSource: z.literal("working") });

/** Same four phases, same order and wording as the deployment timeline. */
const PHASES: { key: DeploymentStep["phase"]; name: string }[] = [
  { key: "prepare", name: "Prepare" },
  { key: "provision", name: "Provision" },
  { key: "release", name: "Release" },
  { key: "verify", name: "Verify" },
];

export const POST = route<{ id: string }>(async (req, { id }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    throw new ApiError('Expected a body of {"revisionSource":"working"}.', 400, {
      fix: "Send the working copy as the plan source; no other source is supported yet.",
    });

  const env = q.environment(id);
  // An id is not a read grant — same tenancy check as every other id route.
  if (!env || !inWorkspace(requireWorkspace().id, env.projectId))
    throw notFound(`Environment "${id}"`, "Open the project's Settings tab and pick an environment.");

  const project = db().projects.find((p) => p.id === env.projectId);
  if (!project)
    throw notFound(`Project for environment "${env.name}"`, "Recreate the environment from a project.");

  const connection = q.connection(env.connectionId);
  if (!connection || !providerRegistry().has(connection.provider))
    return {
      blocked: `${env.name} has no usable cloud connection, so the steps a deploy would run cannot be worked out. Point it at a connection in Settings → Environments.`,
    };

  const provider = getProvider(connection.provider);
  if (provider.availability === "planned")
    return {
      blocked: `${provider.displayName} is planned, not implemented — it cannot say what a deploy would do. Point ${env.name} at a Sandbox connection to preview and deploy now, or at AWS to preview and export runnable Terraform.`,
    };

  const previous = env.deployedRevisionId ? q.revision(env.deployedRevisionId) : undefined;

  let plan: ProviderPlanStep[];
  try {
    plan = provider.planSteps(env, project.workingManifest, previous?.manifest);
  } catch (err) {
    // Planning is provider code and it is allowed to refuse. Same wording the
    // engine uses when start() hits this, minus the "deploy now" imperative.
    return {
      blocked:
        `${provider.displayName} could not plan a deployment for ${env.name}: ` +
        `${err instanceof Error ? err.message : String(err)} ` +
        `Point ${env.name} at a Sandbox connection in Settings → Environments to deploy now, or at AWS to export runnable Terraform.`,
    };
  }

  return {
    phases: PHASES.map((p) => ({
      name: p.name,
      steps: plan
        .filter((s) => s.phase === p.key)
        .map((s) => ({ title: s.title, estMs: s.estMs })),
    })).filter((p) => p.steps.length > 0),
    // Only the sandbox invents its results; every other provider's estimate
    // describes work it would really do.
    simulated: provider.id === "sandbox",
    provider: provider.id,
  };
});
