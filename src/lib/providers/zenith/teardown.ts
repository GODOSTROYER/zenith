/**
 * Explicit managed-environment teardown under one tenant session. Workloads
 * reuse Kubernetes pruning; isolation survives until the final namespace
 * delete. Retention includes Secrets, PVCs and StatefulSets. TLS uses its
 * separate operator session, and database deletion uses the existing policy
 * gate and adapter ownership check, never a raw Neon project DELETE.
 *
 * The caller must hold the environment lease and attach a complete, trusted
 * database inventory (including removed resources) to session.teardown.
 * Approval flags must come from the approval flow for this exact operation.
 * Missing inventory is unknown, not an empty inventory. No store or global
 * credential lookup is performed here. Plain ZenithSession remains usable,
 * but cannot prove database teardown complete without this context.
 *
 * `deleted` means accepted deletion (would delete in dryRun), not observed
 * absence or completed Kubernetes garbage collection. Namespace deletion is
 * refused after incomplete discovery, failures, or foreign supported objects.
 * Unknown custom kinds are not inventoried: the namespace belongs exclusively
 * to this tenant. Live cluster and Neon behavior remain unverified; tests use
 * existing contract fakes. Reports contain object references only.
 */
import { createK8sClient, listObjects, ownedBy, readObject, toK8sError, type K8sClient } from "@/lib/providers/kubernetes/client";
import { pruneOrphans } from "@/lib/providers/kubernetes/prune";
import { APPLY_ORDER, K8sError, KIND_INFO, refOf, type ObjectRef } from "@/lib/providers/kubernetes/types";
import { managedDatabaseName, type DatabaseTarget } from "./database";
import { destroyManagedDatabase, type DestroyPolicy } from "./database-lifecycle";
import { dig, isRecord } from "./k8s-port";
import { assertSessionMatches, type ZenithSession } from "./session";
import { assertTenant } from "./substrate";
import { renderTenancy } from "./tenancy";
import { teardownZenithTls } from "./tls-lifecycle";
import type { TlsObjectClient } from "./tls-client";
import { TENANCY_ADDRESS, TENANT_ANNOTATION } from "./types";

export interface ZenithTeardownDatabase extends DestroyPolicy {
  address: string;
  externalId?: string;
}

/** Worker-bound context; never accept this inventory or its approval flags from browser input. */
export interface ZenithTeardownSession extends ZenithSession {
  readonly teardown?: {
    /** Complete tenant inventory; [] explicitly proves no managed databases are expected. */
    readonly databases?: readonly ZenithTeardownDatabase[];
    /** Contract test port; production uses gatewayKubernetes. */
    readonly tlsClient?: TlsObjectClient;
  };
}

export interface ZenithTeardownInput {
  workspaceId: string;
  environmentId: string;
  session: unknown;
  retainStateful: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface ZenithTeardownReport {
  deleted: string[];
  retained: string[];
  skipped: string[];
  uncertain: string[];
}

const key = (ref: Pick<ObjectRef, "kind" | "namespace" | "name">): string => `${ref.kind}/${ref.namespace ?? ""}/${ref.name}`;
const wildcard = (kind: string, namespace: string): string => `${kind}/${namespace}/*`;
const STATEFUL = new Set(["Secret", "PersistentVolumeClaim", "StatefulSet"]);
const safeName = (name: unknown): name is string => typeof name === "string" && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(name);

function sessionFor(input: ZenithTeardownInput): ZenithTeardownSession {
  const s = input.session;
  if (!isRecord(s) || s.provider !== "zenith" || !isRecord(s.tenant) || !isRecord(s.substrate)
    || !isRecord(s.kubernetes) || s.kubernetes.provider !== "kubernetes" || typeof s.kubernetes.kubeConfig !== "function"
    || !isRecord(s.databases) || typeof s.databases.get !== "function" || typeof s.databases.delete !== "function") {
    throw new K8sError("session_invalid", "Teardown requires a Zenith-managed tenant session.");
  }
  const session = s as unknown as ZenithTeardownSession;
  assertTenant(session.tenant);
  assertSessionMatches(session, input);
  if (typeof input.retainStateful !== "boolean" || (input.dryRun !== undefined && typeof input.dryRun !== "boolean")) {
    throw new K8sError("bad_input", "Teardown retention and dry-run flags must be booleans.");
  }
  const expiry = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiry)) throw new K8sError("session_invalid", "Teardown session has no valid expiry.");
  if (expiry <= Date.now()) throw new K8sError("session_expired", "Teardown session has expired.");
  if (session.teardown !== undefined) {
    if (!isRecord(session.teardown)) throw new K8sError("bad_input", "Invalid teardown context.");
    const databases = session.teardown.databases;
    if (databases !== undefined) {
      if (!Array.isArray(databases)) throw new K8sError("bad_input", "Invalid teardown database inventory.");
      const addresses = new Set<string>();
      for (const db of databases) {
        if (!isRecord(db) || typeof db.address !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(db.address)
          || typeof db.deletionPolicy !== "string" || !["deny", "approval", "allow"].includes(db.deletionPolicy)
          || (db.approved !== undefined && typeof db.approved !== "boolean")
          || (db.externalId !== undefined && (typeof db.externalId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(db.externalId)))
          || addresses.has(db.address)) {
          throw new K8sError("bad_input", "Invalid or duplicate teardown database entry.");
        }
        addresses.add(db.address);
      }
    }
  }
  return session;
}

