/**
 * Where a sealed secret is kept — the one seam between `./index.ts` and storage.
 *
 * `./index.ts` owns the crypto and owns it alone: AES-256-GCM under
 * `ZENITH_SECRET_KEY`, with `(workspaceId, ref)` authenticated alongside the
 * value. A backend never sees a plaintext value and never holds the key; it
 * moves `SecretRecord`s, which are already sealed. That is what makes the
 * Postgres backend safe to add — the database gains rows it cannot open.
 *
 * The compatibility methods remain synchronous for legacy callers that have
 * not yet been widened. Request/provider paths use the async surface below:
 * system secret actions, sandbox injection, alert delivery/mutations, and
 * `GET /api/secrets` no longer need the blocking bridge. Audit/history and a
 * few older compatibility readers still pay that price until their public
 * contracts are widened; see `@/lib/db/pg/sync-rest`.
 *
 * Chosen by `ZENITH_STORE`, at call time rather than at import: the file store
 * is the default, a test flips the variable between suites, and the file
 * backend must stay reachable on an install with no Supabase configuration at
 * all.
 */
import { env } from "@/lib/env";
import { FileSecrets, FileSecretsAsync } from "./file-backend";
import { PostgresSecrets, PostgresSecretsAsync } from "./pg-backend";

/** The current sealing scheme. Bumped only if the key derivation changes. */
export const KEY_VERSION = 1;

/**
 * One stored secret, sealed. The three cipher parts are base64 and are exactly
 * the lossless split of the file store's combined
 * `base64(iv).base64(authTag).base64(ciphertext)` string, so the two backends
 * hold the same bytes in two shapes and neither loses anything.
 */
export interface SecretRecord {
  /** e.g. "vault:kq3f9a2b1c/kq3f9axyz0/STRIPE_API_KEY" */
  ref: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  /** 1 on first write, +1 per rotation */
  version: number;
  /** which sealing scheme wrote it */
  keyVersion: number;
  iv: string;
  authTag: string;
  ciphertext: string;
}

/**
 * Storage for sealed records, keyed by `(workspaceId, ref)`.
 *
 * There is no "read every workspace" method and there never should be: the
 * workspace is part of the key in both implementations and part of the
 * authenticated data in the seal, so a row can only be opened by the tenant it
 * was written for.
 */
export interface SecretsBackend {
  /** Which one this is, for error messages and tests. */
  readonly kind: "file" | "postgres";
  /** One record, or undefined when the reference holds nothing. */
  get(workspaceId: string, ref: string): SecretRecord | undefined;
  /** Every record this workspace holds, in no particular order. */
  list(workspaceId: string): SecretRecord[];
  /** Create or replace one record in place. */
  put(workspaceId: string, record: SecretRecord): void;
  /** Forget one record and return what it was, or undefined if there was none. */
  remove(workspaceId: string, ref: string): SecretRecord | undefined;
}

/**
 * Awaitable storage for request and provider paths. Postgres must use this
 * surface: a network round trip must never park the Node event loop. The
 * synchronous interface stays only for file-backed compatibility paths.
 */
export interface AsyncSecretsBackend {
  readonly kind: "file" | "postgres";
  get(workspaceId: string, ref: string): Promise<SecretRecord | undefined>;
  list(workspaceId: string): Promise<SecretRecord[]>;
  put(workspaceId: string, record: SecretRecord): Promise<void>;
  remove(workspaceId: string, ref: string): Promise<SecretRecord | undefined>;
}

/**
 * The backend this process stores secrets in.
 *
 * Both are imported, neither is touched until it is asked for something: the
 * Postgres one reads its configuration and starts its worker on first use, so
 * an install running on the file store boots with no Supabase configuration at
 * all — exactly as `pgClient()` is built on first use rather than at import.
 */
export function secretsBackend(): SecretsBackend {
  return env().ZENITH_STORE === "postgres" ? PostgresSecrets : FileSecrets;
}

/** Select the non-blocking backend for request/provider code. */
export function asyncSecretsBackend(): AsyncSecretsBackend {
  return env().ZENITH_STORE === "postgres" ? PostgresSecretsAsync : FileSecretsAsync;
}
