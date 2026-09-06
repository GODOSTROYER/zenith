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
import { intParam, membershipCheck, route, scopedEnvironment } from "@/lib/server/context";
import { sseResponse, type SseEvent } from "@/lib/server/sse";

export const dynamic = "force-dynamic";

export const GET = route<{ envId: string; serviceId: string }>(async (req, { envId, serviceId }) => {
  // Bound to the caller's workspace through the owning project; `serviceId` is
  // only ever read under this environment, so binding the environment binds it.
  const env = scopedEnvironment(envId);

  const providerId = q.connection(env.connectionId)?.provider ?? "sandbox";
  const provider = providerRegistry().has(providerId) ? getProvider(providerId) : undefined;
  const source = {
    simulated: true,
    provider: { id: providerId, displayName: provider?.displayName ?? providerId },
  };

  const logsim = await logsimModule();
  let cursor = intParam(req, "after", -1);

  // Re-checked every poll: a log tail outlives the request that opened it, so
  // losing membership has to stop the lines, not just the next connect.
  return sseResponse(req.signal, membershipCheck(), () => {
    const lines = logsim.getServiceLogs?.(env.id, serviceId, cursor) ?? [];
    for (const l of lines) cursor = Math.max(cursor, l.seq);
    return lines.map((l): SseEvent => ({ event: "log", id: l.seq, data: { ...l, ...source } }));
  });
});
