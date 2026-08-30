/** SSE tail of synthetic app logs for one service. Resume with `?after=<seq>`. */
import { q } from "@/lib/db/store";
import { logsimModule } from "@/lib/server/boot";
import { intParam, notFound, route } from "@/lib/server/context";
import { sseResponse, type SseEvent } from "@/lib/server/sse";

export const dynamic = "force-dynamic";

export const GET = route<{ envId: string; serviceId: string }>(async (req, { envId, serviceId }) => {
  const env = q.environment(envId);
  if (!env) throw notFound(`Environment "${envId}"`, "Pick an environment from the project's Observe tab.");

  const logsim = await logsimModule();
  let cursor = intParam(req, "after", -1);
  let sent = false;

  return sseResponse(req.signal, () => {
    if (!logsim?.getServiceLogs) {
      if (sent) return null;
      sent = true;
      return [
        {
          event: "error",
          data: {
            message: "Log streaming is not available on this server.",
            fix: "The sandbox log generator has not shipped yet — deployment step logs are on the Deploys tab.",
          },
        },
      ];
    }
    const lines = logsim.getServiceLogs(env.id, serviceId, cursor);
    for (const l of lines) cursor = Math.max(cursor, l.seq);
    return lines.map((l): SseEvent => ({ event: "log", id: l.seq, data: l }));
  });
});
