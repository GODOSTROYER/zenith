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
 *
 * Workstream W5 (hosted R3).
 */
import { z } from "zod";
import { changeGrantRole, revokeGrant } from "@/lib/hosted/access";
import {
  RoleSchema,
  hostedRoute,
  readJsonBody,
  readOptionalJsonBody,
  verifiedOwner,
} from "@/lib/hosted/access/http";

export const dynamic = "force-dynamic";

const RoleChange = z.object({ role: RoleSchema }).strict();

const Revoke = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

export const PATCH = hostedRoute<{ appId: string; grantId: string }>(
  async (req, { appId, grantId }) => {
    const { identity } = await verifiedOwner(req, appId);
    const { role } = await readJsonBody(req, RoleChange);
    return { grant: changeGrantRole(grantId, role, identity.subject, { appId }) };
  }
);

export const DELETE = hostedRoute<{ appId: string; grantId: string }>(
  async (req, { appId, grantId }) => {
    const { identity } = await verifiedOwner(req, appId);
    const { reason } = await readOptionalJsonBody(req, Revoke);
    const revoked = revokeGrant(grantId, identity.subject, reason, { appId });
    return {
      grant: revoked.grant,
      sessionsTerminated: revoked.sessionsTerminated,
      revocationSeq: revoked.revocation.seq,
    };
  }
);
