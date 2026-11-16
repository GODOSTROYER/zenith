/**
 * The producer output reader of the mixed run (PROD-MIX follow-up).
 *
 * A consumer with incoming cross-partition references needs the producer's typed outputs once the producer succeeded. The
 * producer's own apply activity captures them while its broker grant is live (typed-inputs.ts: `tofu output -json`, sensitive
 * ones sealed into the vault, everything recorded in `platform.mixed_output_records`). This module is the run-side reader of
 * those records, with a fallback READING source for a producer whose apply captured nothing (production: the producer's own
 * post-apply observation, see output-source.ts). It turns them into the closed `TypedOutput` documents the run orchestration
 * validates (contract, scope, provenance, the producer's recorded success):
 *
 *  - a RECORDED output wins: the source is never read again, so the planner input is stable across retries, and the record must
 *    name the very operation of the producer's receipt;
 *  - a plain value is recorded with its value (non-secret class) and its digest `digest({type, value})`;
 *  - a secret becomes a vault REFERENCE plus a version digest: material from a sensitive source is sealed into the workspace
 *    vault under a ref derived from plan, producer and reference; a source that names an existing vault entry is checked against
 *    the workspace vault. A secret value is never accepted as a plain output and a plain value is never accepted as a secret;
 *  - a disagreeing re-read is a conflict, never an overwrite.
 *
 * Anything unreadable refuses the whole producer batch with `ProducerOutputError`: the join turns that into a blocked consumer,
 * never a start on a guess. A changed parent digest that results from materializing these values is NOT decided here: it goes
 * through the run's existing review / new-parent-approval-round path (`consumeOutputs`).
 */
import { digest } from "@/lib/controlplane/digest";
import type { MixedOutputRecord } from "@/lib/controlplane/db/repos/mixed-output-records";
import type { ChildReceipt, ChildSubplan, MixedParentPlan } from "./types";
import type { MixedWorld } from "./world";

export type ProducerOutputErrorCode = "not_readable" | "type_mismatch" | "secret_refused" | "receipt_mismatch" | "conflict" | "invalid_plan";

const MESSAGES: Record<ProducerOutputErrorCode, string> = {
  not_readable: "The producing child's output could not be read back.",
  type_mismatch: "The value read back does not have the declared output type.",
  secret_refused: "A secret output must be a vault reference; a plain value or a missing vault entry was refused.",
  receipt_mismatch: "The producer's receipt does not describe a succeeded child of this plan.",
  conflict: "The value read back disagrees with the output already recorded for this reference.",
  invalid_plan: "The stored plan does not declare this reference.",
};

/** Fixed text only; `detail` holds reference and child ids the caller already knows, never a value. */
export class ProducerOutputError extends Error {
  constructor(readonly code: ProducerOutputErrorCode, readonly detail: readonly string[] = []) {
    super(MESSAGES[code]);
    this.name = "ProducerOutputError";
  }
}

export interface ProducerReading {
  value: unknown;
  /** True when the value is secret material (a sensitive tofu output): it is sealed into the vault, never recorded. */
  sensitive: boolean;
  source: "observation" | "tofu_output";
  /** Digest of the source identity (not of the value); provenance of WHAT was read. */
  sourceDigest: string;
  observedAt: string;
}

export interface ProducerReadInput {
  workspaceId: string;
  plan: MixedParentPlan;
  producer: ChildSubplan;
  childOperationId: string;
  receipt: ChildReceipt;
  references: readonly { referenceId: string; producerAddress: string; producerOutput: string }[];
}

/** What read-back of the producing partition yields per reference. Absent or `{ unreadable }` means "not read". */
export interface ProducerReadingSource {
  read(input: ProducerReadInput): Promise<ReadonlyMap<string, ProducerReading | { unreadable: string }>>;
}

export interface VaultPort {
  status(workspaceId: string, ref: string): Promise<{ exists: boolean; version?: number }>;
  put(workspaceId: string, ref: string, value: string, by: string): Promise<{ version: number }>;
}

/** Append-only record of what was read: the platform table in production, a memory implementation in contract tests. */
export interface OutputRecordStore {
  get(workspaceId: string, planId: string, referenceId: string): Promise<MixedOutputRecord | null>;
  /** Idempotent for an identical value digest; a different value for the same key throws an error with `code: "conflict"`. */
  record(input: Omit<MixedOutputRecord, "recordedAt">): Promise<{ record: MixedOutputRecord; created: boolean }>;
}

export interface OutputReaderDeps {
  records: OutputRecordStore;
  source: ProducerReadingSource;
  vault: VaultPort;
  now?: () => Date;
}