function tenantOwned(live: Record<string, unknown>, session: ZenithSession): boolean {
  return ownedBy(live, session.tenant.environmentId).owned
    && dig(live, "metadata", "annotations", TENANT_ANNOTATION.workspaceId) === session.tenant.workspaceId;
}

/** An explicit delete, fenced by the listed UID and the freshly read resourceVersion. */
async function deleteOwned(client: K8sClient, ref: ObjectRef, listed: Record<string, unknown>, session: ZenithSession, dryRun: boolean): Promise<"deleted" | "skipped" | "uncertain"> {
  try {
    client.signal?.throwIfAborted();
    const live = await readObject(client, ref);
    if (!live) return "skipped";
    if (!tenantOwned(live, session) || (ref.kind === "Namespace" && dig(live, "metadata", "annotations", "zenith.dev/resource") !== TENANCY_ADDRESS.namespace)) return "skipped";
    if (dig(live, "metadata", "deletionTimestamp")) return "uncertain";
    const uid = dig(live, "metadata", "uid");
    const resourceVersion = dig(live, "metadata", "resourceVersion");
    if (typeof uid !== "string" || !uid || uid !== dig(listed, "metadata", "uid") || typeof resourceVersion !== "string" || !resourceVersion) return "uncertain";
    if (dryRun) return "deleted";
    await client.objects.delete(
      { apiVersion: ref.apiVersion, kind: ref.kind, metadata: { name: ref.name, ...(ref.namespace ? { namespace: ref.namespace } : {}) } },
      undefined, undefined, undefined, undefined, "Background", { preconditions: { uid, resourceVersion } }
    );
    return "deleted";
  } catch (error) {
    return toK8sError(error).code === "not_found" ? "skipped" : "uncertain";
  }
}

async function teardownDatabases(input: ZenithTeardownInput, session: ZenithTeardownSession, namespace: string, report: ZenithTeardownReport, blocked: boolean): Promise<void> {
  const databases = session.teardown?.databases;
  if (databases === undefined) {
    report.uncertain.push(wildcard("ManagedDatabase", namespace));
    return;
  }
  for (const database of [...databases].sort((a, b) => a.address.localeCompare(b.address))) {
    const target: DatabaseTarget = { workspaceId: input.workspaceId, environmentId: input.environmentId, address: database.address, externalId: database.externalId };
    const ref = key({ kind: "ManagedDatabase", namespace, name: managedDatabaseName(target) });
    if (input.retainStateful || database.deletionPolicy === "deny" || (database.deletionPolicy === "approval" && database.approved !== true)) {
      report.retained.push(ref);
      continue;
    }
    if (blocked) { report.uncertain.push(ref); continue; }
    try {
      input.signal?.throwIfAborted();
      if (input.dryRun) {
        const found = await session.databases.get(target, { signal: input.signal });
        report[!found.ok ? "uncertain" : found.value === null ? "skipped" : "deleted"].push(ref);
      } else {
        const result = await destroyManagedDatabase(session.databases, target, database, { signal: input.signal });
        report[!result.ok ? result.error.code === "forbidden" ? "retained" : "uncertain"
          : result.value.deleted ? "deleted" : result.value.alreadyAbsent ? "skipped" : "uncertain"].push(ref);
      }
    } catch {
      // Adapter errors can contain credential values; no external text leaves this boundary.
      report.uncertain.push(ref);
    }
  }
}

