/**
 * Resources: the DESIRED half of the resource model plus explicit ownership
 * (ADR-0003). Observed and runtime state live beside it (`observations.ts`,
 * `runtime.ts`) and are never merged into this row: desired, observed and
 * runtime are three different questions.
 *
 *  - Identity is `(environment_id, address)`; `upsertDesired` keeps the same
 *    resource id across updates.
 *  - **Ownership is explicit and never inferred.** `upsertDesired` refuses to
 *    change a resource's ownership as a side effect (`conflict`); only
 *    `changeOwnership` does, deliberately. Only `managed` resources are ever
 *    candidates for repair or destroy — enforcing that is the policy layer's
 *    job, but the column it reads is authoritative.
 *  - An environment belongs to exactly one workspace: an upsert that names an
 *    environment already holding rows of another workspace is refused
 *    (`tenant_mismatch`).
 *  - `spec` holds references only (`{ "secretRef": "vault:…" }`), never secret
 *    values; literal key material is refused.
 */
import type { Sql } from "@/lib/controlplane/types";
import type { ResourceNode, ResourceOwnership } from "@/lib/resources/types";
import { ControlStoreError, requireText } from "../errors";
import { assertNoSecretValues } from "../secrets";
import { json, newId, opt, requireDigest } from "../sql";

export const RESOURCE_STATUSES = ["planned", "provisioning", "active", "updating", "deleting", "deleted", "failed", "unknown"] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export interface PlatformResource {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  address: string;
  kind: string;
  provider: string;
  region?: string;
  nativeType: string;
  ownership: ResourceOwnership;
  externalId?: string;
  specDigest: string;
  spec: Record<string, unknown>;
  dependsOn: string[];
  origin: string[];
  labels: Record<string, string>;
  revisionId?: string;
  status: ResourceStatus;
  createdAt: string;
  updatedAt: string;
}

interface ResourceRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  environment_id: string;
  address: string;
  kind: string;
  provider: string;
  region: string | null;
  native_type: string;
  ownership: ResourceOwnership;
  external_id: string | null;
  spec_digest: string;
  spec: Record<string, unknown>;
  depends_on: string[];
  origin: string[];
  labels: Record<string, string>;
  revision_id: string | null;
  status: ResourceStatus;
  created_at: string;
  updated_at: string;
}

export const RESOURCE_COLUMNS =
  "id, workspace_id, project_id, environment_id, address, kind, provider, region, native_type, ownership, external_id, spec_digest, spec, depends_on, origin, labels, revision_id, status, created_at, updated_at";

const toResource = (row: ResourceRow): PlatformResource => ({
  id: row.id,
  workspaceId: row.workspace_id,
  projectId: opt(row.project_id),
  environmentId: row.environment_id,
  address: row.address,
  kind: row.kind,
  provider: row.provider,
  region: opt(row.region),
  nativeType: row.native_type,
  ownership: row.ownership,
  externalId: opt(row.external_id),
  specDigest: row.spec_digest,
  spec: row.spec,
  dependsOn: row.depends_on,
  origin: row.origin,
  labels: row.labels,
  revisionId: opt(row.revision_id),
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface UpsertResourceInput {
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  /** the desired node; `externalRef` is stored as `external_id` */
  node: Pick<ResourceNode, "address" | "kind" | "provider" | "region" | "nativeType" | "ownership" | "externalRef" | "spec" | "origin" | "dependsOn" | "specDigest" | "labels">;
  revisionId?: string;
  /** default: `planned` on insert, unchanged on update */
  status?: ResourceStatus;
}

/** Insert or update the desired state of one resource, keyed by `(environmentId, node.address)`. */
export async function upsertDesired(sql: Sql, input: UpsertResourceInput): Promise<PlatformResource> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const environmentId = requireText("environmentId", input.environmentId);
  const { node } = input;
  const address = requireText("address", node.address, 512);
  if (!["managed", "referenced", "external"].includes(node.ownership))
    throw new ControlStoreError("invalid_input", "ownership must be managed, referenced or external.", { field: "ownership" });
  if (input.status !== undefined && !RESOURCE_STATUSES.includes(input.status)) throw new ControlStoreError("invalid_input", "Unknown resource status.", { field: "status" });
  assertNoSecretValues(node.spec, "spec");

  const rows = await sql.query<ResourceRow>(
    `insert into platform.resources as r (
       id, workspace_id, project_id, environment_id, address, kind, provider, region, native_type, ownership,
       external_id, spec_digest, spec, depends_on, origin, labels, revision_id, status)
     select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text::jsonb, $14::text::jsonb, $15::text::jsonb, $16::text::jsonb, $17, coalesce($18::text, 'planned')
      where not exists (select 1 from platform.resources x where x.environment_id = $4 and x.workspace_id <> $2)
     on conflict (environment_id, address) do update
       set project_id = coalesce(excluded.project_id, r.project_id),
           kind = excluded.kind, provider = excluded.provider, region = excluded.region,
           native_type = excluded.native_type, external_id = excluded.external_id,
           spec_digest = excluded.spec_digest, spec = excluded.spec, depends_on = excluded.depends_on,
           origin = excluded.origin, labels = excluded.labels,
           revision_id = coalesce(excluded.revision_id, r.revision_id),
           status = coalesce($18::text, r.status),
           updated_at = clock_timestamp()
     where r.workspace_id = excluded.workspace_id and r.ownership = excluded.ownership
     returning ${RESOURCE_COLUMNS}`,
    [
      newId("res"),
      workspaceId,
      input.projectId ?? null,
      environmentId,
      address,
      requireText("kind", node.kind, 64),
      requireText("provider", node.provider, 32),
      node.region ?? null,
      requireText("nativeType", node.nativeType, 128),
      node.ownership,
      node.externalRef ?? null,
      requireDigest("specDigest", node.specDigest),
      json(node.spec ?? {}),
      json(node.dependsOn ?? []),
      json(node.origin ?? []),
      json(node.labels ?? {}),
      input.revisionId ?? null,
      input.status ?? null,
    ]
  );
  if (rows.length) return toResource(rows[0]);
  // Zero rows: either the environment belongs to another workspace, or the ownership differs.
  const foreign = await sql.query<{ n: number }>(
    "select 1 as n from platform.resources where environment_id = $1 and workspace_id <> $2 limit 1",
    [environmentId, workspaceId]
  );
  if (foreign.length) throw new ControlStoreError("tenant_mismatch", "Environment not found in this workspace.", { environmentId });
  const existing = await sql.query<{ ownership: string }>(
    "select ownership from platform.resources where workspace_id = $1 and environment_id = $2 and address = $3",
    [workspaceId, environmentId, address]
  );
  throw new ControlStoreError(
    "conflict",
    `Resource ${address} is ${existing[0]?.ownership}; ownership never changes as a side effect of an update. Use changeOwnership to adopt or release it deliberately.`,
    { address }
  );
}

export async function get(sql: Sql, workspaceId: string, id: string): Promise<PlatformResource | null> {
  const rows = await sql.query<ResourceRow>(
    `select ${RESOURCE_COLUMNS} from platform.resources where workspace_id = $1 and id = $2`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]
  );
  return rows.length ? toResource(rows[0]) : null;
}

