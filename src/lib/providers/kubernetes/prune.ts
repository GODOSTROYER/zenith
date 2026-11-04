/**
 * Orphan pruning: delete what Zenith owns and the environment no longer wants.
 *
 * An object is deleted only when ALL of these hold, checked on the live object
 * immediately before the delete:
 *   - label `app.kubernetes.io/managed-by: zenith`
 *   - annotation `zenith.dev/environment` equals THIS environment
 *   - it is not in the desired set
 *   - its kind is not in `NEVER_AUTO_PRUNE`
 *   - it is not already terminating
 * and the delete carries a `uid` precondition, so an object replaced between
 * the check and the delete is left alone. Objects owned by nobody, by another
 * environment, or by another tool are never touched and never listed.
 *
 * `NEVER_AUTO_PRUNE` (PersistentVolumeClaim, StatefulSet, Namespace): data
 * rollback cannot restore, and a namespace delete cascades to objects Zenith
 * does not own. Such orphans are REPORTED in `retained`.
 *
 * Only the namespaces passed in are scanned, and each must pass the allowlist.
 * A kind the cluster does not serve (CRD not installed) is skipped and named.
 */
import type { V1DeleteOptions } from "@kubernetes/client-node";
import type { KubernetesSession } from "@/lib/credentials/types";
import { createK8sClient, listObjects, ownedBy, readObject, toK8sError, type K8sClient } from "./client";
import {
  APPLY_ORDER,
  K8sError,
  KIND_INFO,
  LABEL,
  MANAGED_BY_VALUE,
  NEVER_AUTO_PRUNE,
  refKey,
  refOf,
  type K8sErrorCode,
  type ObjectRef,
  type SupportedKind,
} from "./types";
import { dig, sortedUnique } from "./util";

export interface PruneInput {
  /** what the environment wants now; anything Zenith owns outside this set is an orphan */
  desired: readonly { kind: string; metadata: { name: string; namespace?: string } }[];
  environmentId: string;
  /** the namespaces the environment occupies; only these are scanned */
  namespaces: readonly string[];
  /** report what would be deleted without deleting */
  dryRun?: boolean;
}

export interface PruneReport {
  dryRun: boolean;
  /** deleted (or, in a dry run, would be deleted) */
  deleted: ObjectRef[];
  /** orphans deliberately left in place, with why */
  retained: { ref: ObjectRef; reason: string }[];
  failed: { ref: ObjectRef; code: K8sErrorCode; message: string }[];
  /** kinds the cluster does not serve (for example a missing CRD) */
  skippedKinds: string[];
  /** a listing hit its page bound; more orphans may exist */
  truncated: boolean;
}

export interface PruneOptions {
  signal?: AbortSignal;
  log?: (line: string) => void;
  requestTimeoutMs?: number;
}

const SELECTOR = `${LABEL.managedBy}=${MANAGED_BY_VALUE}`;

/** Children first: reverse of apply order. */
const PRUNE_KINDS: readonly SupportedKind[] = [...APPLY_ORDER].reverse();

async function deleteOne(client: K8sClient, ref: ObjectRef, uid: string, environmentId: string): Promise<"deleted" | "gone" | K8sError> {
  try {
    const fresh = await readObject(client, ref);
    if (!fresh) return "gone";
    const own = ownedBy(fresh, environmentId);
    if (!own.owned) return new K8sError("ownership_conflict", `${ref.kind}/${ref.name} no longer carries this environment's ownership marks; left alone.`);
    if (dig(fresh, "metadata", "uid") !== uid) return new K8sError("ownership_conflict", `${ref.kind}/${ref.name} was replaced; left alone.`);
    const body: V1DeleteOptions = { preconditions: { uid } };
    await client.objects.delete(
      { apiVersion: ref.apiVersion, kind: ref.kind, metadata: { name: ref.name, ...(ref.namespace ? { namespace: ref.namespace } : {}) } },
      undefined,
      undefined,
      undefined,
      undefined,
      "Background",
      body
    );
    return "deleted";
  } catch (e) {
    const err = toK8sError(e);
    return err.code === "not_found" ? "gone" : err;
  }
}