export async function teardownZenithEnvironment(input: ZenithTeardownInput): Promise<ZenithTeardownReport> {
  const session = sessionFor(input);
  const baseline = renderTenancy(session.tenant, session.substrate);
  const namespace = baseline.namespace;
  const namespaceRef: ObjectRef = { apiVersion: "v1", kind: "Namespace", name: namespace };
  const namespaceKey = key(namespaceRef);
  const report: ZenithTeardownReport = { deleted: [], retained: [], skipped: [], uncertain: [] };
  const baselineKeys = new Set(baseline.objects.map((object) => key(refOf(object))));
  const desired = [...baseline.objects];
  const stateful: { ref: ObjectRef; live: Record<string, unknown> }[] = [];
  let client: K8sClient | undefined;
  let namespaceLive: Record<string, unknown> | undefined;
  let discoveryComplete = true;
  let foreign = false;

  try {
    client = createK8sClient(session.kubernetes, { signal: input.signal, environmentId: input.environmentId });
    namespaceLive = await readObject(client, namespaceRef);
    if (namespaceLive && (!tenantOwned(namespaceLive, session)
      || dig(namespaceLive, "metadata", "annotations", "zenith.dev/resource") !== TENANCY_ADDRESS.namespace)) {
      // No workload, TLS or database writes under a conflicting namespace identity.
      return { ...report, skipped: [namespaceKey], uncertain: [wildcard("ManagedDatabase", namespace)] };
    }
    if (namespaceLive && dig(namespaceLive, "metadata", "deletionTimestamp")) {
      return { ...report, uncertain: [namespaceKey, wildcard("ManagedDatabase", namespace)] };
    }
    if (namespaceLive) {
      // Preserve the baseline throughout prune, including when stateful data remains.
      for (const kind of [...APPLY_ORDER].reverse()) {
        if (kind === "Namespace") continue;
        input.signal?.throwIfAborted();
        try {
          const listing = await listObjects(client, kind, namespace);
          if (listing.unavailable) report.skipped.push(wildcard(kind, namespace));
          if (listing.truncated) { discoveryComplete = false; report.uncertain.push(wildcard(kind, namespace)); }
          for (const live of listing.items) {
            const name = dig(live, "metadata", "name");
            if (!safeName(name) || dig(live, "metadata", "namespace") !== namespace || live.kind !== kind || live.apiVersion !== KIND_INFO[kind].apiVersion) {
              discoveryComplete = false;
              report.uncertain.push(wildcard(kind, namespace));
              continue;
            }
            const ref: ObjectRef = { apiVersion: KIND_INFO[kind].apiVersion, kind, namespace, name };
            const object = { apiVersion: ref.apiVersion, kind, metadata: { name, namespace } };
            if (!tenantOwned(live, session)) {
              foreign = true;
              desired.push(object);
              report.skipped.push(key(ref));
            } else if (baselineKeys.has(key(ref))) {
              report.retained.push(key(ref));
            } else if (dig(live, "metadata", "deletionTimestamp")) {
              desired.push(object);
              report.uncertain.push(key(ref));
            } else if (STATEFUL.has(kind) && input.retainStateful) {
              desired.push(object);
              report.retained.push(key(ref));
            } else if (kind === "StatefulSet" || kind === "PersistentVolumeClaim") {
              stateful.push({ ref, live });
            }
          }
        } catch {
          discoveryComplete = false;
          report.uncertain.push(wildcard(kind, namespace));
        }
      }
      if (discoveryComplete) {
        const pruned = await pruneOrphans({ desired, environmentId: input.environmentId, namespaces: [namespace], dryRun: input.dryRun }, session.kubernetes, { signal: input.signal });
        report.deleted.push(...pruned.deleted.map(key));
        report.retained.push(...pruned.retained.map(({ ref }) => key(ref)));
        const plannedStateful = new Set(stateful.map(({ ref }) => key(ref)));
        if (pruned.retained.some(({ ref }) => !plannedStateful.has(key(ref)))) foreign = true;
        report.uncertain.push(...pruned.failed.map(({ ref }) => key(ref)));
        report.skipped.push(...pruned.skippedKinds.map((kind) => wildcard(kind, namespace)));
        if (pruned.truncated) report.uncertain.push(wildcard("Namespace", namespace));
        if (!input.retainStateful && !input.signal?.aborted && report.uncertain.length === 0) {
          for (const item of stateful) {
            const outcome = await deleteOwned(client, item.ref, item.live, session, input.dryRun === true);
            report[outcome].push(key(item.ref));
            if (outcome !== "deleted") { foreign = true; break; }
          }
        }
      }
    } else {
      report.skipped.push(namespaceKey);
    }
  } catch {
    discoveryComplete = false;
    report.uncertain.push(namespaceKey);
  }

  if (!input.signal?.aborted) {
    try {
      const tls = await teardownZenithTls({ session, expect: input, tlsClient: session.teardown?.tlsClient, dryRun: input.dryRun, signal: input.signal });
      for (const result of tls.results) {
        report[result.status === "deleted" ? "deleted" : result.status === "absent" || result.status === "ownership_conflict" ? "skipped" : "uncertain"].push(key(result.ref));
      }
      if (!tls.ok) discoveryComplete = false;
    } catch {
      discoveryComplete = false;
      report.uncertain.push(wildcard("Gateway", session.substrate.gateway.namespace));
    }
  } else {
    discoveryComplete = false;
    report.uncertain.push(namespaceKey);
  }
  await teardownDatabases(input, session, namespace, report, !discoveryComplete || report.uncertain.length > 0 || input.signal?.aborted === true);

  if (namespaceLive) {
    if (input.retainStateful || !discoveryComplete || foreign || report.uncertain.length > 0 || input.signal?.aborted || !client) {
      report.retained.push(namespaceKey);
    } else {
      const outcome = await deleteOwned(client, namespaceRef, namespaceLive, session, input.dryRun === true);
      report[outcome].push(namespaceKey);
      if (outcome === "deleted") report.retained = report.retained.filter((ref) => !baselineKeys.has(ref));
    }
  }
  // One deterministic classification per object; uncertainty takes precedence.
  const seen = new Set<string>();
  for (const bucket of ["uncertain", "deleted", "retained", "skipped"] as const) {
    report[bucket] = [...new Set(report[bucket])].filter((ref) => !seen.has(ref)).sort();
    report[bucket].forEach((ref) => seen.add(ref));
  }
  return report;
}
