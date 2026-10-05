/**
 * Verified exports, verified restores and ownership claims (PROD-LIFE-11).
 *
 * Every function filters on `workspace_id` in SQL; a foreign id is the same as a
 * missing one. Records are written only by the worker, after the effect they
 * describe was verified (an export row exists only for an artifact read back from
 * tenant storage; a restore row carries the verdict of a readback taken from the
 * target; an adoption row exists only under a human approval of the exact
 * proposal that named the claim).
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { HEX64, clampLimit, json, newId, requireDigest } from "../sql";

const iso = (v: unknown): string => new Date(v as string).toISOString();
const KINDS = ["postgres", "mysql", "object_store"] as const;
const LIFECYCLES = ["manage", "manage_and_destroy"] as const;

/* --------------------------------- exports -------------------------------- */

export interface PortabilityExport {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  operationId: string;
  resourceId: string;
  address: string;
  kind: (typeof KINDS)[number];
  provider: string;
  engine: string;
  engineVersion?: string;
  destinationLabel: string;
  artifactPrefix: string;
  manifestDigest: string;
  contentDigest: string;
  fileCount: number;
  byteSize: number;
  coverage: Record<string, unknown>;
  verifiedAt: string;
  createdAt: string;
}

interface ExportRow {
  id: string; workspace_id: string; project_id: string | null; environment_id: string; operation_id: string; resource_id: string; address: string; kind: PortabilityExport["kind"];
  provider: string; engine: string; engine_version: string | null; destination_label: string; artifact_prefix: string; manifest_digest: string; content_digest: string;
  file_count: number; byte_size: string | number; coverage: Record<string, unknown>; verified_at: unknown; created_at: unknown;
}
const EXPORT_COLUMNS = "id, workspace_id, project_id, environment_id, operation_id, resource_id, address, kind, provider, engine, engine_version, destination_label, artifact_prefix, manifest_digest, content_digest, file_count, byte_size, coverage, verified_at, created_at";

const toExport = (r: ExportRow): PortabilityExport => ({
  id: r.id, workspaceId: r.workspace_id, ...(r.project_id ? { projectId: r.project_id } : {}), environmentId: r.environment_id, operationId: r.operation_id, resourceId: r.resource_id,
  address: r.address, kind: r.kind, provider: r.provider, engine: r.engine, ...(r.engine_version ? { engineVersion: r.engine_version } : {}), destinationLabel: r.destination_label,
  artifactPrefix: r.artifact_prefix, manifestDigest: r.manifest_digest, contentDigest: r.content_digest, fileCount: Number(r.file_count), byteSize: Number(r.byte_size),
  coverage: r.coverage ?? {}, verifiedAt: iso(r.verified_at), createdAt: iso(r.created_at),
});

export interface RecordExportInput {
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  operationId: string;
  resourceId: string;
  address: string;
  kind: string;
  provider: string;
  engine: string;
  engineVersion?: string;
  destinationLabel: string;
  artifactPrefix: string;
  manifestDigest: string;
  contentDigest: string;
  fileCount: number;
  byteSize: number;
  coverage: Record<string, unknown>;
  verifiedAt: string;
}

/** Idempotent per operation: a retried activity returns the row it already wrote; a different digest for the same operation is a conflict. */
export async function recordExport(sql: Sql, input: RecordExportInput): Promise<PortabilityExport> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const operationId = requireText("operationId", input.operationId);
  if (!(KINDS as readonly string[]).includes(input.kind)) throw new ControlStoreError("invalid_input", "Unknown data kind for an export.", { field: "kind" });
  const manifestDigest = requireDigest("manifestDigest", input.manifestDigest);
  const contentDigest = requireDigest("contentDigest", input.contentDigest);
  const inserted = await sql.query<ExportRow>(
    `insert into platform.portability_exports
       (id, workspace_id, project_id, environment_id, operation_id, resource_id, address, kind, provider, engine, engine_version, destination_label, artifact_prefix,
        manifest_digest, content_digest, file_count, byte_size, coverage, verified_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::text::jsonb,$19::timestamptz)
     on conflict (workspace_id, operation_id) do nothing
     returning ${EXPORT_COLUMNS}`,
    [newId("pex"), workspaceId, input.projectId ?? null, requireText("environmentId", input.environmentId), operationId, requireText("resourceId", input.resourceId), requireText("address", input.address, 500),
     input.kind, requireText("provider", input.provider, 60), requireText("engine", input.engine, 60), input.engineVersion ? input.engineVersion.slice(0, 200) : null,
     requireText("destinationLabel", input.destinationLabel, 300), requireText("artifactPrefix", input.artifactPrefix, 500), manifestDigest, contentDigest,
     input.fileCount, input.byteSize, json(input.coverage), input.verifiedAt]
  );
  if (inserted[0]) return toExport(inserted[0]);
  const existing = await sql.query<ExportRow>(`select ${EXPORT_COLUMNS} from platform.portability_exports where workspace_id = $1 and operation_id = $2`, [workspaceId, operationId]);
  if (!existing[0]) throw new ControlStoreError("not_found", "Export record could not be written or found.");
  if (existing[0].manifest_digest !== manifestDigest) throw new ControlStoreError("conflict", "This operation already recorded a different export.");
  return toExport(existing[0]);
}