export async function pruneOrphans(input: PruneInput, session: KubernetesSession, opts: PruneOptions = {}): Promise<PruneReport> {
  const dryRun = input.dryRun === true;
  const client = createK8sClient(session, { signal: opts.signal, environmentId: input.environmentId, requestTimeoutMs: opts.requestTimeoutMs });
  const desired = new Set(input.desired.map((o) => refKey({ kind: o.kind, namespace: o.metadata.namespace, name: o.metadata.name })));
  const scan = sortedUnique(input.namespaces);
  const report: PruneReport = { dryRun, deleted: [], retained: [], failed: [], skippedKinds: [], truncated: false };
  const skipped = new Set<string>();

  for (const ns of scan) {
    try {
      await client.guard.assert(ns);
    } catch (e) {
      const err = toK8sError(e);
      if (err.code === "not_found") continue; // nothing there to prune
      report.failed.push({ ref: { apiVersion: "v1", kind: "Namespace", name: ns }, code: err.code, message: err.message });
      continue;
    }
    for (const kind of PRUNE_KINDS) {
      if (opts.signal?.aborted) return report;
      if (kind === "Namespace") continue; // handled once, below
      let listing;
      try {
        listing = await listObjects(client, kind, ns, { labelSelector: SELECTOR });
      } catch (e) {
        const err = toK8sError(e);
        report.failed.push({ ref: { apiVersion: KIND_INFO[kind].apiVersion, kind, namespace: ns, name: "*" }, code: err.code, message: err.message });
        continue;
      }
      if (listing.unavailable) skipped.add(kind);
      if (listing.truncated) report.truncated = true;
      for (const item of listing.items) {
        const ref = refOf(item as Parameters<typeof refOf>[0]);
        if (desired.has(refKey(ref))) continue;
        if (!ownedBy(item, input.environmentId).owned) continue;
        if (dig(item, "metadata", "deletionTimestamp")) continue;
        if ((NEVER_AUTO_PRUNE as readonly string[]).includes(kind)) {
          report.retained.push({ ref, reason: `${kind} is never pruned automatically (it holds data or cascades); remove it deliberately.` });
          continue;
        }
        if (dryRun) {
          report.deleted.push(ref);
          continue;
        }
        const uid = dig(item, "metadata", "uid");
        if (typeof uid !== "string") {
          report.failed.push({ ref, code: "api_error", message: `${kind}/${ref.name} has no uid; not deleted.` });
          continue;
        }
        const r = await deleteOne(client, ref, uid, input.environmentId);
        if (r === "deleted" || r === "gone") {
          report.deleted.push(ref);
          opts.log?.(`kubernetes prune deleted ${kind}/${ref.name} in ${ns}`);
        } else {
          report.failed.push({ ref, code: r.code, message: r.message });
        }
      }
    }
  }

  // Namespaces the environment owns but no longer wants are reported, never deleted.
  try {
    const nsListing = await listObjects(client, "Namespace", undefined, { labelSelector: SELECTOR });
    for (const item of nsListing.items) {
      const ref = refOf(item as Parameters<typeof refOf>[0]);
      if (!scan.includes(ref.name) || desired.has(refKey(ref)) || !ownedBy(item, input.environmentId).owned) continue;
      report.retained.push({ ref, reason: "Namespace is never pruned automatically: deleting it would cascade to everything inside, including objects Zenith does not own." });
    }
  } catch (e) {
    const err = toK8sError(e);
    if (err.code !== "forbidden") report.failed.push({ ref: { apiVersion: "v1", kind: "Namespace", name: "*" }, code: err.code, message: err.message });
  }
  report.skippedKinds = [...skipped].sort();
  report.deleted.sort((a, b) => refKey(a).localeCompare(refKey(b)));
  report.retained.sort((a, b) => refKey(a.ref).localeCompare(refKey(b.ref)));
  return report;
}
