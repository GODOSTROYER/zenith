/**
 * Typed, scoped dependency outputs between child plans (PROD-MIX-03).
 *
 * A `TypedOutput` is the only thing that crosses from a producing child to a consuming
 * child. It carries: a declared type; the scope it may be used in (workspace,
 * environment, the exact consumer child and its connection); provenance (the producing
 * child's subplan and effect digests, the resource address and output name, the child
 * receipt and artifact digests); and for secrets only a vault REFERENCE and its version
 * digest, never a value. The producing child must have SUCCEEDED in the run with that
 * very receipt.
 *
 * A new materialization changes what the consuming child will do (its `effectDigest`).
 * `assessOutputConsumption` re-plans with the outputs applied (reusing the partition
 * planner's provenance checks and `classifyMixedPlanChange`) and decides:
 *   unchanged       the outputs equal what was reviewed;
 *   preauthorized   every changed reference is covered by a live, precise preauthorization
 *                   (see preauthorization.ts), still bound to the same desired digest;
 *   review_required a person must review the new parent digest before the consumer starts.
 * Nothing here approves anything. The decision only says which authority is needed.
 */
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import { classifyMixedPlanChange, MixedPartitionError, planMixedPartitions, type MixedPartitionInput, type MixedPartitionPlan, type PartitionValueType } from "../mixed-partitions";
import type { ParentPlanView } from "./child-view";
import { issueDecision, type DecisionConsumer, type OutputConsumptionDecision } from "./decision";
import { cmp, ID, refuse, SHA, sortedUnique, VAULT_REF } from "./errors";
import type { OutputPreauthorization } from "./preauthorization";
import type { MixedRunState } from "./run";

const TYPES = ["string", "number", "boolean", "resource_id", "endpoint", "secret_ref"] as const;
const FIELD = /^[A-Za-z_][A-Za-z0-9_./:[\]-]{0,511}$/;
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9_./:@*+-]{0,255}$/;

const OutputSchema = z.object({
  referenceId: z.string().regex(ID),
  type: z.enum(TYPES),
  scope: z.object({
    workspaceId: z.string().regex(ID), environmentId: z.string().regex(ID),
    consumerChildId: z.string().min(1).max(200), consumerConnectionId: z.string().regex(ID),
  }).strict(),
  provenance: z.object({
    producerChildId: z.string().min(1).max(200), producerAddress: z.string().regex(ADDRESS), producerOutput: z.string().regex(FIELD),
    producerConnectionId: z.string().regex(ID), producerSubplanDigest: z.string().regex(SHA), producerEffectDigest: z.string().regex(SHA),
    receiptDigest: z.string().regex(SHA), artifactDigest: z.string().regex(SHA),
  }).strict(),
  /** Digest of the value; the value itself is never carried. For a secret: digest of {ref, versionDigest}. */
  valueDigest: z.string().regex(SHA),
  secret: z.object({ ref: z.string().regex(VAULT_REF), versionDigest: z.string().regex(SHA) }).strict().optional(),
}).strict();

export type TypedOutput = z.infer<typeof OutputSchema> & { type: PartitionValueType };
const validated = new WeakSet<object>();

const SECRETISH = /(secret|password|passwd|token|credential|private|apikey|api_key|access_?key|value|plaintext)/i;

/** Parse a candidate output; any key outside the closed contract is refused (a secret-looking one as a secret value). */
export function parseTypedOutput(raw: unknown): TypedOutput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse("invalid_input");
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || !value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (SECRETISH.test(key) && key !== "secret" && key !== "valueDigest" && key !== "versionDigest" && !Object.hasOwn(OutputSchema.shape, key)) refuse("secret_value");
      walk(child, depth + 1);
    }
  };
  walk(raw, 0);
  const parsed = OutputSchema.safeParse(raw);
  if (!parsed.success) return refuse("invalid_input");
  return parsed.data;
}

/**
 * Check one output against the typed contract, the scope and the producing child's recorded success.
 * Returns the frozen, branded output; throws a `MixedOrchestrationError` otherwise.
 */
