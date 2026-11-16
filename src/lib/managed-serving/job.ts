/**
 * The durable `managed-serving` critical job (PROD-MAN-03), run inside the critical-maintenance Temporal schedule under the
 * same fenced `critical-job:managed-serving` lease and run record as every other critical job.
 *
 * Each tick, level-triggered and idempotent:
 *   1. custom-domain renewal: re-verify every claim whose DNS proof expires within the renewal window (or already has);
 *      unrenewable proofs lapse after their grace period, and the next apply stops serving them.
 *   2. owed object-store key revocations (`revoke_pending`). The admin credential is reached ONLY through the credential
 *      broker (`createStateSessionPort(platformCredentialBroker(db))`, the path state restore uses): a verified AWS connection
 *      named by `ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CONNECTION`, so custody modes, revocation and audit are the broker's, and
 *      the session is narrowed to deleting and listing `zenith-t-*` users' keys. Each key is deleted and then READ BACK
 *      (listed); only an observed absence marks it revoked. If no session can be obtained, or a key is still there, the key
 *      stays owed AND an operator-visible incident is opened and escalated through the OBS-03 stability store (one incident per
 *      store address, deduplicated by fingerprint); a later successful revocation reports the signal good so it clears.
 */
import { createHash, randomUUID } from "node:crypto";
import { repos } from "@/lib/controlplane/db";
import type { ManagedStorageKey } from "@/lib/controlplane/db/repos/managed-serving";
import type { Sql } from "@/lib/controlplane/types";
import { CredentialDeniedError } from "@/lib/credentials/types";
import { incidentFingerprint, resolveStabilityPolicy } from "@/lib/incidents/stability";
import { platformCredentialBroker } from "@/lib/platform/credentials";
import { createStateSessionPort } from "@/lib/platform/state-session";
import { readSubstrateConfig } from "@/lib/providers/zenith/substrate";
import { renewalPass, type RenewalResult } from "./domain-service";
import { systemDomainDns, type DomainDnsPort } from "./domains";
import { createBrokeredIamAdminPort, wrapIamClient, type ObjectStorageAdminPort } from "./storage";

export interface ManagedServingResult extends RenewalResult {
  revocationsOwed: number;
  revoked: number;
  /** owed and still owed after this pass (no session, or the key was still present on readback) */
  revocationsBlocked: number;
  /** incidents opened or kept open and escalated this pass */
  alertsRaised: number;
}

export interface ManagedServingOptions {
  dns?: DomainDnsPort;
  clock?: () => Date;
  /** Test/composition override of the storage admin port; production resolves it through the credential broker. */
  storageAdmin?: ObjectStorageAdminPort;
  baseDomain?: string;
  budgetMs?: number;
  signal?: AbortSignal;
}

const SESSION_POLICY = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: ["iam:DeleteAccessKey", "iam:ListAccessKeys"], Resource: "arn:aws:iam::*:user/zenith-t-*" }],
} as const;

/** The admin port over the brokered session, or undefined when the platform names no admin connection. */
function brokeredAdmin(db: Sql): ObjectStorageAdminPort | undefined {
  const cfg = readSubstrateConfig(process.env);
  const connection = cfg.configured ? cfg.substrate.objectStorage?.adminConnection : undefined;
  if (!connection) return undefined;
  const withSession = createStateSessionPort(platformCredentialBroker(db));
  return createBrokeredIamAdminPort(async (fn) => {
    const stored = await repos.connections.get(db, connection.workspaceId, connection.connectionId);
    if (!stored || stored.status !== "verified") throw new CredentialDeniedError("The platform storage connection is missing, unverified or revoked.");
    return withSession({
      workspaceId: connection.workspaceId, projectId: "platform", environmentId: "platform", connectionId: connection.connectionId, principalId: "managed-serving",
      purpose: "deploy", correlation: `managed-serving-${randomUUID()}`, digest: createHash("sha256").update("managed-serving.storage-key-revocation").digest("hex"),
      sessionPolicy: SESSION_POLICY as unknown as Record<string, unknown>,
    }, async (session) => {
      if (session.provider !== "aws") throw new CredentialDeniedError("The platform storage connection is not an AWS connection.");
      const mod = await import("@aws-sdk/client-iam");
      return fn(wrapIamClient(mod, session.client(mod.IAMClient as never) as never));
    });
  });
}

