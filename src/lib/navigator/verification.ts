import { q } from "@/lib/db/store";
import { id, type NavigatorRun, type NavigatorVerification } from "@/lib/domain/types";
import { getProvider } from "@/lib/providers/types";

const COVERED = new Set(["deploy.apply", "deploy.plan", "ops.investigate"]);

/** No successful status, model wording or partial observation can authorize green. */
export async function verifyRun(run: NavigatorRun): Promise<{ verification?: NavigatorVerification; note: string }> {
  const unsupported = run.steps.find((step) => !COVERED.has(step.actionId));
  if (unsupported || run.steps.some((step) => step.status !== "done"))
    return { note: unsupported ? `Completed. Whole-run verification does not yet cover “${unsupported.title}”. Inspect the recorded results.`
      : "The run has unfinished steps; it cannot be verified." };
  const deployments = run.steps.filter((step) => step.actionId === "deploy.apply");
  if (!deployments.length) return { note: "No provider changes were applied by this run." };
  const checks: NonNullable<NavigatorVerification["checks"]> = [];
  const connections = new Map<string, string>();
  const checksStartedAt = Date.now();
  let simulated = false;
  for (const step of deployments) {
    const deployment = step.deploymentId ? q.deployment(step.deploymentId) : undefined;
    const environment = deployment ? q.environment(deployment.environmentId) : undefined;
    const revision = deployment ? q.revision(deployment.revisionId) : undefined;
    if (!deployment || !environment || !revision || deployment.projectId !== run.projectId ||
      environment.projectId !== run.projectId || deployment.status !== "succeeded" ||
      environment.deployedRevisionId !== deployment.revisionId)
      return { note: "Provider verification is unavailable: a deployment is unfinished, missing, or has been superseded." };
    const connection = q.connection(environment.connectionId);
    if (!connection) return { note: "Provider verification is unavailable: the cloud connection is missing." };
    connections.set(deployment.id, environment.connectionId);
    const provider = getProvider(connection.provider);
    if (provider.id === "sandbox") {
      simulated = true;
      checks.push({ deploymentId: deployment.id, revisionId: revision.id, provider: provider.id,
        detail: "Sandbox deployment completed; no external infrastructure was inspected.", passed: true });
      continue;
    }
    if (!provider.verify) return { note: `${provider.displayName} does not support complete deployment verification yet.` };
    const previous = deployment.previousRevisionId ? q.revisionManifest(deployment.previousRevisionId) : undefined;
    if (deployment.previousRevisionId && !previous) return { note: "The previous revision is missing; removals cannot be verified." };
    const startedAt = Date.now();
    const result = await provider.verify(environment, revision.manifest, previous);
    if (environment.deployedRevisionId !== revision.id || deployment.status !== "succeeded")
      return { note: "The deployment changed during verification. Its earlier observation cannot verify this run." };
    if (result.status === "unavailable") return { note: result.detail };
    if (!Number.isFinite(Date.parse(result.checkedAt)) || Date.parse(result.checkedAt) < startedAt ||
      Date.parse(result.checkedAt) > Date.now() || !result.checks.length ||
      (result.status === "passed") !== result.checks.every((check) => check.passed))
      return { note: "The provider returned incomplete or stale verification evidence." };
    simulated ||= result.simulated;
    checks.push(...result.checks.map((check) => ({ ...check, deploymentId: deployment.id, revisionId: revision.id, provider: provider.id })));
  }
  // Re-check every deployment after the last async provider call.
  if (checks.some((check) => {
    const deployment = q.deployment(check.deploymentId);
    const environment = deployment ? q.environment(deployment.environmentId) : undefined;
    return !deployment || deployment.status !== "succeeded" || environment?.deployedRevisionId !== check.revisionId ||
      environment.connectionId !== connections.get(check.deploymentId) ||
      q.connection(environment.connectionId)?.provider !== check.provider;
  }))
    return { note: "A deployment or cloud connection changed during verification. The result was not marked verified." };
  const passed = checks.every((check) => check.passed);
  return {
    verification: { scope: "run", source: "provider", status: passed ? "passed" : "failed", simulated,
      checkedAt: new Date(Math.max(checksStartedAt, Date.now())).toISOString(), evidenceRef: `navigator:${run.id}:verification:${id()}`, checks },
    note: simulated ? "Simulation complete. Live provider state has not been verified."
      : passed ? `Verified ${checks.length} provider checks across ${deployments.length} deployment${deployments.length === 1 ? "" : "s"}. Open the recorded checks for details.`
        : "Provider verification failed: the deployed resources do not match the intended result. Inspect the recorded checks.",
  };
}
