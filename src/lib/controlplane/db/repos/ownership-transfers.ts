/**
 * Approved field-ownership transfers (PROD-LIFE-12).
 *
 * A transfer row is created in exactly one place: `recordForApprovedOperation`,
 * called by `approvals.record` in the SAME transaction that moves an operation
 * to `approved`. That path already proves a human user decided, on the exact
 * proposal digest. The transfers it records are the ones named in the stored
 * proposal (`proposal.broker.ownershipTransfers`), so an approver reviewed
 * precisely them; nothing a model or caller supplies later can add one.
 *
 * Every function filters on `workspace_id` in SQL; a foreign id is the same as
 * a missing one.
 */
import type { Sql } from "@/lib/controlplane/types";
import { normalizePath } from "@/lib/ownership/paths";
import { transferDigest } from "@/lib/ownership/registry";
import { factsByAddress } from "@/lib/ownership/facts";
import type { FieldOwner, OwnershipFacts, OwnershipTransfer, OwnershipTransferRequest } from "@/lib/ownership/types";
import type { ResourceNode } from "@/lib/resources/types";
import { ControlStoreError, requireText } from "../errors";
import { newId } from "../sql";

const OWNERS: readonly string[] = ["iac", "native-op", "autoscaler"];
const iso = (v: unknown): string => new Date(v as string).toISOString();

interface Row {
  workspace_id: string;
  address: string;
  resource_type: string;
  field_path: string;
  from_owner: FieldOwner;
  to_owner: FieldOwner;
  transfer_digest: string;
  approval_id: string;
  approved_at: unknown;
  expires_at: unknown;
}

const toTransfer = (r: Row): OwnershipTransfer => ({
  address: r.address,
  resourceType: r.resource_type,
  path: r.field_path,
  from: r.from_owner,
  to: r.to_owner,
  approvalId: r.approval_id,
  approvedAt: iso(r.approved_at),
  ...(r.expires_at ? { expiresAt: iso(r.expires_at) } : {}),
  digest: r.transfer_digest,
});

const COLUMNS = "workspace_id, address, resource_type, field_path, from_owner, to_owner, transfer_digest, approval_id, approved_at, expires_at";

function parseRequests(raw: unknown): OwnershipTransferRequest[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new ControlStoreError("invalid_input", "ownershipTransfers must be a short list.");
  return raw.map((r): OwnershipTransferRequest => {
    const o = r as Record<string, unknown>;
    const text = (k: string): string => requireText(`ownershipTransfers.${k}`, o[k], 500);
    const from = text("from");
    const to = text("to");
    if (!OWNERS.includes(from) || !OWNERS.includes(to) || from === to) throw new ControlStoreError("invalid_input", "ownershipTransfers names an owner that cannot be transferred.");
    const req = { address: text("address"), resourceType: text("resourceType"), path: normalizePath(text("path")), from: from as FieldOwner, to: to as FieldOwner };
    // The digest is recomputed, never trusted: the approver reviewed the digest, and it must describe these exact fields.
    const digest = transferDigest(req);
    if (o.digest !== digest) throw new ControlStoreError("digest_mismatch", "An ownership transfer's digest does not match its fields.");
    return { ...req, digest };
  });
}

/**
 * Record the transfers named by an approved operation's stored proposal. Call
 * only inside the transaction that approved it. Refuses unless the approval row
 * is a human `approve` on the operation's current proposal digest.
 */
