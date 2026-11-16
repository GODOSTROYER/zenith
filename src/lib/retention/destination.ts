/**
 * Where a workspace's archives go (PROD-OPS-07): the tenant's own bucket when it configured one, otherwise the
 * operator's bucket.
 *
 * A tenant destination is the LIFE-11 export destination shape: an `object_store` resource of one of the workspace's
 * environments (managed or referenced, never `external`) plus a vault credentials reference. The credentials are read
 * through the same brokered, workspace-scoped secret resolver the export path uses, at the moment of use, and dropped.
 * The bucket named in the secret must be the bucket that resource is, so a secret cannot redirect archives elsewhere.
 * No secret is stored in the platform database; the destination row holds the reference only.
 *
 * Fallback rule: no destination configured means the operator bucket. A destination that IS configured but cannot be
 * reached or no longer validates is reported and the workspace is skipped for that tick. It never silently falls back to
 * the operator's bucket, because that would move tenant data somewhere the tenant did not choose.
 *
 * Tenancy classification: createDestination / revokeDestination / getActiveDestination / getDestination are
 * WORKSPACE-BOUND (every statement filters on workspace_id); listDestinations() without a workspace is a SYSTEM operator read.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "@/lib/controlplane/db/errors";
import * as resources from "@/lib/controlplane/db/repos/resources";
import { openObjectStore } from "@/lib/portability/connect";
import { allowPrivateHostsFromEnv } from "@/lib/portability/net";
import { S3ObjectStore, parseS3Credentials, s3ArtifactStore } from "@/lib/portability/engines/s3";
import { PortabilityError } from "@/lib/portability/types";
import { SecretDeliveryError } from "@/lib/secrets/delivery";
import { createSecretResolver } from "@/lib/secrets/resolver";
import type { ArchiveTarget } from "./archive";

export interface RetentionDestination {
  id: string;
  workspaceId: string;
  environmentId: string;
  resourceAddress: string;
  credentialsRef: string;
  bucket: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

interface Row {
  id: string; workspace_id: string; environment_id: string; resource_address: string; credentials_ref: string; bucket: string;
  created_by: string; created_at: unknown; revoked_at: unknown; revoked_by: string | null;
}
const COLS = "id, workspace_id, environment_id, resource_address, credentials_ref, bucket, created_by, created_at, revoked_at, revoked_by";
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const toDest = (r: Row): RetentionDestination => ({
  id: r.id, workspaceId: r.workspace_id, environmentId: r.environment_id, resourceAddress: r.resource_address, credentialsRef: r.credentials_ref,
  bucket: r.bucket, createdBy: r.created_by, createdAt: iso(r.created_at)!, revokedAt: iso(r.revoked_at), revokedBy: r.revoked_by,
});

export async function getActiveDestination(sql: Sql, workspaceId: string): Promise<RetentionDestination | null> {
  const rows = await sql.query<Row>(`select ${COLS} from platform.retention_destinations where workspace_id = $1 and revoked_at is null`, [workspaceId]);
  return rows[0] ? toDest(rows[0]) : null;
}

export async function getDestination(sql: Sql, workspaceId: string, id: string): Promise<RetentionDestination | null> {
  const rows = await sql.query<Row>(`select ${COLS} from platform.retention_destinations where workspace_id = $1 and id = $2`, [workspaceId, id]);
  return rows[0] ? toDest(rows[0]) : null;
}

export async function listDestinations(sql: Sql, options: { workspaceId?: string; limit?: number } = {}): Promise<RetentionDestination[]> {
  const rows = await sql.query<Row>(
    `select ${COLS} from platform.retention_destinations where ($1::text is null or workspace_id = $1::text) order by created_at desc, id limit $2::int`,
    [options.workspaceId ?? null, Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200)]);
  return rows.map(toDest);
}

export interface ConnectDeps {
  /** test seam for the vault read */
  secret?: (ref: string) => Promise<string | undefined>;
  /** test seam for the S3 client */
  s3Client?: { send(command: unknown): Promise<unknown> };
  allowPrivate?: boolean;
}

