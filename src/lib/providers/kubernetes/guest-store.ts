/** Tenant-bound adapter from the guest port to `repos.k8sGuestBindings` (every call carries the workspace). */
import { repos } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import type { GuestBindingRef, GuestStorePort } from "./guest";

const ref = (b: { id: string; status: GuestBindingRef["status"]; namespace: string; profile: GuestBindingRef["profile"]; objectName: string } | null): GuestBindingRef | null =>
  b ? { id: b.id, status: b.status, namespace: b.namespace, profile: b.profile, objectName: b.objectName } : null;

export function createGuestStore(sql: Sql, workspaceId: string): GuestStorePort {
  const r = repos.k8sGuestBindings;
  return {
    ensureBinding: async (input) => ref(await r.ensure(sql, { workspaceId, ...input })),
    markActive: async (id, saUid) => ref(await r.markActive(sql, workspaceId, id, saUid)),
    recordIssuance: (id, expiresAt) => r.recordIssuance(sql, workspaceId, id, expiresAt),
    recordError: (id, code) => r.recordError(sql, workspaceId, id, code),
    markRevoking: (id) => r.markRevoking(sql, workspaceId, id),
    markRevoked: (id) => r.markRevoked(sql, workspaceId, id),
    listOpen: async (connectionId) => (await r.listOpen(sql, workspaceId, connectionId)).map((b) => ref(b)!),
  };
}
