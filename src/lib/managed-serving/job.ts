/**
 * The durable `managed-serving` critical job (PROD-MAN-03), run inside the critical-maintenance Temporal schedule under the
 * same fenced `critical-job:managed-serving` lease and run record as every other critical job.
 *
 * Each tick, level-triggered and idempotent:
 *   1. custom-domain renewal: re-verify every claim whose DNS proof expires within the renewal window (or already has);
 *      unrenewable proofs lapse after their grace period, and the next apply stops serving them.
 *   2. object-store key revocations still owed (`revoke_pending`): retried through the storage admin port. The admin credential
 *      is a PLATFORM secret, and no platform-credential resolver is composed into the worker yet (PROD-MAN-01 supplies the
 *      session composition root), so without an injected port this step REFUSES explicitly and counts what it could not do
 *      (`revocationsBlocked`) instead of silently skipping it. Revocations are also attempted inline at every apply and
 *      rotation, where the resolver exists.
 */
import { repos } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { renewalPass, type RenewalResult } from "./domain-service";
import { systemDomainDns, type DomainDnsPort } from "./domains";
import type { ObjectStorageAdminPort } from "./storage";

export interface ManagedServingResult extends RenewalResult {
  revocationsOwed: number;
  revoked: number;
  revocationsBlocked: number;
}

export interface ManagedServingOptions {
  dns?: DomainDnsPort;
  clock?: () => Date;
  /** The storage admin port, when a platform credential resolver is composed; absent = revocations are blocked and counted. */
  storageAdmin?: ObjectStorageAdminPort;
  baseDomain?: string;
  budgetMs?: number;
  signal?: AbortSignal;
}

export async function managedServingPass(db: Sql, options: ManagedServingOptions = {}): Promise<ManagedServingResult> {
  const renewal = await renewalPass(
    { sql: db, dns: options.dns ?? systemDomainDns(), baseDomain: options.baseDomain ?? process.env.ZENITH_MANAGED_APP_DOMAIN ?? "", clock: options.clock },
    { budgetMs: options.budgetMs, signal: options.signal },
  );
  const pending = await repos.managedServing.listRevokePending(db, { limit: 50 });
  let revoked = 0;
  let blocked = 0;
  const admin = options.storageAdmin;
  if (!admin || !admin.availability().available) blocked = pending.length;
  else {
    for (const key of pending) {
      options.signal?.throwIfAborted();
      const r = await admin.deleteAccessKey(key.principalName, key.accessKeyId, { signal: options.signal });
      if (r.ok) { await repos.managedServing.markStorageKeyRevoked(db, key.workspaceId, key.id, options.clock ? options.clock() : new Date()); revoked++; }
      else blocked++;
    }
  }
  return { ...renewal, revocationsOwed: pending.length, revoked, revocationsBlocked: blocked };
}
