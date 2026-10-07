/**
 * Platform composition of the typed-input port (PROD-MIX follow-up, round 2).
 *
 * Producer side (`capture`, called by the producing child's own apply activity while its broker grant is live): the apply's
 * `tofu output -json` entries that a consumer declared a reference on are recorded in `platform.mixed_output_records` with
 * provenance (child operation, resource address, output name, plan digest). A non-secret value is stored; a sensitive output is
 * sealed into the workspace vault right here and only its vault reference and version digest are recorded.
 *
 * Consumer side (`load`, `resolveSecret`, called when the consumer's own execution context is built and when its plan/apply
 * session is created): the recorded outputs of the references the consumer declared, cross-checked against the producer's
 * recorded receipt (the very operation that produced them). A secret is resolved from the vault only for THIS operation, only if
 * it is one of its declared inputs and only while the vault version still equals the recorded version digest.
 *
 * Which tofu output carries a reference: `<sanitized producer address>_<output>` first (the drivers' own naming), else the bare
 * `<output>` name. A missing output records nothing (the run's other source or the consumer's refusal covers it); a mistyped
 * one refuses.
 */
import { digest } from "@/lib/controlplane/digest";
import * as outputRecords from "@/lib/controlplane/db/repos/mixed-output-records";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import type { Sql } from "@/lib/controlplane/types";
import { readSecretValueAsync } from "@/lib/secrets";
import { sanitizeLabel } from "../compile";
import { StepFailedError } from "../errors";
import { INPUT_NAME, type CapturedOutputs, type ConsumedInput, type ProducerContract, type TypedInputsPort } from "../typed-inputs";
import { platformOutputRecordStore, platformVaultPort } from "./output-source";
import { prepareOutputRow, ProducerOutputError, recordPrepared, type OutputRecordStore, type VaultPort } from "./output-reader";
import type { MixedParentPlan } from "./types";

export interface TypedInputsDeps {
  sql: Sql;
  records?: OutputRecordStore;
  vault?: VaultPort;
  readSecret?: (workspaceId: string, ref: string) => Promise<string | undefined>;
  now?: () => Date;
}

/** The tofu output name carrying a reference, or undefined. */
export function outputNameFor(names: Iterable<string>, producerAddress: string, producerOutput: string): string | undefined {
  const present = new Set(names);
  const namespaced = `${sanitizeLabel(producerAddress)}_${producerOutput}`;
  if (present.has(namespaced)) return namespaced;
  return present.has(producerOutput) ? producerOutput : undefined;
}

