/**
 * Default machine evidence and at-most-once dispatch over the existing store.
 * An immutable evidence marker survives idempotency-cache expiry/pruning: a
 * lost result never permits re-dispatch. Racing/incomplete requests are uncertain.
 * Only digests and bounded summaries are cleartext; replay results and exec
 * artifacts are AES-GCM sealed with workspace/key AAD, using a separate HKDF
 * domain. Cached artifacts may be pruned after 30 days; key rotation makes them
 * unreadable. Both cases fail closed. No grants or provider sessions are stored.
 */
import { digest } from "@/lib/controlplane/digest";
import { repos } from "@/lib/controlplane/db";
import type { EvidenceRecord, Sql } from "@/lib/controlplane/types";
import { KeyRing } from "@/lib/keycustody/registry";
import { createAesResultSealer, type ResultSealer } from "@/lib/runners/seal";
import { MachineOperationError } from "./errors";
import type { MachineEvidenceSink, MachineRequest, MachineResult } from "./types";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const keyFor = (ws: string, op: string): string => `machine-dispatch:${digest({ ws, op })}`;
const aadFor = (ws: string, key: string): string => `zenith.machine|${ws}|${key}`;

/**
 * Uses the worker's mandatory secret, independently of plan and runner keys, through the key registry's
 * enc:machine-results purpose (an HKDF domain of ZENITH_SECRET_KEY). Previous roots default to the vault's
 * decrypt-only list, so a rotation keeps cached artifacts readable until their 30 day expiry.
 */
export function machineResultSealer(secretKey: string, previousRoots: readonly string[] = previousVaultRoots()): ResultSealer {
  if (!/^[a-f0-9]{64}$/i.test(secretKey)) throw new Error("Machine persistence requires the worker's 64-hex secret key.");
  const ring = KeyRing.fromEnv({ ZENITH_SECRET_KEY: secretKey, ZENITH_VAULT_PREVIOUS_SECRET_KEYS: JSON.stringify(previousRoots) }, { purposes: ["enc:machine-results"] });
  const [current] = ring.materialFor("enc:machine-results", "encrypt");
  const previous = ring.materialFor("enc:machine-results", "decrypt").filter((m) => m.role === "decrypt_only").map((m) => ({ keyId: m.keyId, key: new Uint8Array(m.key) }));
  return createAesResultSealer(new Uint8Array(current.key), { keyId: current.keyId, previous });
}

function previousVaultRoots(): string[] {
  try {
    const parsed: unknown = JSON.parse(process.env.ZENITH_VAULT_PREVIOUS_SECRET_KEYS ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch { return []; }
}

async function insertOnce(db: Sql, input: Parameters<typeof repos.evidence.insert>[1]): Promise<EvidenceRecord> {
  try { return await repos.evidence.insert(db, input); }
  catch (error) {
    const row = input.id ? await repos.evidence.get(db, input.workspaceId, input.id) : null;
    if (row && row.digest === input.digest && row.operationId === input.operationId) return row;
    throw error;
  }
}

async function cached(db: Sql, ws: string, key: string): Promise<unknown> {
  const rows = await db.query<{ response: unknown }>("select response from platform.idempotency_keys where workspace_id = $1 and key = $2", [ws, key]);
  return rows[0]?.response;
}

async function save(db: Sql, sealer: ResultSealer, ws: string, op: string, key: string, value: unknown): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CACHE_BYTES) throw new MachineOperationError("evidence_failed", "the machine replay artifact exceeds its storage budget");
  await repos.idempotency.reserve(db, { workspaceId: ws, operationId: op, key, requestHash: digest({ key }), ttlMs: CACHE_TTL_MS });
  if (!await repos.idempotency.complete(db, ws, key, sealer.seal(aadFor(ws, key), value))) throw new MachineOperationError("evidence_failed", "the machine replay artifact could not be persisted");
}

/** Tenant-scoped artifact reader; cleartext is returned only to its trusted caller. */
export async function readMachineEvidenceBlob(db: Sql, sealer: ResultSealer, workspaceId: string, blobRef: string): Promise<string | null> {
  if (!/^machine-output:[a-f0-9]{64}$/.test(blobRef)) return null;
  const box = await cached(db, workspaceId, blobRef);
  if (!box) return null;
  try {
    const value = sealer.open(aadFor(workspaceId, blobRef), box);
    return typeof value === "string" ? value : null;
  } catch { return null; }
}

export function createMachineEvidenceSink(db: Sql, sealer: ResultSealer): MachineEvidenceSink {
  return {
    async record({ blob, ...input }) {
      const id = `evd_machine_${digest({ ws: input.workspaceId, op: input.operationId, digest: input.digest, outcome: input.summary.outcome })}`;
      let blobRef: string | undefined;
      if (blob !== undefined) {
        if (!input.operationId) throw new MachineOperationError("evidence_failed", "machine output requires an operation");
        blobRef = `machine-output:${digest({ id })}`;
        await save(db, sealer, input.workspaceId, input.operationId, blobRef, blob);
      }
      return insertOnce(db, { ...input, id, ...(blobRef ? { blobRef } : {}) });
    },
    async runOnce(req: MachineRequest, execute, simulated = false) {
      const ws = req.target.workspaceId;
      const key = keyFor(ws, req.operationId);
      const id = `evd_machine_dispatch_${digest({ key })}`;
      const requestDigest = digest({ request: req, simulated });
      // The permanent marker is also the cross-process race arbiter. It never
      // expires, unlike an idempotency reservation or a provider preflight read.
      const claim = () => repos.evidence.insert(db, { id, workspaceId: ws, operationId: req.operationId, kind: "machine_request", digest: requestDigest, summary: { outcome: "dispatching", operation: req.operation, transport: req.target.transport }, simulated });
      let existing = await repos.evidence.get(db, ws, id);
      if (!existing) {
        const op = await repos.operations.get(db, ws, req.operationId);
        if (!op || op.status !== "running") throw new MachineOperationError("denied", "machine dispatch requires a running operation in this workspace");
        try { await claim(); }
        catch (error) {
          existing = await repos.evidence.get(db, ws, id);
          if (!existing) throw error;
        }
      }
      if (existing) {
        if (existing.digest !== requestDigest) throw new MachineOperationError("grant_mismatch", "this operation already names a different machine request");
        const box = await cached(db, ws, key);
        if (box) {
          try {
            const result = sealer.open(aadFor(ws, key), box) as MachineResult;
            if (result.operation === req.operation && result.transport === req.target.transport && typeof result.ok === "boolean") return result;
          } catch { /* a lost/rotated key cannot turn a retry into dispatch */ }
        }
        throw new MachineOperationError("uncertain", "this machine operation was already dispatched; its completed result is unavailable");
      }
      const result = await execute();
      // Failure to cache after dispatch is uncertainty, never permission to retry.
      try { await save(db, sealer, ws, req.operationId, key, result); }
      catch { throw new MachineOperationError("uncertain", "the machine operation completed but its replay result could not be persisted"); }
      return result;
    },
  };
}
