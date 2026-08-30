/** Per-service health for an environment. Sandbox health is synthetic and says so. */
import { q } from "@/lib/db/store";
import { logsimModule } from "@/lib/server/boot";
import { ApiError, notFound, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ envId: string }>(async (_req, { envId }) => {
  const env = q.environment(envId);
  if (!env) throw notFound(`Environment "${envId}"`, "Pick an environment from the project's Observe tab.");

  const logsim = await logsimModule();
  if (!logsim?.environmentHealth)
    throw new ApiError("Health data is not available on this server.", 503, {
      fix: "The sandbox health simulator has not shipped yet — deploy to see live outputs instead.",
    });

  return {
    environmentId: env.id,
    /** honest label: sandbox health is computed, not measured against real infra */
    simulated: true,
    services: logsim.environmentHealth(env.id),
  };
});
