/**
 * Producer output records of mixed parent plans (migration 42): provenance, the value digest, the value itself for a non-secret
 * output, and for a secret only the vault reference and version digest (the table refuses a secret row with a value). Every
 * statement names `workspace_id`; a foreign workspace and a missing plan are indistinguishable. Append-only: a second
 * `recordOutput` of the same (plan, reference) returns the stored row when the value digest agrees and refuses (`conflict`)
 * when it does not, so a re-capture that disagrees can never replace what a person reviewed.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError } from "../errors";
import { requireDigest } from "../sql";

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PARTITION = /^[A-Za-z0-9_.:/-]{1,200}$/;
const TYPES = new Set(["string", "number", "boolean", "resource_id", "endpoint", "secret_ref"]);
const VAULT = /^vault:[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/;

export interface MixedOutputRecord {
  workspaceId: string;
  planId: string;
  referenceId: string;
  producerPartitionId: string;
  consumerPartitionId: string;
  producerOperationId: string;
  producerAddress: string;
  producerOutput: string;
  valueType: "string" | "number" | "boolean" | "resource_id" | "endpoint" | "secret_ref";
  valueDigest: string;
  /** The non-secret value; absent for a secret. */
  value?: string | number | boolean;
  secretRef?: string;
  secretVersionDigest?: string;
  source: "observation" | "tofu_output";
  sourceDigest: string;
  observedAt: string;
  recordedAt: string;
}

interface Row {
  workspace_id: string; plan_id: string; reference_id: string; producer_partition_id: string; consumer_partition_id: string;
  producer_operation_id: string; producer_address: string; producer_output: string; value_type: MixedOutputRecord["valueType"]; value_digest: string; value: unknown;
  secret_ref: string | null; secret_version_digest: string | null; source: MixedOutputRecord["source"]; source_digest: string; observed_at: unknown; recorded_at: unknown;
}
const COLUMNS = `workspace_id, plan_id, reference_id, producer_partition_id, consumer_partition_id, producer_operation_id, producer_address,
  producer_output, value_type, value_digest, value, secret_ref, secret_version_digest, source, source_digest, observed_at, recorded_at`;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
/** The value is stored as {"v": scalar}; jsonb arrives parsed on some drivers and as JSON text on others. */
const scalar = (value: unknown): string | number | boolean | undefined => {
  if (value === null || value === undefined) return undefined;
  const object = (typeof value === "string" ? JSON.parse(value) : value) as { v?: unknown };
  return ["string", "number", "boolean"].includes(typeof object.v) ? (object.v as string | number | boolean) : undefined;
};
const toRecord = (r: Row): MixedOutputRecord => {
  const value = scalar(r.value);
  return {
    workspaceId: r.workspace_id, planId: r.plan_id, referenceId: r.reference_id, producerPartitionId: r.producer_partition_id,
    consumerPartitionId: r.consumer_partition_id, producerOperationId: r.producer_operation_id, producerAddress: r.producer_address, producerOutput: r.producer_output,
    valueType: r.value_type, valueDigest: r.value_digest, ...(value !== undefined ? { value } : {}), ...(r.secret_ref ? { secretRef: r.secret_ref } : {}),
    ...(r.secret_version_digest ? { secretVersionDigest: r.secret_version_digest } : {}), source: r.source, sourceDigest: r.source_digest,
    observedAt: iso(r.observed_at), recordedAt: iso(r.recorded_at),
  };
};

function checked(input: Omit<MixedOutputRecord, "recordedAt">): void {
  const bad = (field: string): never => { throw new ControlStoreError("invalid_input", `${field} is malformed.`, { field }); };
  if (!ID.test(input.workspaceId)) bad("workspaceId");
  if (!ID.test(input.planId)) bad("planId");
  if (!ID.test(input.producerOperationId)) bad("producerOperationId");
  if (!PARTITION.test(input.producerPartitionId)) bad("producerPartitionId");
  if (!PARTITION.test(input.consumerPartitionId)) bad("consumerPartitionId");
  if (typeof input.referenceId !== "string" || input.referenceId.length < 1 || input.referenceId.length > 200) bad("referenceId");
  if (!TYPES.has(input.valueType)) bad("valueType");
  requireDigest("valueDigest", input.valueDigest);
  requireDigest("sourceDigest", input.sourceDigest);
  if ((input.valueType === "secret_ref") !== (input.secretRef !== undefined)) bad("secretRef");
  if ((input.secretRef === undefined) !== (input.secretVersionDigest === undefined)) bad("secretVersionDigest");
  if (input.secretRef !== undefined && !VAULT.test(input.secretRef)) bad("secretRef");
  if (input.secretVersionDigest !== undefined) requireDigest("secretVersionDigest", input.secretVersionDigest);
  // a secret never carries a value; every other type must
  if ((input.valueType === "secret_ref") !== (input.value === undefined)) bad("value");
  if (input.value !== undefined && !["string", "number", "boolean"].includes(typeof input.value)) bad("value");
  if (typeof input.value === "string" && (input.value.length === 0 || input.value.length > 2048)) bad("value");
  if (typeof input.value === "number" && !Number.isFinite(input.value)) bad("value");
  if (Number.isNaN(Date.parse(input.observedAt))) bad("observedAt");
}