export function validateOutput(raw: unknown, state: MixedRunState, view: ParentPlanView): TypedOutput {
  const output = parseTypedOutput(raw);
  const reference = view.references.find((item) => item.id === output.referenceId);
  if (!reference) return refuse("contract_mismatch", output.referenceId);
  if (output.type !== reference.type) return refuse("contract_mismatch", reference.id);
  const consumer = view.children.find((child) => child.id === reference.consumerChildId);
  const producer = view.children.find((child) => child.id === reference.producerChildId);
  if (!consumer || !producer) return refuse("unknown_child");
  const { scope, provenance } = output;
  if (scope.workspaceId !== view.workspaceId || scope.workspaceId !== state.workspaceId || scope.environmentId !== view.environmentId || scope.environmentId !== state.environmentId
    || scope.consumerChildId !== consumer.id || scope.consumerConnectionId !== consumer.connectionId) return refuse("scope_mismatch", reference.id);
  if (provenance.producerChildId !== producer.id || provenance.producerAddress !== reference.producerAddress || provenance.producerOutput !== reference.producerOutput
    || provenance.producerConnectionId !== producer.connectionId || provenance.producerSubplanDigest !== producer.subplanDigest) return refuse("output_provenance", reference.id);
  const produced = state.children[producer.id];
  if (!produced || produced.status !== "succeeded" || !produced.receiptDigest) return refuse("producer_not_succeeded", producer.id);
  if (produced.receiptDigest !== provenance.receiptDigest || produced.effectDigest !== provenance.producerEffectDigest || produced.subplanDigest !== provenance.producerSubplanDigest) return refuse("output_provenance", reference.id);
  if ((output.type === "secret_ref") !== (output.secret !== undefined)) return refuse(output.secret ? "secret_value" : "contract_mismatch", reference.id);
  if (output.secret && output.valueDigest !== digest({ ref: output.secret.ref, versionDigest: output.secret.versionDigest })) return refuse("output_provenance", reference.id);
  const sealed = Object.freeze(structuredClone(output)) as TypedOutput;
  validated.add(sealed);
  return sealed;
}

function mapPlannerError(error: unknown): never {
  if (error instanceof MixedPartitionError) {
    if (error.code === "provenance_mismatch") return refuse("output_provenance");
    if (error.code === "secret_data") return refuse("secret_value");
    if (error.code === "reference_contract") return refuse("contract_mismatch");
    if (error.code === "dependency_cycle") return refuse("dependency_cycle");
  }
  return refuse("invalid_input");
}

/** The planner input with the validated outputs applied as available materializations. */
export function applyOutputs(input: MixedPartitionInput, plan: MixedPartitionPlan, outputs: readonly TypedOutput[]): MixedPartitionInput {
  const next = structuredClone(input);
  const seen = new Set<string>();
  for (const output of outputs) {
    if (!validated.has(output) || seen.has(output.referenceId)) return refuse("invalid_input");
    seen.add(output.referenceId);
    const reference = next.references.find((item) => item.id === output.referenceId);
    if (!reference) return refuse("contract_mismatch", output.referenceId);
    const producer = plan.partitions.find((partition) => partition.nodes.some((node) => node.address === reference.producer.address));
    const node = next.graph.nodes.find((item) => item.address === reference.producer.address);
    if (!producer || !node) return refuse("unknown_child");
    reference.materialization = {
      state: "available", valueDigest: output.valueDigest,
      provenance: {
        workspaceId: output.scope.workspaceId, environmentId: output.scope.environmentId, connectionId: output.provenance.producerConnectionId,
        provider: producer.identity.provider, accountId: producer.identity.accountId, region: producer.identity.region,
        producerAddress: reference.producer.address, producerSpecDigest: node.specDigest, producerSubplanDigest: output.provenance.producerSubplanDigest,
        producerEffectDigest: output.provenance.producerEffectDigest, receiptDigest: output.provenance.receiptDigest, artifactDigest: output.provenance.artifactDigest,
      },
      ...(output.secret ? { secret: { ref: output.secret.ref, versionDigest: output.secret.versionDigest, workspaceId: output.scope.workspaceId,
        environmentId: output.scope.environmentId, consumerConnectionId: output.scope.consumerConnectionId } } : {}),
    };
  }
  return next;
}

/** Whether one preauthorization covers exactly this changed reference (no wildcard, no widening). */
export function preauthorizationCovers(grant: OutputPreauthorization, ctx: {
  workspaceId: string; environmentId: string; parentOperationId: string; desiredDigest: string; contractDigest: string; consumerSubplanDigest: string; output: TypedOutput; now: Date;
}): boolean {
  const { output } = ctx;
  if (grant.status !== "active" || grant.workspaceId !== ctx.workspaceId || grant.environmentId !== ctx.environmentId) return false;
  if (Date.parse(grant.expiresAt) <= ctx.now.getTime() || grant.uses >= grant.maxUses) return false;
  if (grant.parentOperationId !== ctx.parentOperationId || grant.desiredDigest !== ctx.desiredDigest || grant.referenceId !== output.referenceId || grant.contractDigest !== ctx.contractDigest) return false;
  if (grant.consumerSubplanDigest !== ctx.consumerSubplanDigest || grant.producerSubplanDigest !== output.provenance.producerSubplanDigest || grant.valueType !== output.type) return false;
  if (output.type === "secret_ref" && (!output.secret || grant.secretRef !== output.secret.ref)) return false;
  if (output.type !== "secret_ref" && grant.secretRef !== undefined) return false;
  if (grant.valueDigest !== undefined && grant.valueDigest !== output.valueDigest) return false;
  return true;
}