const VAULT_REF = /^vault:[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_TEXT = 2048;
export const OUTPUT_READER_ACTOR = "zenith-mixed-output-reader";

/** The vault reference a sealed secret output lives under: derived only from plan, producer and reference ids. */
export function secretOutputRef(plan: Pick<MixedParentPlan, "projectId" | "parentPlanId">, producerPartitionId: string, referenceId: string): string {
  const project = plan.projectId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100) || `p${digest(plan.projectId).slice(0, 16)}`;
  return `vault:${project}/mix${digest({ plan: plan.parentPlanId, producer: producerPartitionId }).slice(0, 24)}/out${digest({ reference: referenceId }).slice(0, 24)}`;
}

const printable = (text: string): boolean => text.length > 0 && text.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/.test(text);

/** Validate a plain value against the declared type and return it with its digest. Throws `type_mismatch`. */
export function plainValueOf(type: string, value: unknown, referenceId: string): { value: string | number | boolean; valueDigest: string } {
  const mismatch = (): never => { throw new ProducerOutputError("type_mismatch", [referenceId]); };
  if (type === "string" || type === "resource_id" || type === "endpoint") {
    if (typeof value !== "string" || !printable(value)) return mismatch();
  } else if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return mismatch();
  } else if (type === "boolean") {
    if (typeof value !== "boolean") return mismatch();
  } else return mismatch();
  return { value: value as string | number | boolean, valueDigest: digest({ type, value }) };
}

export interface OutputRowContext {
  workspaceId: string;
  plan: MixedParentPlan;
  producer: ChildSubplan;
  producerOperationId: string;
  reference: MixedParentPlan["references"][number];
  producerAddress: string;
  producerOutput: string;
}

/**
 * One reading becomes one record row: a plain value with its digest, or a secret sealed into (or checked against) the vault and
 * reduced to a reference and a version digest. Shared by this reader and the producer's apply-time capture.
 */
export async function prepareOutputRow(vault: VaultPort, ctx: OutputRowContext, reading: ProducerReading): Promise<Omit<MixedOutputRecord, "recordedAt">> {
  const referenceId = ctx.reference.referenceId;
  const type = ctx.reference.valueType;
  if (!type) throw new ProducerOutputError("invalid_plan", [referenceId]);
  if (Number.isNaN(Date.parse(reading.observedAt)) || !SHA.test(reading.sourceDigest)) throw new ProducerOutputError("not_readable", [referenceId]);
  const base = {
    workspaceId: ctx.workspaceId, planId: ctx.plan.parentPlanId, referenceId, producerPartitionId: ctx.producer.partitionId,
    consumerPartitionId: ctx.reference.consumerPartitionId, producerOperationId: ctx.producerOperationId, producerAddress: ctx.producerAddress, producerOutput: ctx.producerOutput,
    valueType: type, source: reading.source, sourceDigest: reading.sourceDigest, observedAt: new Date(reading.observedAt).toISOString(),
  };
  if (type !== "secret_ref") {
    if (reading.sensitive) throw new ProducerOutputError("secret_refused", [referenceId]);
    return { ...base, ...plainValueOf(type, reading.value, referenceId) };
  }
  if (typeof reading.value !== "string" || reading.value.length === 0) throw new ProducerOutputError("secret_refused", [referenceId]);
  let ref: string;
  let version: number;
  if (reading.sensitive) {
    // Secret material: sealed into the workspace vault now; only the reference and its version leave this function.
    ref = secretOutputRef(ctx.plan, ctx.producer.partitionId, referenceId);
    if (!VAULT_REF.test(ref)) throw new ProducerOutputError("secret_refused", [referenceId]);
    version = (await vault.put(ctx.workspaceId, ref, reading.value, OUTPUT_READER_ACTOR)).version;
  } else {
    // A named vault entry: it must exist in THIS workspace, so a reference to someone else's secret is refused.
    if (!VAULT_REF.test(reading.value)) throw new ProducerOutputError("secret_refused", [referenceId]);
    const status = await vault.status(ctx.workspaceId, reading.value);
    if (!status.exists || typeof status.version !== "number") throw new ProducerOutputError("secret_refused", [referenceId]);
    ref = reading.value;
    version = status.version;
  }
  const versionDigest = digest({ ref, version });
  return { ...base, valueDigest: digest({ ref, versionDigest }), secretRef: ref, secretVersionDigest: versionDigest };
}

const isUnreadable = (reading: ProducerReading | { unreadable: string } | undefined): reading is { unreadable: string } | undefined => reading === undefined || "unreadable" in reading;