/** Record one producer output (idempotent for an identical value digest). */
export async function recordOutput(sql: Sql, input: Omit<MixedOutputRecord, "recordedAt">): Promise<{ record: MixedOutputRecord; created: boolean }> {
  checked(input);
  const inserted = await sql.query<Row>(
    `insert into platform.mixed_output_records (workspace_id, plan_id, reference_id, producer_partition_id, consumer_partition_id, producer_operation_id,
       producer_address, producer_output, value_type, value_digest, value, secret_ref, secret_version_digest, source, source_digest, observed_at)
     select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb, $12, $13, $14, $15, $16::timestamptz
      where exists (select 1 from platform.mixed_parent_plans p where p.workspace_id = $1 and p.plan_id = $2)
     on conflict (workspace_id, plan_id, reference_id) do nothing
     returning ${COLUMNS}`,
    [input.workspaceId, input.planId, input.referenceId, input.producerPartitionId, input.consumerPartitionId, input.producerOperationId, input.producerAddress,
      input.producerOutput, input.valueType, input.valueDigest, input.value === undefined ? null : JSON.stringify({ v: input.value }), input.secretRef ?? null,
      input.secretVersionDigest ?? null, input.source, input.sourceDigest, input.observedAt]);
  if (inserted[0]) return { record: toRecord(inserted[0]), created: true };
  const existing = await getOutput(sql, input.workspaceId, input.planId, input.referenceId);
  if (!existing) throw new ControlStoreError("not_found", "The mixed plan was not found.");
  if (existing.valueDigest !== input.valueDigest || existing.secretRef !== input.secretRef || existing.secretVersionDigest !== input.secretVersionDigest) {
    throw new ControlStoreError("conflict", "A different value was already recorded for this reference of the plan; a changed value needs a new plan and review.", { referenceId: input.referenceId });
  }
  return { record: existing, created: false };
}

export async function getOutput(sql: Sql, workspaceId: string, planId: string, referenceId: string): Promise<MixedOutputRecord | null> {
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from platform.mixed_output_records where workspace_id = $1 and plan_id = $2 and reference_id = $3`, [workspaceId, planId, referenceId]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listOutputs(sql: Sql, workspaceId: string, planId: string): Promise<MixedOutputRecord[]> {
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from platform.mixed_output_records where workspace_id = $1 and plan_id = $2 order by recorded_at, reference_id limit 500`, [workspaceId, planId]);
  return rows.map(toRecord);
}

/** The mixed plan and partition a child operation is bound to (this workspace only), or null when it is not a mixed child. */
export async function findChildByOperation(sql: Sql, workspaceId: string, operationId: string): Promise<{ planId: string; partitionId: string } | null> {
  const rows = await sql.query<{ plan_id: string; partition_id: string }>(
    `select plan_id, partition_id from platform.mixed_child_plans where workspace_id = $1 and child_operation_id = $2`, [workspaceId, operationId]);
  return rows[0] ? { planId: rows[0].plan_id, partitionId: rows[0].partition_id } : null;
}

export interface ProducerObservationRow {
  observationId: number;
  address: string;
  externalId?: string;
  attributes: Record<string, unknown>;
  observedAt: string;
  source: string;
}

/**
 * The newest REAL observation of one producer resource taken while the producing child operation ran: not before the
 * operation was created, not after `notAfter` (the child's recorded receipt), present, not simulated and without a driver
 * error. These rows were written by the child's own observe step inside its brokered observe session; nothing here reads a
 * cloud. The environment is the producing child's own environment, and every statement names the workspace.
 */
export async function readProducerObservation(sql: Sql, input: { workspaceId: string; environmentId: string; operationId: string; address: string; notAfter: string }): Promise<ProducerObservationRow | null> {
  const rows = await sql.query<{ id: string | number; address: string; external_id: string | null; attributes: unknown; observed_at: unknown; source: string }>(
    `select o.id, o.address, o.external_id, o.attributes, o.observed_at, o.source
       from platform.resource_observations o
       join platform.operations op on op.workspace_id = o.workspace_id and op.id = $3 and op.environment_id = o.environment_id
      where o.workspace_id = $1 and o.environment_id = $2 and o.address = $4
        and o.presence = 'present' and o.simulated = false and o.error is null
        and o.observed_at >= op.created_at and o.observed_at <= $5::timestamptz
      order by o.observed_at desc, o.id desc limit 1`,
    [input.workspaceId, input.environmentId, input.operationId, input.address, input.notAfter]);
  const row = rows[0];
  if (!row) return null;
  return {
    observationId: Number(row.id), address: row.address, ...(row.external_id ? { externalId: row.external_id } : {}),
    attributes: (typeof row.attributes === "string" ? JSON.parse(row.attributes) : row.attributes) as Record<string, unknown>, observedAt: iso(row.observed_at), source: row.source,
  };
}
