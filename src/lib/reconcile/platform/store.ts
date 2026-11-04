/**
 * The platform-store-backed `ReconcileStore` and desired-graph loader
 * (ADR-0002). Thin: every statement that matters to tenancy, secrets or
 * ordering is a repository function in `@/lib/controlplane/db/repos`; what this
 * file adds is the ONE transaction a reconciliation commits in, the fence
 * assertion at its head, and the read of the repair operations the controller
 * paces itself against.
 *
 *  - Every read and write is scoped by `workspace_id` in SQL (the repositories
 *    refuse a wrong-tenant resource or environment; the direct queries here name
 *    the workspace themselves).
 *  - `commit` is atomic: observations, runtime, the drift report, the events and
 *    the first-seen map land together or not at all. With a fence, the lease is
 *    asserted FIRST in the same transaction (`FOR SHARE`), so a pass that lost
 *    its lease cannot write its stale view.
 *  - The repositories refuse secret-shaped values (`secret_material`); the
 *    controller scrubs before it gets here, so a refusal means a driver returned
 *    something the scrubber did not recognise, and failing loudly is correct.
 */
import type { Sql } from "@/lib/controlplane/types";
import type { OperationStatus } from "@/lib/controlplane/types";
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { textArray } from "@/lib/controlplane/db/sql";
import { ReconcileError } from "../errors";
import * as drift from "@/lib/controlplane/db/repos/drift";
import * as events from "@/lib/controlplane/db/repos/events";
import * as leases from "@/lib/controlplane/db/repos/leases";
import * as observations from "@/lib/controlplane/db/repos/observations";
import * as resources from "@/lib/controlplane/db/repos/resources";
import { graphDigestOf } from "@/lib/resources";
import type { PortableKind, ProviderKey, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { RECONCILER_PRINCIPAL, type ReconcileCommit, type ReconcileEnvironment, type ReconcileStore, type RepairOperationRef, type StoredResourceRef } from "../types";

const toRef = (r: resources.PlatformResource): StoredResourceRef => ({
  id: r.id,
  address: r.address,
  ownership: r.ownership,
  status: r.status,
  ...(r.externalId ? { externalId: r.externalId } : {}),
});

/** The desired graph of what is stored for the environment, or null when nothing is. Edges are not stored and drift does not use them. */
export async function loadGraphFromStore(db: Sql, environment: ReconcileEnvironment): Promise<ResourceGraph | null> {
  const rows = await resources.listByEnvironment(db, environment.workspaceId, environment.environmentId);
  if (rows.length === 0) return null;
  const nodes: ResourceNode[] = rows.map((r) => ({
    address: r.address,
    kind: r.kind as PortableKind | "provider_native",
    provider: r.provider as ProviderKey,
    region: r.region ?? environment.region,
    nativeType: r.nativeType,
    ownership: r.ownership,
    ...(r.externalId ? { externalRef: r.externalId } : {}),
    spec: r.spec,
    origin: r.origin,
    dependsOn: r.dependsOn,
    specDigest: r.specDigest,
    labels: r.labels,
  }));
  const revisions = new Set(rows.map((r) => r.revisionId ?? ""));
  return {
    version: 1,
    environmentId: environment.environmentId,
    manifestDigest: revisions.size === 1 ? ([...revisions][0] ?? "") : "",
    nodes,
    edges: [],
    graphDigest: graphDigestOf(nodes, []),
    notes: [],
  };
}

const OPEN_STATUSES: readonly OperationStatus[] = ["proposed", "awaiting_approval", "approved", "queued", "running", "uncertain"];
const MUTATING_CAPABILITIES = Object.values(CAPABILITIES).filter((c) => c.mutates).map((c) => c.name);

export function createPlatformStore(db: Sql): ReconcileStore {
  return {
    async listResources(environment) {
      const rows = await resources.listByEnvironment(db, environment.workspaceId, environment.environmentId, { includeDeleted: true });
      return rows.map(toRef);
    },

    async loadPrevious(environment) {
      const latest = await drift.latest(db, environment.workspaceId, environment.environmentId);
      if (!latest) return null;
      const state = await db.query<{ finding_since: Record<string, string> | null }>(
        "select finding_since from platform.reconcile_state where workspace_id = $1 and environment_id = $2",
        [environment.workspaceId, environment.environmentId]
      );
      return {
        report: {
          environmentId: latest.environmentId,
          graphDigest: latest.graphDigest,
          computedAt: latest.computedAt,
          findings: latest.findings,
          unobserved: latest.unobserved,
          simulated: latest.simulated,
        },
        findingSince: state[0]?.finding_since ?? {},
      };
    },

    async commit(commit: ReconcileCommit) {
      const { environment } = commit;
      const workspaceId = environment.workspaceId;
      await db.tx(async (tx) => {
        if (commit.fence) await leases.assertFence(tx, commit.fence.scope, commit.fence.token);
        for (const o of commit.observations) await observations.appendObservation(tx, { workspaceId, resourceId: o.resourceId, observation: o.observation });
        for (const r of commit.runtime) await observations.upsertRuntime(tx, { workspaceId, resourceId: r.resourceId, runtime: r.runtime });
        await drift.insert(tx, { workspaceId, report: commit.report });
        for (const e of commit.events) await events.append(tx, { ...e, workspaceId });
        // The row exists once the environment is registered; an unregistered environment (a one-off observe) simply keeps no first-seen map.
        await tx.query(
          `update platform.reconcile_state set finding_since = $3::text::jsonb, updated_at = clock_timestamp()
            where workspace_id = $1 and environment_id = $2`,
          [workspaceId, environment.environmentId, JSON.stringify(commit.findingSince)]
        );
      });
    },

    async appendEvents(environment, list) {
      for (const e of list) await events.append(db, { ...e, workspaceId: environment.workspaceId });
    },

    async listRepairOperations(environment, sinceIso) {
      const rows = await db.query<{ id: string; capability: string; resource_id: string | null; status: OperationStatus; created_at: string; principal_id: string | null; principal_kind: string | null }>(
        `select id, capability, resource_id, status, created_at, principal ->> 'id' as principal_id, principal ->> 'kind' as principal_kind
           from platform.operations
          where workspace_id = $1 and environment_id = $2
            and ((capability = 'drift.repair' and (status = any($3::text[]) or created_at >= $4::timestamptz))
              or (status = 'uncertain' and capability = any($5::text[])))
          order by seq desc
          limit 501`,
        [environment.workspaceId, environment.environmentId, textArray(OPEN_STATUSES), sinceIso, textArray(MUTATING_CAPABILITIES)]
      );
      // Never mistake a truncated ledger for evidence that no conflict exists.
      if (rows.length > 500) throw new ReconcileError("platform_store_unavailable", "Repair operation inventory exceeds the bounded complete read; proposals require inspection.");
      return rows.map(
        (r): RepairOperationRef => ({
          operationId: r.id,
          ...(r.resource_id ? { resourceId: r.resource_id } : {}),
          status: r.status,
          createdAt: r.created_at,
          byReconciler: r.principal_kind === RECONCILER_PRINCIPAL.kind && r.principal_id === RECONCILER_PRINCIPAL.id,
          ...(r.capability !== "drift.repair" ? { blocksEnvironment: true } : {}),
        })
      );
    },
  };
}
