/**
 * SSE tail of synthetic app logs for one service. Resume with `?after=<seq>`.
 *
 * Every frame carries `simulated` and the environment's real provider: these
 * lines are generated, not collected, whatever the environment deploys through.
 * The client no longer has to hardcode that chip.
 */
import { q } from "@/lib/db/store";
import { getProvider, providerRegistry } from "@/lib/providers/types";
import { logsimModule } from "@/lib/server/boot";
import { intParam, notFound, route } from "@/lib/server/context";
import { sseResponse, type SseEvent } from "@/lib/server/sse";

export const dynamic = "force-dynamic";

export const GET = route<{ envId: string; serviceId: string }>(async (req, { envId, serviceId }) => {
  const env = q.environment(envId);
  if (!env) throw notFound(`Environment "${envId}"`, "Pick an environment from the project's Observe tab.");

  const providerId = q.connection(env.connectionId)?.provider ?? "sandbox";
  const provider = providerRegistry().has(providerId) ? getProvider(providerId) : undefined;
  const source = {
    simulated: true,
    provider: { id: providerId, displayName: provider?.displayName ?? providerId },
  };

  const logsim = await logsimModule();
  let cursor = intParam(req, "after", -1);

  return sseResponse(req.signal, () => {
    const lines = logsim.getServiceLogs?.(env.id, serviceId, cursor) ?? [];
    for (const l of lines) cursor = Math.max(cursor, l.seq);
    return lines.map((l): SseEvent => ({ event: "log", id: l.seq, data: { ...l, ...source } }));
  });
});