export async function getByAddress(sql: Sql, workspaceId: string, environmentId: string, address: string): Promise<PlatformResource | null> {
  const rows = await sql.query<ResourceRow>(
    `select ${RESOURCE_COLUMNS} from platform.resources where workspace_id = $1 and environment_id = $2 and address = $3`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), requireText("address", address, 512)]
  );
  return rows.length ? toResource(rows[0]) : null;
}

export async function listByEnvironment(
  sql: Sql,
  workspaceId: string,
  environmentId: string,
  opts: { includeDeleted?: boolean } = {}
): Promise<PlatformResource[]> {
  const rows = await sql.query<ResourceRow>(
    `select ${RESOURCE_COLUMNS} from platform.resources
      where workspace_id = $1 and environment_id = $2 and ($3::boolean or status <> 'deleted')
      order by address`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), opts.includeDeleted ?? false]
  );
  return rows.map(toResource);
}

/** Set the lifecycle status. Returns null when the resource is not in this workspace. */
export async function setStatus(sql: Sql, workspaceId: string, id: string, status: ResourceStatus): Promise<PlatformResource | null> {
  if (!RESOURCE_STATUSES.includes(status)) throw new ControlStoreError("invalid_input", "Unknown resource status.", { field: "status" });
  const rows = await sql.query<ResourceRow>(
    `update platform.resources set status = $3, updated_at = clock_timestamp()
      where workspace_id = $1 and id = $2 returning ${RESOURCE_COLUMNS}`,
    [requireText("workspaceId", workspaceId), requireText("id", id), status]
  );
  return rows.length ? toResource(rows[0]) : null;
}

/**
 * Deliberately change ownership (adopt: external/referenced to managed;
 * release: managed to referenced). The caller has already passed policy and
 * approval for this; the store only guarantees it happens explicitly, once,
 * conditionally on the current value.
 */
export async function changeOwnership(
  sql: Sql,
  input: { workspaceId: string; id: string; from: ResourceOwnership; to: ResourceOwnership }
): Promise<PlatformResource | null> {
  if (input.from === input.to) throw new ControlStoreError("invalid_input", "Ownership is already that value.");
  const rows = await sql.query<ResourceRow>(
    `update platform.resources set ownership = $4, updated_at = clock_timestamp()
      where workspace_id = $1 and id = $2 and ownership = $3 returning ${RESOURCE_COLUMNS}`,
    [requireText("workspaceId", input.workspaceId), requireText("id", input.id), input.from, input.to]
  );
  return rows.length ? toResource(rows[0]) : null;
}
