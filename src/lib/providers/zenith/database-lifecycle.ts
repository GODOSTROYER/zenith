/**
 * The lifecycle of a managed database as the declarative apply sees it:
 * converge on existence (`ensureManagedDatabases`) and remove under policy
 * (`destroyManagedDatabase`).
 *
 * Stateful safety (driver conventions, "Stateful resources"): a database is
 * never deleted by an automatic path. `deletionPolicy` decides:
 *   deny      never; the call is refused.
 *   approval  only with an explicit `approved: true` the caller got from the
 *             approval flow; otherwise refused.
 *   allow     permitted.
 * The provider adapter additionally refuses to delete a project that is not
 * the one Zenith created for the tuple. The provider's own recovery window
 * (Neon: 7 days) is a safety net, not a substitute for this check.
 */
import {
  dbError,
  type DatabaseError,
  type DatabaseResult,
  type DatabaseTarget,
  type ManagedDatabaseInfo,
  type ManagedDatabaseProvider,
} from "./database";
import type { ManagedDatabaseIntent } from "./render";

export interface EnsureDatabaseOutcome {
  address: string;
  status: "created" | "exists" | "planned" | "failed";
  connectionSecretRef: string;
  info?: ManagedDatabaseInfo;
  error?: DatabaseError;
}

/**
 * Create each database that does not exist. With `dryRun` nothing is called and
 * every intent is `planned`, except that an unavailable provider is reported as
 * `failed` so a plan shows the blocker up front. Stops at the first failure:
 * later databases are not attempted.
 */
export async function ensureManagedDatabases(
  intents: readonly ManagedDatabaseIntent[],
  provider: ManagedDatabaseProvider,
  opts: { dryRun?: boolean; signal?: AbortSignal } = {}
): Promise<EnsureDatabaseOutcome[]> {
  const outcomes: EnsureDatabaseOutcome[] = [];
  if (intents.length === 0) return outcomes;
  const availability = provider.availability();
  if (!availability.available) {
    return intents.map((i) => ({
      address: i.address,
      status: "failed",
      connectionSecretRef: i.connectionSecretRef,
      error: { code: "unavailable", message: availability.reason, retryable: false },
    }));
  }
  let stopped = false;
  for (const intent of intents) {
    if (stopped) {
      outcomes.push({ address: intent.address, status: "failed", connectionSecretRef: intent.connectionSecretRef, error: { code: "aborted", message: "Not attempted: an earlier database failed.", retryable: true } });
      continue;
    }
    if (opts.dryRun === true) {
      outcomes.push({ address: intent.address, status: "planned", connectionSecretRef: intent.connectionSecretRef });
      continue;
    }
    const r = await provider.create(intent.spec, { signal: opts.signal });
    if (!r.ok) {
      stopped = true;
      outcomes.push({ address: intent.address, status: "failed", connectionSecretRef: intent.connectionSecretRef, error: r.error });
      continue;
    }
    const { created, ...info } = r.value;
    outcomes.push({ address: intent.address, status: created ? "created" : "exists", connectionSecretRef: info.connectionSecretRef, info });
  }
  return outcomes;
}

export interface DestroyPolicy {
  deletionPolicy: "deny" | "approval" | "allow";
  /** true only when the approval flow granted this exact deletion */
  approved?: boolean;
}

/** Delete the database under its deletion policy. Refusals are `forbidden`, not throws. */
export async function destroyManagedDatabase(
  provider: ManagedDatabaseProvider,
  target: DatabaseTarget,
  policy: DestroyPolicy,
  opts: { signal?: AbortSignal } = {}
): Promise<DatabaseResult<{ deleted: boolean; alreadyAbsent: boolean }>> {
  if (policy.deletionPolicy === "deny") {
    return dbError("forbidden", "This database's deletion policy is deny; it is never deleted by Zenith. Change the policy through an approved change first.", false);
  }
  if (policy.deletionPolicy === "approval" && policy.approved !== true) {
    return dbError("forbidden", "Deleting this database needs an approval; none was granted for this operation.", false);
  }
  return provider.delete(target, opts);
}