export async function getExport(sql: Sql, workspaceId: string, id: string): Promise<PortabilityExport | null> {
  const rows = await sql.query<ExportRow>(`select ${EXPORT_COLUMNS} from platform.portability_exports where workspace_id = $1 and id = $2`, [requireText("workspaceId", workspaceId), requireText("id", id)]);
  return rows[0] ? toExport(rows[0]) : null;
}

export async function listExports(sql: Sql, workspaceId: string, environmentId: string, opts: { limit?: number } = {}): Promise<PortabilityExport[]> {
  const rows = await sql.query<ExportRow>(
    `select ${EXPORT_COLUMNS} from platform.portability_exports where workspace_id = $1 and environment_id = $2 order by created_at desc, id limit $3`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), clampLimit(opts.limit, 50, 200)]
  );
  return rows.map(toExport);
}

/* -------------------------------- restores -------------------------------- */

export interface PortabilityRestore {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  operationId: string;
  exportId: string;
  targetResourceId: string;
  targetAddress: string;
  kind: (typeof KINDS)[number];
  provider: string;
  status: "verified" | "mismatch";
  expectedContentDigest: string;
  observedContentDigest: string;
  readback: Record<string, unknown>;
  restored: Record<string, unknown>;
  verifiedAt: string;
  createdAt: string;
}

interface RestoreRow {
  id: string; workspace_id: string; project_id: string | null; environment_id: string; operation_id: string; export_id: string; target_resource_id: string; target_address: string;
  kind: PortabilityRestore["kind"]; provider: string; status: PortabilityRestore["status"]; expected_content_digest: string; observed_content_digest: string;
  readback: Record<string, unknown>; restored: Record<string, unknown>; verified_at: unknown; created_at: unknown;
}
const RESTORE_COLUMNS = "id, workspace_id, project_id, environment_id, operation_id, export_id, target_resource_id, target_address, kind, provider, status, expected_content_digest, observed_content_digest, readback, restored, verified_at, created_at";

const toRestore = (r: RestoreRow): PortabilityRestore => ({
  id: r.id, workspaceId: r.workspace_id, ...(r.project_id ? { projectId: r.project_id } : {}), environmentId: r.environment_id, operationId: r.operation_id, exportId: r.export_id,
  targetResourceId: r.target_resource_id, targetAddress: r.target_address, kind: r.kind, provider: r.provider, status: r.status, expectedContentDigest: r.expected_content_digest,
  observedContentDigest: r.observed_content_digest, readback: r.readback ?? {}, restored: r.restored ?? {}, verifiedAt: iso(r.verified_at), createdAt: iso(r.created_at),
});

export interface RecordRestoreInput {
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  operationId: string;
  exportId: string;
  targetResourceId: string;
  targetAddress: string;
  kind: string;
  provider: string;
  expectedContentDigest: string;
  observedContentDigest: string;
  readback: Record<string, unknown>;
  restored: Record<string, unknown>;
  verifiedAt: string;
}