const bucketNameOf = (row: resources.PlatformResource): string | undefined => {
  const raw = row.externalId ?? (typeof row.spec.bucketName === "string" ? row.spec.bucketName : typeof row.spec.name === "string" ? row.spec.name : undefined);
  const last = raw?.split(/[:/]/).filter(Boolean).pop();
  return last && last.length > 0 ? last : undefined;
};

export class DestinationError extends Error {
  readonly code = "retention_destination";
  constructor(message: string) { super(message); this.name = "DestinationError"; }
}

/**
 * Open a tenant destination exactly as LIFE-11 export does: the resource must be an object store of the workspace's
 * environment the tenant owns, the secret is read through the brokered resolver, and its bucket must be the resource's.
 * Messages never carry a credential or a bucket secret.
 */
export async function connectTenantDestination(
  db: Sql,
  d: { workspaceId: string; environmentId: string; resourceAddress: string; credentialsRef: string },
  deps: ConnectDeps = {},
): Promise<{ target: ArchiveTarget; bucket: string; label: string }> {
  const resource = await resources.getByAddress(db, d.workspaceId, d.environmentId, d.resourceAddress);
  if (!resource || resource.kind !== "object_store" || resource.status === "deleted") throw new DestinationError("The destination is not an object store resource of that environment.");
  if (resource.ownership === "external") throw new DestinationError("The destination resource is documented only (external); archives go to storage the tenant owns.");
  const siblings = await resources.listByEnvironment(db, d.workspaceId, d.environmentId);
  const resolver = deps.secret ?? createSecretResolver({
    workspaceId: d.workspaceId, environmentId: d.environmentId, projectId: resource.projectId ?? "",
    resourceAddresses: siblings.filter((r) => r.ownership === "managed").map((r) => r.address),
  });
  let secret: string | undefined;
  try { secret = await resolver(d.credentialsRef); } catch (err) {
    throw new DestinationError(err instanceof SecretDeliveryError ? `The credentials secret could not be read (${err.reason}).` : "The credentials secret could not be read.");
  }
  if (!secret) throw new DestinationError("The credentials secret has no value; register it before using it as an archive destination.");
  let store: S3ObjectStore;
  let bucket: string;
  try {
    if (deps.s3Client) {
      const creds = parseS3Credentials(secret);
      store = new S3ObjectStore(creds, { client: deps.s3Client });
      bucket = creds.bucket;
    } else {
      const opened = openObjectStore(secret, { allowPrivate: deps.allowPrivate ?? allowPrivateHostsFromEnv() });
      store = opened.store;
      bucket = opened.creds.bucket;
    }
  } catch (err) {
    throw new DestinationError(err instanceof PortabilityError ? err.message : "The storage credentials are not usable.");
  }
  const expected = bucketNameOf(resource);
  if (!expected) throw new DestinationError("The storage resource has no observed bucket identity yet; apply it before using it as a destination.");
  if (expected !== bucket) throw new DestinationError("The storage credentials do not belong to the destination resource's bucket.");
  const label = `s3://${bucket}/zenith-retention/`;
  return { target: s3ArtifactStore(store, "zenith-retention/", label), bucket, label };
}

