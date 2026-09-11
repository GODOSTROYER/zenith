/**
 * `GET|POST /api/hosted/apps/:appId/grants` — an app's access list.
 *
 * Owner only, and "owner" means a live `app_grants` row: workspace membership
 * grants nothing here. The read is happy with the resolved session; the write
 * asks the identity provider who is calling and uses *its* answer as the
 * granter, because a signed-out session must not be able to hand out access.
 *
 * Workstream W5 (hosted R3).
 */
import { z } from "zod";
import { grantDirect, listGrants } from "@/lib/hosted/access";
import type { AppGrantWire, AppGrantsWire } from "@/lib/hosted/contracts";
import { RoleSchema, hostedJson, hostedRoute, readJsonBody } from "@/lib/server/hosted";

export const dynamic = "force-dynamic";

const NewGrant = z
  .object({
    /** The platform user id. Direct grants are for people who already signed in here. */
    subject: z.string().trim().min(1).max(200),
    email: z.string().trim().min(3).max(320),
    role: RoleSchema,
  })
  .strict();

export const GET = hostedRoute<{ appId: string }>(
  { appRole: "owner", verify: "session" },
  async (_req, { appId }): Promise<AppGrantsWire> => ({ grants: listGrants(appId) })
);

export const POST = hostedRoute<{ appId: string }>(
  { appRole: "owner", verify: "live" },
  async (req, { appId }, { subject }) => {
    const body = await readJsonBody(req, NewGrant);
    const created: AppGrantWire = { grant: grantDirect(appId, body, subject) };
    return hostedJson(created, 201);
  }
);