export interface AssessInput {
  /** The exact planner input a person approved (outputs still unavailable or at their reviewed values). */
  approvedInput: MixedPartitionInput;
  /** The parent operation the run belongs to; a preauthorization names exactly one. */
  parentOperationId: string;
  outputs: readonly TypedOutput[];
  /** Resolved from the store by id (never caller-built); liveness is re-checked here against `now`. */
  preauthorizations: readonly OutputPreauthorization[];
  now: Date;
}

export function assessOutputConsumption(args: AssessInput): OutputConsumptionDecision {
  let approvedPlan: MixedPartitionPlan;
  let newPlan: MixedPartitionPlan;
  let newInput: MixedPartitionInput;
  try {
    approvedPlan = planMixedPartitions(args.approvedInput);
    newInput = applyOutputs(args.approvedInput, approvedPlan, args.outputs);
    newPlan = planMixedPartitions(newInput);
  } catch (error) {
    return mapPlannerError(error);
  }
  const change = classifyMixedPlanChange(approvedPlan, newPlan);
  const base = { workspaceId: newPlan.workspaceId, environmentId: newPlan.environmentId, desiredDigest: newPlan.desiredDigest, requiredParentDigest: newPlan.parentDigest };
  if (change.classification === "unchanged") return issueDecision({ classification: "unchanged", ...base, reasons: [], consumers: [], preauthorizationIds: [], uncovered: [] });

  const oldRefs = new Map(approvedPlan.references.map((reference) => [reference.id, reference]));
  const changedRefs = newPlan.references.filter((reference) => oldRefs.get(reference.id)?.materializationDigest !== reference.materializationDigest);
  const oldPartitions = new Map(approvedPlan.partitions.map((partition) => [partition.id, partition]));
  const consumers: DecisionConsumer[] = [];
  for (const partition of newPlan.partitions) {
    const previous = oldPartitions.get(partition.id);
    if (!previous || previous.effectDigest === partition.effectDigest) continue;
    consumers.push({ childId: partition.id, previousEffectDigest: previous.effectDigest, newEffectDigest: partition.effectDigest,
      referenceIds: changedRefs.filter((reference) => reference.consumerPartitionId === partition.id).map((reference) => reference.id).sort(cmp) });
  }
  consumers.sort((a, b) => cmp(a.childId, b.childId));
  const reasons = [...change.reasons];
  // Desired inputs or scope can never be pre-covered: only a materialized value of an already approved contract can.
  const semanticChange = change.reasons.includes("scope_changed") || change.reasons.includes("desired_inputs_changed");
  const byRef = new Map(args.outputs.map((output) => [output.referenceId, output]));
  const used = new Set<string>();
  const uncovered: string[] = [];
  for (const reference of changedRefs) {
    const output = byRef.get(reference.id);
    const consumer = newPlan.partitions.find((partition) => partition.id === reference.consumerPartitionId);
    const covering = !semanticChange && output && consumer
      ? args.preauthorizations.find((grant) => preauthorizationCovers(grant, { workspaceId: newPlan.workspaceId, environmentId: newPlan.environmentId, parentOperationId: args.parentOperationId,
        desiredDigest: newPlan.desiredDigest, contractDigest: reference.contractDigest, consumerSubplanDigest: consumer.subplanDigest, output, now: args.now }))
      : undefined;
    if (covering) used.add(covering.id); else uncovered.push(reference.id);
  }
  // A changed effect with no changed reference of ours (conservative cascade) is never covered.
  const covered = !semanticChange && changedRefs.length > 0 && uncovered.length === 0 && consumers.every((consumer) => consumer.referenceIds.length > 0);
  return issueDecision({ classification: covered ? "preauthorized" : "review_required", ...base, reasons, consumers,
    preauthorizationIds: covered ? sortedUnique(used) : [], uncovered: sortedUnique(uncovered) });
}
