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
import type { HostedHealthWire } from "@/lib/hosted/contracts";
import { appHealth } from "@/lib/hosted/health";
import { hostedRoute } from "@/lib/server/hosted";

export const dynamic = "force-dynamic";

export const GET = hostedRoute<{ appId: string }>(
  { appRole: "owner", refusal: "not_found" },
  async (_req, { appId }): Promise<HostedHealthWire> => ({ health: await appHealth(appId) })
);
