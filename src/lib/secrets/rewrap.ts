/**
 * Operator-only vault key rotation. Preflight authenticates the whole workspace
 * before any writes; bounded batches then authenticate again under write locks.
 * Current-key rows are byte-for-byte unchanged, making restart idempotent.
 * Metadata/version describe value rotation and never change for key rotation.
 * Writers must be quiesced during maintenance; no run-wide SQL transaction is
 * claimed. A crash retains completed batches and rolls back the failing batch.
 * Reports and audit contain counts only, never refs, key ids, or values.
 */
import { randomUUID } from "node:crypto";
import type { AuditEvent } from "@/lib/domain/types";
import type { SecretRecord } from "./backend";
import { vaultCipherFromEnv, type VaultCipher } from "./index";

export interface RewrapCounts {
  inspected: number;
  candidates: number;
  rewrapped: number;
  unchanged: number;
  batches: number;
}

export interface RewrapBatch {
  records: SecretRecord[];
  rewrapped: number;
}

/** Storage callbacks never receive plaintext or keys. */
export interface VaultRewrapStore {
  listBatch(workspaceId: string, after: string, limit: number): Promise<SecretRecord[]>;
  applyBatch(
    workspaceId: string, after: string, limit: number,
    transform: (record: SecretRecord) => SecretRecord | undefined,
    audit: (rewrapped: number) => AuditEvent
  ): Promise<RewrapBatch>;
  /** File audit outbox; SQL batches commit the audit in the same transaction. */
  flushAudit(workspaceId: string): Promise<void>;
}

export interface RewrapOptions {
  workspaceId: string;
  batchSize?: number;
  dryRun?: boolean;
  cipher?: VaultCipher;
  /** Called only after commit, outside any retryable transaction. */
  onBatch?: (counts: Readonly<RewrapCounts>) => void | Promise<void>;
}

export async function rewrapVault(store: VaultRewrapStore, options: RewrapOptions): Promise<RewrapCounts> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.workspaceId))
    throw new Error("A valid workspace id is required for vault re-wrap.");
  const limit = options.batchSize ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Vault re-wrap batch size must be an integer from 1 to 1000.");
  const cipher = options.cipher ?? vaultCipherFromEnv();
  const workspaceId = options.workspaceId;
  const inspect = (record: SecretRecord) => {
    if (!record.ref || /\s/.test(record.ref)) throw new Error("Vault re-wrap encountered an invalid reference.");
    if (record.keyVersion !== 1) throw new Error("Vault re-wrap encountered an unsupported sealing scheme.");
    return cipher.open(workspaceId, record.ref, record);
  };
  let after = "";
  const preflight: RewrapCounts = { inspected: 0, candidates: 0, rewrapped: 0, unchanged: 0, batches: 0 };
  try {
    // Even an unreadable row in the last page must prevent earlier writes.
    for (;;) {
      const records = await store.listBatch(workspaceId, after, limit);
      if (!records.length) break;
      for (const record of records) {
        const opened = inspect(record);
        preflight.inspected++;
        if (opened.current) preflight.unchanged++; else preflight.candidates++;
      }
      after = records[records.length - 1].ref;
    }
    if (options.dryRun) return preflight;
    await store.flushAudit(workspaceId);
    after = "";
    const counts: RewrapCounts = { inspected: 0, candidates: 0, rewrapped: 0, unchanged: 0, batches: 0 };
    for (;;) {
      const id = randomUUID();
      const ts = new Date().toISOString();
      const batch = await store.applyBatch(workspaceId, after, limit, (record) => {
        const opened = inspect(record);
        return opened.current ? undefined : { ...record, ...cipher.seal(workspaceId, record.ref, opened.value) };
      }, (rewrapped) => ({
        id, ts, workspaceId, actor: { type: "system", id: "vault-rewrap", name: "Vault re-wrap" },
        actionId: "system.rewrapVault", input: { rewrapped }, result: "ok",
        summary: `Re-wrapped ${rewrapped} vault rows under the current key.`,
      }));
      if (!batch.records.length) break;
      counts.inspected += batch.records.length;
      counts.rewrapped += batch.rewrapped;
      counts.candidates += batch.rewrapped;
      counts.unchanged += batch.records.length - batch.rewrapped;
      counts.batches++;
      after = batch.records[batch.records.length - 1].ref;
      await store.flushAudit(workspaceId);
      await options.onBatch?.({ ...counts });
    }
    return counts;
  } catch {
    // Database/filesystem exceptions may contain URLs, row contents or keys.
    throw new Error("Vault re-wrap stopped. Check keys, store integrity and write access; committed batches can be resumed. No row values are reported.");
  }
}

export interface RewrapStepResult {
  /** no rows remained after the cursor */
  done: boolean;
  /** keyset cursor after this step (the last ref seen) */
  after: string;
  inspected: number;
  rewrapped: number;
  unchanged: number;
}

/** A step failed. `unreadable_row` means a row did not open under any retained key (nothing in that batch was written). */
export class VaultRewrapStepError extends Error {
  constructor(readonly code: "unreadable_row" | "rewrap_failed") {
    super("Vault re-wrap stopped. No row values are reported.");
    this.name = "VaultRewrapStepError";
  }
}

/**
 * One bounded, resumable batch of the re-wrap, for the durable scheduler (PROD-OPS-05). The caller keeps the
 * cursor between ticks. Rows of the batch are authenticated under their write locks before the batch writes
 * anything, so a failing batch changes nothing; earlier batches stay committed and the job resumes from its
 * cursor. Unlike `rewrapVault` there is no whole-workspace preflight: a bad row stops the job at its batch.
 */
export async function rewrapVaultStep(
  store: VaultRewrapStore,
  options: { workspaceId: string; after: string; cipher: VaultCipher; batchSize?: number }
): Promise<RewrapStepResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.workspaceId)) throw new VaultRewrapStepError("rewrap_failed");
  const limit = options.batchSize ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new VaultRewrapStepError("rewrap_failed");
  const { workspaceId, cipher } = options;
  let unreadable = false;
  const inspect = (record: SecretRecord) => {
    try {
      if (!record.ref || /\s/.test(record.ref) || record.keyVersion !== 1) throw new Error();
      return cipher.open(workspaceId, record.ref, record);
    } catch {
      unreadable = true;
      throw new Error("unreadable");
    }
  };
  try {
    const id = randomUUID();
    const ts = new Date().toISOString();
    const batch = await store.applyBatch(workspaceId, options.after, limit, (record) => {
      const opened = inspect(record);
      return opened.current ? undefined : { ...record, ...cipher.seal(workspaceId, record.ref, opened.value) };
    }, (rewrapped) => ({
      id, ts, workspaceId, actor: { type: "system", id: "vault-rewrap", name: "Vault re-wrap" },
      actionId: "system.rewrapVault", input: { rewrapped }, result: "ok",
      summary: `Re-wrapped ${rewrapped} vault rows under the current key.`,
    }));
    await store.flushAudit(workspaceId);
    const last = batch.records[batch.records.length - 1];
    return {
      done: batch.records.length === 0,
      after: last ? last.ref : options.after,
      inspected: batch.records.length,
      rewrapped: batch.rewrapped,
      unchanged: batch.records.length - batch.rewrapped,
    };
  } catch {
    throw new VaultRewrapStepError(unreadable ? "unreadable_row" : "rewrap_failed");
  }
}