export async function createDestination(
  db: Sql,
  input: { workspaceId: string; environmentId: string; resourceAddress: string; credentialsRef: string; actor: string },
  deps: ConnectDeps = {},
): Promise<RetentionDestination> {
  const workspaceId = requireText("workspaceId", input.workspaceId, 128);
  const environmentId = requireText("environmentId", input.environmentId, 128);
  const resourceAddress = requireText("resourceAddress", input.resourceAddress, 300);
  const credentialsRef = requireText("credentialsRef", input.credentialsRef, 1024);
  const actor = requireText("actor", input.actor, 128);
  let opened;
  try { opened = await connectTenantDestination(db, { workspaceId, environmentId, resourceAddress, credentialsRef }, deps); }
  catch (err) { throw new ControlStoreError("invalid_input", err instanceof DestinationError ? err.message : "The destination could not be validated.", { field: "destination" }); }
  // Prove write and read-back on the tenant's bucket before it is chosen (a small marker under the retention prefix).
  const marker = Buffer.from(`zenith-retention-probe:${randomUUID()}`);
  const key = `probe/${workspaceId}.txt`;
  try {
    await opened.target.put(key, marker);
    const back = await opened.target.get(key);
    if (!back || !back.equals(marker)) throw new Error("mismatch");
  } catch { throw new ControlStoreError("invalid_input", "The destination bucket could not be written and read back with these credentials.", { field: "destination" }); }
  return db.tx(async (tx) => {
    await tx.query("update platform.retention_destinations set revoked_at = clock_timestamp(), revoked_by = $2 where workspace_id = $1 and revoked_at is null", [workspaceId, actor]);
    const rows = await tx.query<Row>(
      `insert into platform.retention_destinations (id, workspace_id, environment_id, resource_address, credentials_ref, bucket, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning ${COLS}`,
      [`rdest_${randomUUID()}`, workspaceId, environmentId, resourceAddress, credentialsRef, opened.bucket, actor]);
    return toDest(rows[0]);
  });
}

export async function revokeDestination(db: Sql, workspaceId: string, actor: string): Promise<RetentionDestination | null> {
  const rows = await db.query<Row>(
    `update platform.retention_destinations set revoked_at = clock_timestamp(), revoked_by = $2 where workspace_id = $1 and revoked_at is null returning ${COLS}`,
    [requireText("workspaceId", workspaceId, 128), requireText("actor", actor, 128)]);
  return rows[0] ? toDest(rows[0]) : null;
}

/* -------------------------------- resolution -------------------------------- */

export interface ResolvedDestination { id: string | null; kind: "operator" | "tenant"; label: string; target: ArchiveTarget }
export type DestinationResolution =
  | { ok: true; destination: ResolvedDestination }
  | { ok: false; reason: "none_configured" | "tenant_unavailable"; detail: string };

export interface ResolveDeps extends ConnectDeps {
  operator?: ArchiveTarget & { label: string };
  /** test seam: open a tenant destination without a vault and resources */
  openTenant?: (d: RetentionDestination) => Promise<{ target: ArchiveTarget; label: string }>;
}

/**
 * The destination for NEW archives (the active tenant destination, else the operator's), or, with `destinationId`,
 * the exact destination an existing archive was written to (for verify, restore and prune). A recorded tenant
 * destination that has since been revoked is still opened by id when its credentials still resolve.
 */
export async function resolveDestination(db: Sql, workspaceId: string, deps: ResolveDeps, existing?: { destinationId: string | null }): Promise<DestinationResolution> {
  const tenant = existing ? (existing.destinationId ? await getDestination(db, workspaceId, existing.destinationId) : null) : await getActiveDestination(db, workspaceId);
  if (existing && existing.destinationId && !tenant) return { ok: false, reason: "tenant_unavailable", detail: "The tenant destination this archive was written to no longer exists." };
  if (tenant) {
    try {
      const opened = deps.openTenant ? await deps.openTenant(tenant) : await connectTenantDestination(db, tenant, deps);
      return { ok: true, destination: { id: tenant.id, kind: "tenant", label: opened.label, target: opened.target } };
    } catch (err) {
      return { ok: false, reason: "tenant_unavailable", detail: err instanceof DestinationError ? err.message : "The tenant archive destination could not be opened." };
    }
  }
  if (deps.operator) return { ok: true, destination: { id: null, kind: "operator", label: deps.operator.label, target: deps.operator } };
  return { ok: false, reason: "none_configured", detail: "No archive storage is configured for this workspace or by the operator." };
}
