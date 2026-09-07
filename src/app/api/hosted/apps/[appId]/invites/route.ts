/**
 * `GET|POST /api/hosted/apps/:appId/invites` — the invitations on an app.
 *
 * The POST answers 201 with `acceptUrl` **once**. That link is not stored in
 * clear anywhere, so it cannot be shown again; when this install has no SMTP
 * configured it is the only way the owner has to pass the invitation on, and
 * the delivery row in the same response says so in as many words.
 *
 * Workstream W5 (hosted R3).
 */
import { z } from "zod";
import { createInvite, listInvites, scheduleInviteDelivery } from "@/lib/hosted/access";
import {
  RoleSchema,
  hostedJson,
  hostedRoute,
  readJsonBody,
  signedInOwner,
  verifiedOwner,
} from "@/lib/hosted/access/http";

export const dynamic = "force-dynamic";

const NewInvite = z
  .object({
    email: z.string().trim().min(3).max(320),
    role: RoleSchema,
  })
  .strict();

export const GET = hostedRoute<{ appId: string }>(async (_req, { appId }) => {
  signedInOwner(appId);
  return { invites: listInvites(appId) };
});

export const POST = hostedRoute<{ appId: string }>(async (req, { appId }) => {
  const { identity } = await verifiedOwner(req, appId);
  const body = await readJsonBody(req, NewInvite);
  const issued = createInvite(appId, body, identity.subject);
  // The row is committed; the email is an effect performed after the answer.
  scheduleInviteDelivery();
  return hostedJson(issued, 201);
});