/** The status is derived here from the two digests, never accepted from the caller. */
export async function recordRestore(sql: Sql, input: RecordRestoreInput): Promise<PortabilityRestore> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const operationId = requireText("operationId", input.operationId);
  if (!(KINDS as readonly string[]).includes(input.kind)) throw new ControlStoreError("invalid_input", "Unknown data kind for a restore.", { field: "kind" });
  const expected = requireDigest("expectedContentDigest", input.expectedContentDigest);
  const observed = requireDigest("observedContentDigest", input.observedContentDigest);
  const inserted = await sql.query<RestoreRow>(
    `insert into platform.portability_restores
       (id, workspace_id, project_id, environment_id, operation_id, export_id, target_resource_id, target_address, kind, provider, status,
        expected_content_digest, observed_content_digest, readback, restored, verified_at)
     select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, case when $11 = $12 then 'verified' else 'mismatch' end, $11,$12,$13::text::jsonb,$14::text::jsonb,$15::timestamptz
      where exists (select 1 from platform.portability_exports e where e.workspace_id = $2 and e.id = $6 and e.content_digest = $11 and e.kind = $9)
     on conflict (workspace_id, operation_id) do nothing
     returning ${RESTORE_COLUMNS}`,
    [newId("prs"), workspaceId, input.projectId ?? null, requireText("environmentId", input.environmentId), operationId, requireText("exportId", input.exportId), requireText("targetResourceId", input.targetResourceId),
     requireText("targetAddress", input.targetAddress, 500), input.kind, requireText("provider", input.provider, 60), expected, observed, json(input.readback), json(input.restored), input.verifiedAt]
  );
  if (inserted[0]) return toRestore(inserted[0]);
  const existing = await sql.query<RestoreRow>(`select ${RESTORE_COLUMNS} from platform.portability_restores where workspace_id = $1 and operation_id = $2`, [workspaceId, operationId]);
  if (existing[0]) return toRestore(existing[0]);
  throw new ControlStoreError("not_found", "The export this restore names does not exist in this workspace with that content digest.");
}

export async function listRestores(sql: Sql, workspaceId: string, environmentId: string, opts: { limit?: number } = {}): Promise<PortabilityRestore[]> {
  const rows = await sql.query<RestoreRow>(
    `select ${RESTORE_COLUMNS} from platform.portability_restores where workspace_id = $1 and environment_id = $2 order by created_at desc, id limit $3`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), clampLimit(opts.limit, 50, 200)]
  );
  return rows.map(toRestore);
}

/* -------------------------------- adoptions ------------------------------- */

export interface ResourceAdoption {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  resourceId: string;
  address: string;
  provider: string;
  nativeType: string;
  externalId: string;
  lifecycle: (typeof LIFECYCLES)[number];
  claim: Record<string, unknown>;
  claimDigest: string;
  fieldOwners: unknown[];
  baseline: Record<string, unknown>;
  baselineDigest: string;
  operationId: string;
  approvalId: string;
  proposalDigest: string;
  status: "active" | "released";
  adoptedAt: string;
  releasedAt?: string;
  releasedBy?: string;
  releaseOperationId?: string;
}

interface AdoptionRow {
  id: string; workspace_id: string; project_id: string | null; environment_id: string; resource_id: string; address: string; provider: string; native_type: string; external_id: string;
  lifecycle: ResourceAdoption["lifecycle"]; claim: Record<string, unknown>; claim_digest: string; field_owners: unknown[]; baseline: Record<string, unknown>; baseline_digest: string;
  operation_id: string; approval_id: string; proposal_digest: string; status: ResourceAdoption["status"]; adopted_at: unknown; released_at: unknown; released_by: string | null; release_operation_id: string | null;
}
const ADOPTION_COLUMNS = "id, workspace_id, project_id, environment_id, resource_id, address, provider, native_type, external_id, lifecycle, claim, claim_digest, field_owners, baseline, baseline_digest, operation_id, approval_id, proposal_digest, status, adopted_at, released_at, released_by, release_operation_id";

const toAdoption = (r: AdoptionRow): ResourceAdoption => ({
  id: r.id, workspaceId: r.workspace_id, ...(r.project_id ? { projectId: r.project_id } : {}), environmentId: r.environment_id, resourceId: r.resource_id, address: r.address,
  provider: r.provider, nativeType: r.native_type, externalId: r.external_id, lifecycle: r.lifecycle, claim: r.claim, claimDigest: r.claim_digest, fieldOwners: r.field_owners ?? [],
  baseline: r.baseline, baselineDigest: r.baseline_digest, operationId: r.operation_id, approvalId: r.approval_id, proposalDigest: r.proposal_digest, status: r.status, adoptedAt: iso(r.adopted_at),
  ...(r.released_at ? { releasedAt: iso(r.released_at) } : {}), ...(r.released_by ? { releasedBy: r.released_by } : {}), ...(r.release_operation_id ? { releaseOperationId: r.release_operation_id } : {}),
});

interface ApprovedOperation { project_id: string | null; environment_id: string | null; resource_id: string | null; proposal_digest: string; capability: string; approval_id: string | null }

