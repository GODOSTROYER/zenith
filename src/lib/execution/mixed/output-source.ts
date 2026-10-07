/**
 * Production sources and composition of the producer output reader (PROD-MIX-03 follow-up).
 *
 * `observationSource` reads what the PRODUCING child recorded about its own resource while its operation was running: the
 * child workflow's post-apply `observeEnvironment` step reads every node through the brokered observe session of the
 * producing partition's connection and appends the observation to the platform store. The reader selects the newest real
 * (present, not simulated, error free) observation of the producer address taken between the child operation's creation and
 * its recorded receipt, and takes the declared output from it:
 *
 *   producerOutput "externalId"   the provider-side id the driver observed (an ARN, resource id)
 *   any other name                the portable attribute of that name, only when its state is `known`
 *
 * It opens no cloud connection and holds no credential: a child operation that already ended can no longer be granted a
 * session (the broker issues activity grants only to running operations), so the read-back that the brokered session produced
 * is the evidence; with no such observation the output is unreadable and the consumer stays blocked.
 * An observation is a read of provider state, never an instruction: only its values are used, and only as typed outputs.
 *
 * Not covered, stated plainly: sensitive tofu outputs. The engine drops them before they reach the platform, so a secret
 * output can only name an existing vault entry here; sealing a sensitive value is supported by the reader through any source
 * that returns `sensitive: true` and is exercised with a contract source in tests, but no production source produces one.
 */
import { digest } from "@/lib/controlplane/digest";
import * as outputRecords from "@/lib/controlplane/db/repos/mixed-output-records";
import type { Sql } from "@/lib/controlplane/types";
import { asyncSecretsBackend } from "@/lib/secrets/backend";
import { putSecretAsync } from "@/lib/secrets";
import { createProducerOutputReader, type OutputRecordStore, type ProducerReading, type ProducerReadingSource, type VaultPort } from "./output-reader";
import type { MixedWorld } from "./world";

export function observationSource(sql: Sql): ProducerReadingSource {
  return {
    async read(input) {
      const out = new Map<string, ProducerReading | { unreadable: string }>();
      for (const wanted of input.references) {
        const row = await outputRecords.readProducerObservation(sql, {
          workspaceId: input.workspaceId, environmentId: input.producer.childEnvironmentId, operationId: input.childOperationId, address: wanted.producerAddress, notAfter: input.receipt.recordedAt,
        });
        if (!row) { out.set(wanted.referenceId, { unreadable: "no_observation" }); continue; }
        let value: unknown;
        if (wanted.producerOutput === "externalId") value = row.externalId;
        else {
          const attribute = row.attributes[wanted.producerOutput] as { state?: string; value?: unknown } | undefined;
          value = attribute && attribute.state === "known" ? attribute.value : undefined;
        }
        if (value === undefined || value === null) { out.set(wanted.referenceId, { unreadable: "attribute_unknown" }); continue; }
        out.set(wanted.referenceId, {
          value, sensitive: false, source: "observation", observedAt: row.observedAt,
          sourceDigest: digest({ observation: row.observationId, address: row.address, observedAt: row.observedAt, source: row.source, output: wanted.producerOutput }),
        });
      }
      return out;
    },
  };
}

/** The append-only platform table of recorded producer outputs (migration 42). */
export function platformOutputRecordStore(sql: Sql): OutputRecordStore {
  return { get: (workspaceId, planId, referenceId) => outputRecords.getOutput(sql, workspaceId, planId, referenceId), record: (input) => outputRecords.recordOutput(sql, input) };
}

/** The workspace vault through its existing sealed store. Values go in sealed; only metadata comes out. */
export function platformVaultPort(): VaultPort {
  return {
    async status(workspaceId, ref) {
      const record = await asyncSecretsBackend().get(workspaceId, ref);
      return record ? { exists: true, version: record.version } : { exists: false };
    },
    async put(workspaceId, ref, value, by) {
      const meta = await putSecretAsync(workspaceId, ref, value, by);
      return { version: meta.version };
    },
  };
}

/** The two production hooks of the mixed world: the producer output reader and the drift and migration signals. */
export function productionWorldHooks(sql: Sql): Pick<MixedWorld, "childTypedOutputs"> {
  return { childTypedOutputs: createProducerOutputReader({ records: platformOutputRecordStore(sql), source: observationSource(sql), vault: platformVaultPort() }) };
}
