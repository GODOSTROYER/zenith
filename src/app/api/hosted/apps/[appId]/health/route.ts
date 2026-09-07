/**
 * `GET /api/hosted/apps/:appId/health` — real probes, with release attribution.
 *
 * Owner only. Every field comes from something that was read: the app row, the
 * app's own database, the artifact's bytes re-hashed from disk, the event
 * table, today's quota counter. `simulated` is always `false` here — a probe
 * that could not run answers `ok: false` with the reason.
 *
 * Workstream W8 (hosted R3).
 */
import { appHealth } from "@/lib/hosted/health";
import { route } from "@/lib/server/context";
import { hosted, requireAppOwner } from "@/app/api/hosted/ops/_http";

export const dynamic = "force-dynamic";

export const GET = route<{ appId: string }>(async (_req, { appId }) =>
  hosted(async () => {
    requireAppOwner(appId);
    return { health: await appHealth(appId) };
  })
);