/** The operation must carry a human approval of exactly its stored proposal, for this capability, environment and resource. */
async function requireApproval(sql: Sql, input: { workspaceId: string; operationId: string; approvalId: string; capability: string; environmentId: string; resourceId: string }): Promise<ApprovedOperation> {
  const rows = await sql.query<ApprovedOperation>(
    `select o.project_id, o.environment_id, o.resource_id, o.proposal_digest, o.capability, a.id as approval_id
       from platform.operations o
       left join platform.approvals a on a.workspace_id = o.workspace_id and a.operation_id = o.id and a.id = $3
        and a.decision = 'approve' and a.proposal_digest = o.proposal_digest and a.approver->>'kind' = 'user'
      where o.workspace_id = $1 and o.id = $2`,
    [input.workspaceId, input.operationId, input.approvalId]
  );
  const op = rows[0];
  if (!op) throw new ControlStoreError("operation_not_found", "Operation not found.", { id: input.operationId });
  if (op.capability !== input.capability || op.environment_id !== input.environmentId || op.resource_id !== input.resourceId) throw new ControlStoreError("invalid_state", "The operation does not match this resource and capability.");
  if (!op.approval_id) throw new ControlStoreError("approval_required", "A human approval of this exact proposal is required.");
  return op;
}

export interface AdoptInput {
  workspaceId: string;
  environmentId: string;
  resourceId: string;
  operationId: string;
  approvalId: string;
  externalId: string;
  lifecycle: string;
  claim: Record<string, unknown>;
  claimDigest: string;
  fieldOwners: unknown[];
  baseline: Record<string, unknown>;
  baselineDigest: string;
}

/**
 * Adopt: referenced -> managed and the claim row, in ONE transaction, only under a human approval of
 * this exact operation. Idempotent per operation. Refuses a resource that is not `referenced`, and a
 * provider object that already has an active claim anywhere in the workspace.
 */
export async function adopt(sql: Sql, input: AdoptInput): Promise<ResourceAdoption> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const operationId = requireText("operationId", input.operationId);
  if (!(LIFECYCLES as readonly string[]).includes(input.lifecycle)) throw new ControlStoreError("invalid_input", "Unknown adoption lifecycle.", { field: "lifecycle" });
  const claimDigest = requireDigest("claimDigest", input.claimDigest);
  const baselineDigest = requireDigest("baselineDigest", input.baselineDigest);
  return sql.tx(async (tx) => {
    const done = await tx.query<AdoptionRow>(`select ${ADOPTION_COLUMNS} from platform.resource_adoptions where workspace_id = $1 and operation_id = $2`, [workspaceId, operationId]);
    if (done[0]) return toAdoption(done[0]);
    const op = await requireApproval(tx, { workspaceId, operationId, approvalId: requireText("approvalId", input.approvalId), capability: "resource.adopt", environmentId: input.environmentId, resourceId: input.resourceId });
    if (!HEX64.test(op.proposal_digest)) throw new ControlStoreError("invalid_state", "The operation has no proposal digest.");
    const res = await tx.query<{ address: string; provider: string; native_type: string; ownership: string }>(
      "select address, provider, native_type, ownership from platform.resources where workspace_id = $1 and environment_id = $2 and id = $3 for update",
      [workspaceId, input.environmentId, input.resourceId]
    );
    const row = res[0];
    if (!row) throw new ControlStoreError("not_found", "Resource not found in this environment.");
    if (row.ownership !== "referenced") throw new ControlStoreError("conflict", `Resource ${row.address} is ${row.ownership}; only a referenced resource can be adopted.`);
    const taken = await tx.query<{ id: string }>(
      "select id from platform.resource_adoptions where workspace_id = $1 and provider = $2 and native_type = $3 and external_id = $4 and status = 'active'",
      [workspaceId, row.provider, row.native_type, input.externalId]
    );
    if (taken[0]) throw new ControlStoreError("conflict", "That provider object already has an active adoption claim in this workspace.");
    const flipped = await tx.query<{ id: string }>(
      "update platform.resources set ownership = 'managed', external_id = coalesce(external_id, $4), updated_at = clock_timestamp() where workspace_id = $1 and environment_id = $2 and id = $3 and ownership = 'referenced' returning id",
      [workspaceId, input.environmentId, input.resourceId, input.externalId]
    );
    if (!flipped[0]) throw new ControlStoreError("conflict", "The resource changed ownership while it was being adopted.");
    const inserted = await tx.query<AdoptionRow>(
      `insert into platform.resource_adoptions
         (id, workspace_id, project_id, environment_id, resource_id, address, provider, native_type, external_id, lifecycle, claim, claim_digest, field_owners, baseline, baseline_digest,
          operation_id, approval_id, proposal_digest)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12,$13::text::jsonb,$14::text::jsonb,$15,$16,$17,$18)
       returning ${ADOPTION_COLUMNS}`,
      [newId("ado"), workspaceId, op.project_id, input.environmentId, input.resourceId, row.address, row.provider, row.native_type, requireText("externalId", input.externalId, 500), input.lifecycle,
       json(input.claim), claimDigest, json(input.fieldOwners), json(input.baseline), baselineDigest, operationId, input.approvalId, op.proposal_digest]
    );
    return toAdoption(inserted[0]!);
  });
}

