/**
 * `GET|PUT|DELETE /api/workspace/retention-destination` - where this workspace's retention archives go (PROD-OPS-07).
 *
 * A workspace admin points archives at storage the workspace owns, the LIFE-11 way: an `object_store` resource of one of
 * its environments plus a vault credentials reference (never the secret itself). The credentials are read through the
 * brokered workspace secret path, the bucket must be that resource's bucket, and a marker is written and read back before
 * the destination is accepted. While one is active, new archives of this workspace go to it; with none, they go to the
 * operator's storage. A configured destination that stops working pauses archiving for this workspace; it never falls back.
 *
 *   GET                                   the active destination (no secrets) and whether an operator fallback exists
 *   PUT { environmentId, resourceAddress, credentialsRef }   validate, then replace the active destination
 *   DELETE                                revoke it (archives written there stay readable while the credentials resolve)
 */
import { z } from "zod";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { log } from "@/lib/log";
import { ApiError, route } from "@/lib/server/context";
import { json } from "@/lib/server/errors";
import { sharingActor } from "@/lib/server/workspace-sharing";
import { requireWorkspace } from "@/lib/server/workspace";
import { sameOrigin } from "@/lib/waitlist/http";
import { archiveTargetFromEnv } from "@/lib/retention/archive";
import { createDestination, getActiveDestination, revokeDestination } from "@/lib/retention/destination";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  environmentId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  resourceAddress: z.string().min(1).max(300),
  credentialsRef: z.string().regex(/^vault:[^\s\\%]{1,1000}$/),
}).strict();

async function store() {
  const { platformDb } = await import("@/lib/controlplane/db");
  try { return await platformDb(); } catch { throw new ApiError("The platform control store is unavailable.", 503); }
}

const view = (d: Awaited<ReturnType<typeof getActiveDestination>>) => ({
  destination: d ? { id: d.id, environmentId: d.environmentId, resourceAddress: d.resourceAddress, bucket: d.bucket, createdBy: d.createdBy, createdAt: d.createdAt } : null,
  operatorFallback: archiveTargetFromEnv().ok,
});

export const GET = route({ workspaceRole: "admin" }, async () => json(view(await getActiveDestination(await store(), requireWorkspace().id))));

export const PUT = route({ workspaceRole: "admin" }, async (req) => {
  sameOrigin(req);
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) throw new ApiError("Send { environmentId, resourceAddress, credentialsRef } with credentialsRef as a vault: reference.", 400);
  const workspaceId = requireWorkspace().id;
  const actor = sharingActor();
  try {
    const created = await createDestination(await store(), { workspaceId, ...parsed.data, actor: actor.actorId });
    log.info("retention destination set", { scope: "retention", workspaceId, destinationId: created.id, actor: actor.actorId });
    return json(view(created));
  } catch (error) {
    if (error instanceof ControlStoreError && error.code === "invalid_input") throw new ApiError(error.message, 400);
    throw error;
  }
});

export const DELETE = route({ workspaceRole: "admin" }, async (req) => {
  sameOrigin(req);
  const workspaceId = requireWorkspace().id;
  const actor = sharingActor();
  const revoked = await revokeDestination(await store(), workspaceId, actor.actorId);
  if (revoked) log.info("retention destination revoked", { scope: "retention", workspaceId, destinationId: revoked.id, actor: actor.actorId });
  return json(view(null));
});
