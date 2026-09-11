/**
 * `PATCH|DELETE /api/hosted/apps/:appId/grants/:grantId` — change a role, or
 * take access away.
 *
 * Both are scoped to the app in the path: a grant that belongs to another app
 * answers exactly as one that does not exist, so an owner of one app cannot
 * discover ids belonging to another. Both refuse to leave the app without an
 * owner (409), checked inside the transaction that writes.
 *
 * A revoke ends that grant's app sessions in the same transaction, so "removed"
 * is true for the next request rather than for the next sign-in.
 */
import { z } from "zod";
import { changeGrantRole, revokeGrant } from "@/lib/hosted/access";
import type { AppGrantWire, GrantRevokedWire } from "@/lib/hosted/contracts";
import { RoleSchema, hostedRoute, readJsonBody } from "@/lib/server/hosted";

export const dynamic = "force-dynamic";

const RoleChange = z.object({ role: RoleSchema }).strict();

const Revoke = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

export const PATCH = hostedRoute<{ appId: string; grantId: string }>(
  { appRole: "owner", verify: "live" },
  async (req, { appId, grantId }, { subject }): Promise<AppGrantWire> => {
    const { role } = await readJsonBody(req, RoleChange);
    return { grant: changeGrantRole(grantId, role, subject, { appId }) };
  }
);

export const DELETE = hostedRoute<{ appId: string; grantId: string }>(
  { appRole: "owner", verify: "live" },
  async (req, { appId, grantId }, { subject }): Promise<GrantRevokedWire> => {
    const { reason } = await readJsonBody(req, Revoke, { optional: true });
    const revoked = revokeGrant(grantId, subject, reason, { appId });
    return {
      grant: revoked.grant,
      sessionsTerminated: revoked.sessionsTerminated,
      revocationSeq: revoked.revocation.seq,
    };
  }
);