export interface ReleaseInput {
  workspaceId: string;
  environmentId: string;
  resourceId: string;
  adoptionId: string;
  operationId: string;
  approvalId: string;
  releasedBy: string;
}

/** Release: managed -> referenced and the claim closed, in one transaction, under a human approval. The object is never touched. */
export async function release(sql: Sql, input: ReleaseInput): Promise<ResourceAdoption> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  return sql.tx(async (tx) => {
    const current = await tx.query<AdoptionRow>(
      `select ${ADOPTION_COLUMNS} from platform.resource_adoptions where workspace_id = $1 and id = $2 and environment_id = $3 and resource_id = $4 for update`,
      [workspaceId, requireText("adoptionId", input.adoptionId), input.environmentId, input.resourceId]
    );
    const row = current[0];
    if (!row) throw new ControlStoreError("not_found", "Adoption claim not found for this resource.");
    if (row.status === "released") {
      if (row.release_operation_id === input.operationId) return toAdoption(row);
      throw new ControlStoreError("conflict", "That adoption claim was already released.");
    }
    await requireApproval(tx, { workspaceId, operationId: requireText("operationId", input.operationId), approvalId: requireText("approvalId", input.approvalId), capability: "resource.release", environmentId: input.environmentId, resourceId: input.resourceId });
    const flipped = await tx.query<{ id: string }>(
      "update platform.resources set ownership = 'referenced', updated_at = clock_timestamp() where workspace_id = $1 and environment_id = $2 and id = $3 and ownership = 'managed' returning id",
      [workspaceId, input.environmentId, input.resourceId]
    );
    if (!flipped[0]) throw new ControlStoreError("conflict", "The resource is not managed; there is nothing to release.");
    const updated = await tx.query<AdoptionRow>(
      `update platform.resource_adoptions set status = 'released', released_at = clock_timestamp(), released_by = $3, release_operation_id = $4
        where workspace_id = $1 and id = $2 and status = 'active' returning ${ADOPTION_COLUMNS}`,
      [workspaceId, input.adoptionId, requireText("releasedBy", input.releasedBy, 200), input.operationId]
    );
    return toAdoption(updated[0]!);
  });
}

export async function getAdoption(sql: Sql, workspaceId: string, id: string): Promise<ResourceAdoption | null> {
  const rows = await sql.query<AdoptionRow>(`select ${ADOPTION_COLUMNS} from platform.resource_adoptions where workspace_id = $1 and id = $2`, [requireText("workspaceId", workspaceId), requireText("id", id)]);
  return rows[0] ? toAdoption(rows[0]) : null;
}

export async function listAdoptions(sql: Sql, workspaceId: string, environmentId: string, opts: { limit?: number; activeOnly?: boolean } = {}): Promise<ResourceAdoption[]> {
  const rows = await sql.query<AdoptionRow>(
    `select ${ADOPTION_COLUMNS} from platform.resource_adoptions
      where workspace_id = $1 and environment_id = $2 and ($4::boolean = false or status = 'active') order by adopted_at desc, id limit $3`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), clampLimit(opts.limit, 100, 500), opts.activeOnly === true]
  );
  return rows.map(toAdoption);
}

/** Facts for the decommission guard: every claim ever made in the environment, active or released. */
export async function adoptionFacts(sql: Sql, workspaceId: string, environmentId: string): Promise<{ address: string; externalId: string; status: "active" | "released"; lifecycle: "manage" | "manage_and_destroy"; approvalId: string }[]> {
  const rows = await sql.query<{ address: string; external_id: string; status: "active" | "released"; lifecycle: "manage" | "manage_and_destroy"; approval_id: string }>(
    "select address, external_id, status, lifecycle, approval_id from platform.resource_adoptions where workspace_id = $1 and environment_id = $2 order by address, adopted_at limit 2000",
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId)]
  );
  return rows.map((r) => ({ address: r.address, externalId: r.external_id, status: r.status, lifecycle: r.lifecycle, approvalId: r.approval_id }));
}