export async function recordForApprovedOperation(sql: Sql, input: { workspaceId: string; operationId: string; approvalId: string }): Promise<OwnershipTransfer[]> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const operationId = requireText("operationId", input.operationId);
  const approvalId = requireText("approvalId", input.approvalId);
  const ops = await sql.query<{ environment_id: string | null; project_id: string | null; proposal_digest: string; transfers: unknown; approval_id: string | null; approved_at: unknown }>(
    `select o.environment_id, o.project_id, o.proposal_digest, o.proposal->'broker'->'ownershipTransfers' as transfers,
            a.id as approval_id, a.created_at as approved_at
       from platform.operations o
       left join platform.approvals a on a.workspace_id = o.workspace_id and a.operation_id = o.id and a.id = $3
        and a.decision = 'approve' and a.proposal_digest = o.proposal_digest and a.approver->>'kind' = 'user'
      where o.workspace_id = $1 and o.id = $2 and o.status = 'approved'`,
    [workspaceId, operationId, approvalId]
  );
  const op = ops[0];
  if (!op) throw new ControlStoreError("operation_not_found", "Approved operation not found.", { id: operationId });
  const requests = parseRequests(op.transfers);
  if (requests.length === 0) return [];
  if (!op.approval_id || !op.environment_id) throw new ControlStoreError("invalid_state", "Ownership transfers need a human approval of this proposal in a specific environment.", { id: operationId });
  const out: OwnershipTransfer[] = [];
  for (const t of requests) {
    const rows = await sql.query<Row>(
      `insert into platform.ownership_transfers
         (id, workspace_id, project_id, environment_id, address, resource_type, field_path, from_owner, to_owner, transfer_digest,
          operation_id, approval_id, proposal_digest, approved_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz)
       on conflict (workspace_id, operation_id, transfer_digest) do update set transfer_digest = excluded.transfer_digest
       returning ${COLUMNS}`,
      [newId("own"), workspaceId, op.project_id, op.environment_id, t.address, t.resourceType, t.path, t.from, t.to, t.digest, operationId, approvalId, op.proposal_digest, iso(op.approved_at)]
    );
    out.push(toTransfer(rows[0]!));
  }
  return out;
}

/** Unrevoked, unexpired transfers for one environment (optionally one resource address). */
export async function listActive(sql: Sql, workspaceId: string, environmentId: string, address?: string): Promise<OwnershipTransfer[]> {
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from platform.ownership_transfers
      where workspace_id = $1 and environment_id = $2 and ($3::text is null or address = $3)
        and revoked_at is null and (expires_at is null or expires_at > clock_timestamp())
      order by approved_at, id`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), address ?? null]
  );
  return rows.map(toTransfer);
}

/** One-way revocation. Returns false when nothing matched (missing, foreign, or already revoked). */
export async function revoke(sql: Sql, input: { workspaceId: string; transferDigest: string; operationId: string; revokedBy: string }): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update platform.ownership_transfers set revoked_at = clock_timestamp(), revoked_by = $4
      where workspace_id = $1 and operation_id = $2 and transfer_digest = $3 and revoked_at is null
      returning id`,
    [requireText("workspaceId", input.workspaceId), requireText("operationId", input.operationId), requireText("transferDigest", input.transferDigest, 64), requireText("revokedBy", input.revokedBy, 200)]
  );
  return rows.length > 0;
}

export interface StoredOwnershipGuard {
  node: Pick<ResourceNode, "address" | "nativeType" | "spec">;
  facts: OwnershipFacts;
  transfers: OwnershipTransfer[];
}

/** The facts the broker needs to judge a write to one resource: its node, the environment's autoscalers and its transfers. */
export async function guardFor(sql: Sql, workspaceId: string, environmentId: string, resourceId: string): Promise<StoredOwnershipGuard | null> {
  const rows = await sql.query<{ id: string; address: string; kind: string; native_type: string; spec: Record<string, unknown> }>(
    "select id, address, kind, native_type, spec from platform.resources where workspace_id = $1 and environment_id = $2 order by address limit 2000",
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId)]
  );
  const target = rows.find((r) => r.id === resourceId);
  if (!target) return null;
  const nodes = rows.map((r) => ({ address: r.address, kind: r.kind as ResourceNode["kind"], nativeType: r.native_type, spec: r.spec ?? {} }));
  const facts = factsByAddress({ nodes }).get(target.address) ?? {};
  return {
    node: { address: target.address, nativeType: target.native_type, spec: target.spec ?? {} },
    facts,
    transfers: await listActive(sql, workspaceId, environmentId, target.address),
  };
}