export function createPlatformTypedInputs(deps: TypedInputsDeps): TypedInputsPort {
  const records = deps.records ?? platformOutputRecordStore(deps.sql);
  const vault = deps.vault ?? platformVaultPort();
  const readSecret = deps.readSecret ?? readSecretValueAsync;
  const now = deps.now ?? (() => new Date());

  const binding = async (workspaceId: string, operationId: string): Promise<{ plan: MixedParentPlan; partitionId: string } | null> => {
    const child = await outputRecords.findChildByOperation(deps.sql, workspaceId, operationId);
    if (!child) return null;
    const stored = await plans.getPlan(deps.sql, workspaceId, child.planId);
    return stored ? { plan: stored.plan, partitionId: child.partitionId } : null;
  };

  const producerContract = async (workspaceId: string, operationId: string): Promise<readonly ProducerContract[]> => {
    const bound = await binding(workspaceId, operationId);
    if (!bound) return [];
    return bound.plan.references
      .filter((ref) => ref.producerPartitionId === bound.partitionId && ref.producerAddress && ref.producerOutput && ref.valueType)
      .map((ref) => ({ referenceId: ref.referenceId, producerAddress: ref.producerAddress!, producerOutput: ref.producerOutput!, type: ref.valueType! }));
  };

  const load = async (workspaceId: string, operationId: string): Promise<readonly ConsumedInput[]> => {
    const bound = await binding(workspaceId, operationId);
    if (!bound) return [];
    const incoming = bound.plan.references.filter((ref) => ref.consumerPartitionId === bound.partitionId);
    const out: ConsumedInput[] = [];
    for (const ref of incoming) {
      if (!ref.consumerInput || !ref.valueType || !INPUT_NAME.test(ref.consumerInput)) throw new StepFailedError("A declared dependency input has no usable name or type; plan again before running this child.");
      const record = await records.get(workspaceId, bound.plan.parentPlanId, ref.referenceId);
      if (!record) throw new StepFailedError("A dependency output this child consumes has not been recorded; it will not run on a guess.");
      const receipt = await plans.getReceipt(deps.sql, workspaceId, bound.plan.parentPlanId, ref.producerPartitionId);
      if (!receipt || receipt.outcome !== "succeeded" || receipt.childOperationId !== record.producerOperationId || record.valueType !== ref.valueType
        || record.consumerPartitionId !== bound.partitionId || record.producerPartitionId !== ref.producerPartitionId) {
        throw new StepFailedError("A dependency output this child consumes is not the recorded output of its succeeded producer.");
      }
      out.push({
        name: ref.consumerInput, referenceId: ref.referenceId, type: record.valueType, valueDigest: record.valueDigest,
        ...(record.secretRef && record.secretVersionDigest ? { secret: { ref: record.secretRef, versionDigest: record.secretVersionDigest } } : {}),
        ...(record.value !== undefined ? { value: record.value } : {}),
      });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };

  return {
    producerContract,

    async capture(input: CapturedOutputs) {
      const bound = await binding(input.workspaceId, input.operationId);
      if (!bound) return { recorded: 0 };
      const producer = bound.plan.children.find((child) => child.partitionId === bound.partitionId);
      if (!producer) throw new ProducerOutputError("invalid_plan", [bound.partitionId]);
      let recorded = 0;
      let failure: unknown;
      for (const contract of await producerContract(input.workspaceId, input.operationId)) {
        const name = outputNameFor(Object.keys(input.outputs), contract.producerAddress, contract.producerOutput);
        if (!name) continue;
        const entry = input.outputs[name];
        try {
          const reading = {
            value: entry.sensitive ? input.sensitive?.[name] : entry.value, sensitive: entry.sensitive === true, source: "tofu_output" as const,
            sourceDigest: digest({ operation: input.operationId, plan: input.planDigest, output: name }), observedAt: now().toISOString(),
          };
          if (reading.value === undefined) throw new ProducerOutputError("not_readable", [contract.referenceId]);
          // A secret is sealed once: a retried apply activity finds its own record and does not rotate the vault entry again.
          if (contract.type === "secret_ref") {
            const existing = await records.get(input.workspaceId, bound.plan.parentPlanId, contract.referenceId);
            if (existing) {
              if (existing.producerOperationId !== input.operationId) throw new ProducerOutputError("conflict", [contract.referenceId]);
              recorded += 1;
              continue;
            }
          }
          const reference = bound.plan.references.find((ref) => ref.referenceId === contract.referenceId)!;
          const row = await prepareOutputRow(vault, { workspaceId: input.workspaceId, plan: bound.plan, producer, producerOperationId: input.operationId, reference, producerAddress: contract.producerAddress, producerOutput: contract.producerOutput }, reading);
          await recordPrepared(records, row);
          recorded += 1;
        } catch (error) {
          failure ??= error;
        }
      }
      // Everything that could be recorded was; the first refusal is reported after, never swallowed.
      if (failure) throw failure;
      return { recorded };
    },

    load,

    async resolveSecret(workspaceId: string, operationId: string, ref: string) {
      const input = (await load(workspaceId, operationId)).find((candidate) => candidate.secret?.ref === ref);
      if (!input?.secret) throw new StepFailedError("That secret is not an input of this operation; refusing to read it.");
      const status = await vault.status(workspaceId, ref);
      if (!status.exists || typeof status.version !== "number" || digest({ ref, version: status.version }) !== input.secret.versionDigest) {
        throw new StepFailedError("A secret input changed since its producer recorded it; a new review is required.");
      }
      const value = await readSecret(workspaceId, ref);
      if (value === undefined) throw new StepFailedError("A secret input could not be read from the vault.");
      return value;
    },
  };
}