/** Record a prepared row, mapping a store conflict to the fixed refusal. */
export async function recordPrepared(records: OutputRecordStore, row: Omit<MixedOutputRecord, "recordedAt">): Promise<MixedOutputRecord> {
  try {
    return (await records.record(row)).record;
  } catch (error) {
    if (typeof error === "object" && error && (error as { code?: unknown }).code === "conflict") throw new ProducerOutputError("conflict", [row.referenceId]);
    throw error;
  }
}

/** Build the `childTypedOutputs` implementation of the production world. */
export function createProducerOutputReader(deps: OutputReaderDeps): NonNullable<MixedWorld["childTypedOutputs"]> {
  return async (workspaceId, producerRef, references) => {
    const { plan, receipt, effectDigest } = producerRef;
    const producer = plan.children.find((child) => child.partitionId === producerRef.partitionId);
    if (!producer || plan.workspaceId !== workspaceId || receipt.workspaceId !== workspaceId || receipt.parentPlanId !== plan.parentPlanId || receipt.partitionId !== producer.partitionId
      || receipt.outcome !== "succeeded" || receipt.receiptDigest !== producerRef.receiptDigest || receipt.childOperationId !== producerRef.childOperationId) throw new ProducerOutputError("receipt_mismatch", [producerRef.partitionId]);

    const declared = new Map(plan.references.map((reference) => [reference.referenceId, reference]));
    for (const wanted of references) {
      const reference = declared.get(wanted.referenceId);
      if (!reference || reference.producerPartitionId !== producer.partitionId || reference.consumerPartitionId !== wanted.consumerChildId || reference.producerAddress !== wanted.producerAddress
        || reference.producerOutput !== wanted.producerOutput || !reference.valueType) throw new ProducerOutputError("invalid_plan", [wanted.referenceId]);
    }

    // Recorded outputs win: the producer's apply-time capture, a retry, a resumed activity or a rebuilt planner input.
    const recorded = new Map<string, MixedOutputRecord>();
    const toRead: typeof references[number][] = [];
    for (const wanted of references) {
      const existing = await deps.records.get(workspaceId, plan.parentPlanId, wanted.referenceId);
      if (!existing) { toRead.push(wanted); continue; }
      // A record must be this producer's own: the operation the receipt names, never another run's.
      if (existing.producerOperationId !== receipt.childOperationId || existing.producerPartitionId !== producer.partitionId) throw new ProducerOutputError("receipt_mismatch", [wanted.referenceId]);
      recorded.set(wanted.referenceId, existing);
    }
    const readings = toRead.length
      ? await deps.source.read({ workspaceId, plan, producer, childOperationId: producerRef.childOperationId, receipt, references: toRead.map(({ referenceId, producerAddress, producerOutput }) => ({ referenceId, producerAddress, producerOutput })) })
      : new Map<string, ProducerReading | { unreadable: string }>();

    // Validate everything before writing anything: one unreadable reference refuses the batch.
    const fresh: Omit<MixedOutputRecord, "recordedAt">[] = [];
    for (const wanted of toRead) {
      const reading = readings.get(wanted.referenceId);
      if (isUnreadable(reading)) throw new ProducerOutputError("not_readable", [wanted.referenceId]);
      fresh.push(await prepareOutputRow(deps.vault, { workspaceId, plan, producer, producerOperationId: producerRef.childOperationId, reference: declared.get(wanted.referenceId)!, producerAddress: wanted.producerAddress, producerOutput: wanted.producerOutput }, reading));
    }
    for (const row of fresh) recorded.set(row.referenceId, await recordPrepared(deps.records, row));

    const artifactDigest = [receipt.outputsDigest, receipt.planDigest].find((candidate): candidate is string => typeof candidate === "string" && SHA.test(candidate))
      ?? digest({ receipt: receipt.receiptDigest, artifact: "none" });
    return references.map((wanted) => {
      const record = recorded.get(wanted.referenceId)!;
      const consumer = plan.children.find((child) => child.partitionId === record.consumerPartitionId);
      if (!consumer) throw new ProducerOutputError("invalid_plan", [wanted.referenceId]);
      return {
        referenceId: record.referenceId,
        type: record.valueType,
        scope: { workspaceId, environmentId: plan.parentEnvironmentId, consumerChildId: consumer.partitionId, consumerConnectionId: consumer.authority.connectionId },
        provenance: {
          producerChildId: producer.partitionId, producerAddress: record.producerAddress, producerOutput: record.producerOutput, producerConnectionId: producer.authority.connectionId,
          producerSubplanDigest: producer.subplanDigest, producerEffectDigest: effectDigest, receiptDigest: receipt.receiptDigest, artifactDigest,
        },
        valueDigest: record.valueDigest,
        ...(record.secretRef && record.secretVersionDigest ? { secret: { ref: record.secretRef, versionDigest: record.secretVersionDigest } } : {}),
      };
    });
  };
}
