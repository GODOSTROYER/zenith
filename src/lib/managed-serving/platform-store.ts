/**
 * The join between the managed provider's apply and the platform store (PROD-MAN-02/03).
 *
 * `loadServingInputs` is what the composition root that opens a managed session (PROD-MAN-01) calls per environment, so the
 * session and the apply see exactly the custom domains whose proof is currently valid and the ones to retire.
 * `platformStorageKeyStore` binds the object-store key records to one workspace and environment.
 */
import { repos } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { GRACE_MS } from "./domains";
import type { StorageKeyStore } from "./storage";

export interface ServingInputs {
  /** hostnames the environment may serve now (verified and inside proof plus grace) */
  verifiedDomains: string[];
  /** hostnames that lapsed or were revoked and are not served: their listener, certificate and key are removed on apply */
  retiredDomains: string[];
}

export async function loadServingInputs(sql: Sql, tenant: { workspaceId: string; environmentId: string }, clock: () => Date = () => new Date()): Promise<ServingInputs> {
  const now = clock();
  const [served, all] = await Promise.all([
    repos.managedServing.verifiedHostnames(sql, tenant.workspaceId, tenant.environmentId, { now, graceMs: GRACE_MS }),
    repos.managedServing.listDomains(sql, tenant.workspaceId, tenant.environmentId, { limit: 200 }),
  ]);
  const serving = new Set(served);
  const retired = new Set(all.filter((d) => (d.status === "lapsed" || d.status === "revoked" || d.status === "verified") && !serving.has(d.hostname)).map((d) => d.hostname));
  return { verifiedDomains: served, retiredDomains: [...retired].sort() };
}

export function platformStorageKeyStore(sql: Sql, workspaceId: string, environmentId: string): StorageKeyStore {
  return {
    active: (address) => repos.managedServing.activeStorageKey(sql, workspaceId, environmentId, address),
    known: async (address) => (await repos.managedServing.listStorageKeys(sql, workspaceId, environmentId, { limit: 200 })).filter((k) => k.address === address && k.status !== "revoked"),
    record: (input) => repos.managedServing.recordStorageKey(sql, { ...input, workspaceId, environmentId }),
    async markRevoked(id) { await repos.managedServing.markStorageKeyRevoked(sql, workspaceId, id, new Date()); },
  };
}
