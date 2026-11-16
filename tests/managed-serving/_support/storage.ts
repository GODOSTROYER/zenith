/**
 * Doubles for the object-storage tests. HONESTY: `FakeAdmin` models IAM's relevant rules (a principal, one inline policy, at most
 * two access keys, idempotent deletes) in memory; `evaluate` is a small IAM policy evaluator (Allow statements, glob resources,
 * StringLike conditions, default deny, a missing condition key is false). They prove the SHAPE of what Zenith asks a provider
 * to enforce. Whether a real provider enforces it is the emulator/live lane's question, and it is not answered here.
 */
import { randomUUID } from "node:crypto";
import type { ManagedStorageKey } from "@/lib/controlplane/db/repos/managed-serving";
import {
  policyDigest, storageError, type IamPolicyDocument, type ObjectStorageAdminPort, type StorageKeyStore, type StorageResult,
} from "@/lib/managed-serving/storage";
import type { StorageCredentialSink } from "@/lib/secrets/resolver";

/* ---------------------------- policy evaluator ----------------------------- */

const glob = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

export function evaluate(policy: IamPolicyDocument, request: { action: string; resource: string; context?: Record<string, string | undefined> }): boolean {
  return policy.Statement.some((s) => {
    if (s.Effect !== "Allow") return false;
    if (!s.Action.some((a) => glob(a).test(request.action))) return false;
    if (!s.Resource.some((r) => glob(r).test(request.resource))) return false;
    for (const [operator, keys] of Object.entries(s.Condition ?? {})) {
      for (const [key, patterns] of Object.entries(keys)) {
        const value = request.context?.[key];
        if (value === undefined) return false;
        if (operator !== "StringLike") return false;
        if (!patterns.some((p) => glob(p).test(value))) return false;
      }
    }
    return true;
  });
}

export const objectArn = (bucket: string, key: string): string => `arn:aws:s3:::${bucket}/${key}`;
export const bucketArn = (bucket: string): string => `arn:aws:s3:::${bucket}`;

/* ------------------------------- fake admin -------------------------------- */

interface Principal { policy?: IamPolicyDocument; keys: Map<string, string> }

export class FakeAdmin implements ObjectStorageAdminPort {
  readonly id = "fake-iam";
  principals = new Map<string, Principal>();
  calls: string[] = [];
  /** make the next N deleteAccessKey calls fail */
  failDeletes = 0;
  failCreate = false;
  available: { available: true } | { available: false; reason: string } = { available: true };
  private counter = 0;

  availability() { return this.available; }
  private count(name: string): void { this.calls.push(name); }

  async ensurePrincipal(input: { name: string; policy: IamPolicyDocument }): Promise<StorageResult<{ created: boolean }>> {
    this.count("ensurePrincipal");
    const existing = this.principals.get(input.name);
    const p = existing ?? { keys: new Map<string, string>() };
    p.policy = structuredClone(input.policy);
    this.principals.set(input.name, p);
    return { ok: true, value: { created: !existing } };
  }

  async readPolicyDigest(name: string): Promise<StorageResult<string | undefined>> {
    this.count("readPolicyDigest");
    const p = this.principals.get(name);
    return { ok: true, value: p?.policy ? policyDigest(p.policy) : undefined };
  }

  async createAccessKey(name: string): Promise<StorageResult<{ accessKeyId: string; secretAccessKey: string }>> {
    this.count("createAccessKey");
    if (this.failCreate) return storageError("provider_error", "no", false);
    const p = this.principals.get(name);
    if (!p) return storageError("provider_error", "no principal", false);
    if (p.keys.size >= 2) return storageError("conflict", "The principal already holds the maximum number of access keys.", true);
    const accessKeyId = `AKIA${(++this.counter).toString().padStart(8, "0")}${randomUUID().slice(0, 8).toUpperCase()}`;
    const secretAccessKey = `secret-${randomUUID()}`;
    p.keys.set(accessKeyId, secretAccessKey);
    return { ok: true, value: { accessKeyId, secretAccessKey } };
  }

  async listAccessKeys(name: string): Promise<StorageResult<string[]>> {
    this.count("listAccessKeys");
    return { ok: true, value: [...(this.principals.get(name)?.keys.keys() ?? [])] };
  }

  async deleteAccessKey(name: string, accessKeyId: string): Promise<StorageResult<void>> {
    this.count("deleteAccessKey");
    if (this.failDeletes > 0) { this.failDeletes--; return storageError("unreachable", "down", true); }
    this.principals.get(name)?.keys.delete(accessKeyId);
    return { ok: true, value: undefined };
  }

  secretOf(name: string, accessKeyId: string): string | undefined { return this.principals.get(name)?.keys.get(accessKeyId); }
  allSecrets(): string[] { return [...this.principals.values()].flatMap((p) => [...p.keys.values()]); }
}

/* ------------------------------ fake vault/store ----------------------------- */

export class MemorySink implements StorageCredentialSink {
  values = new Map<string, string>();
  puts: string[] = [];
  failPuts = false;
  async put(ref: string, value: string): Promise<void> {
    if (this.failPuts) throw new Error("vault down");
    this.puts.push(ref);
    this.values.set(ref, value);
  }
  async exists(ref: string): Promise<boolean> { return this.values.has(ref); }
}

export class MemoryKeyStore implements StorageKeyStore {
  rows: ManagedStorageKey[] = [];
  constructor(private readonly workspaceId = "ws_test", private readonly environmentId = "env_test") {}
  async active(address: string) { return this.rows.find((r) => r.address === address && r.status === "active") ?? null; }
  async known(address: string) { return this.rows.filter((r) => r.address === address && r.status !== "revoked"); }
  async record(input: Parameters<StorageKeyStore["record"]>[0]) {
    const now = new Date().toISOString();
    const old = this.rows.find((r) => r.address === input.address && r.status === "active");
    if (old) { old.status = "revoke_pending"; old.supersededAt = now; }
    const key: ManagedStorageKey = { id: `msk_${randomUUID()}`, workspaceId: this.workspaceId, environmentId: this.environmentId, ...input, status: "active", createdAt: now, supersededAt: null, revokedAt: null };
    this.rows.push(key);
    return { key, ...(old ? { superseded: old } : {}) };
  }
  async markRevoked(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (row) { row.status = "revoked"; row.revokedAt = new Date().toISOString(); }
  }
}