async function raiseAlert(db: Sql, key: ManagedStorageKey, now: Date, why: string): Promise<boolean> {
  const fingerprint = incidentFingerprint({ workspaceId: key.workspaceId, environmentId: key.environmentId, problem: "managed_storage_key_revocation_owed", subject: key.address });
  const result = await repos.incidentStability.observeSignal(db, {
    workspaceId: key.workspaceId, environmentId: key.environmentId, fingerprint, observation: "bad", now,
    policy: resolveStabilityPolicy({ hysteresis: { openAfter: 1, clearAfter: 1 } }),
    incident: { title: "A tenant object-store credential could not be revoked", severity: "high", source: "managed-serving", summary: `An owed access key revocation for ${key.address} is still pending: ${why}. The key keeps working until it is revoked.`, document: { address: key.address, reason: why } },
  });
  if (!result.incident) return false;
  await repos.incidentStability.escalateIncident(db, { workspaceId: key.workspaceId, incidentId: result.incident.id, reasons: ["remediation_requires_human"], now });
  return true;
}

async function clearAlert(db: Sql, key: ManagedStorageKey, now: Date): Promise<void> {
  const fingerprint = incidentFingerprint({ workspaceId: key.workspaceId, environmentId: key.environmentId, problem: "managed_storage_key_revocation_owed", subject: key.address });
  await repos.incidentStability.observeSignal(db, {
    workspaceId: key.workspaceId, environmentId: key.environmentId, fingerprint, observation: "good", now,
    policy: resolveStabilityPolicy({ hysteresis: { openAfter: 1, clearAfter: 1 } }),
  }).catch(() => undefined);
}

export async function managedServingPass(db: Sql, options: ManagedServingOptions = {}): Promise<ManagedServingResult> {
  const clock = options.clock ?? (() => new Date());
  const renewal = await renewalPass(
    { sql: db, dns: options.dns ?? systemDomainDns(), baseDomain: options.baseDomain ?? process.env.ZENITH_MANAGED_APP_DOMAIN ?? "", clock: options.clock },
    { budgetMs: options.budgetMs, signal: options.signal },
  );
  const pending = await repos.managedServing.listRevokePending(db, { limit: 50 });
  const admin = options.storageAdmin ?? brokeredAdmin(db);
  let revoked = 0;
  let blocked = 0;
  let alerts = 0;
  for (const key of pending) {
    options.signal?.throwIfAborted();
    const now = clock();
    let why = admin ? "" : "no platform storage connection is configured (ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CONNECTION)";
    if (admin) {
      const deleted = await admin.deleteAccessKey(key.principalName, key.accessKeyId, { signal: options.signal });
      if (!deleted.ok) why = deleted.error.code === "unavailable" ? "the platform credential session could not be obtained" : `the provider refused the revocation (${deleted.error.code})`;
      else {
        const readback = await admin.listAccessKeys(key.principalName, { signal: options.signal });
        if (!readback.ok) why = "the revocation could not be read back";
        else if (readback.value.includes(key.accessKeyId)) why = "the key was still present when read back";
      }
    }
    if (why === "") {
      await repos.managedServing.markStorageKeyRevoked(db, key.workspaceId, key.id, now);
      revoked++;
      await clearAlert(db, key, now);
    } else {
      blocked++;
      if (await raiseAlert(db, key, now, why).catch(() => false)) alerts++;
    }
  }
  return { ...renewal, revocationsOwed: pending.length, revoked, revocationsBlocked: blocked, alertsRaised: alerts };
}
