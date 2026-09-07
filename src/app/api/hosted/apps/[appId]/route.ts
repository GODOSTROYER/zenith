/**
 * One hosted app: what it is, what it is serving, what it has served, and what
 * is happening to it right now.
 *
 * Grants and invitations are attached only for an owner. Everyone else in the
 * workspace can see that the app exists and what it is running — that is what
 * makes a shared workspace usable — but who has access to a private app is the
 * owner's business, and a viewer reading the recipient list would be a leak
 * dressed as a convenience.
 *
 * Workstream W7 (hosted R3).
 */
import { appSummary, requireOwnedApp } from "@/lib/hosted/release";
import {
  actorOf,
  hostedRoute,
  isAppOwner,
  ownerOnlyBlock,
  requireWorkspaceRole,
} from "@/lib/hosted/release/http";
import { requireWorkspace } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = hostedRoute<{ appId: string }>(async (req, { appId }) => {
  const actor = await actorOf(req);
  requireWorkspaceRole(actor, "viewer");
  const app = requireOwnedApp(appId, requireWorkspace().id);
  const summary = appSummary(app.id);
  return isAppOwner(app.id, actor) ? { ...summary, ...ownerOnlyBlock(app.id) } : summary;
});
