/**
 * Tenant object storage on the Zenith-managed platform (PROD-MAN-03): one shared bucket, one key prefix per tenant object
 * store, and a credential that can reach nothing else.
 *
 * Isolation does not rest on naming. Each object store gets its own IAM-compatible principal whose single inline policy allows
 * object access only under `<prefixRoot>/<workspace>/<environment>/<store>/` and listing only with that `s3:prefix`. The
 * platform's own bucket credential is never handed to a tenant. The access key is created by the platform, written to the
 * vault (two generated references, one per half) and delivered to the workload through the ordinary `secretRef` path, so it
 * never appears in a manifest, a plan, an event or a log. Rotation creates the new key first, records it, then revokes the
 * old one at the provider; a revocation that could not complete stays `revoke_pending` in the store until it does.
 *
 * Nothing here deletes tenant data. Retiring an object store revokes its credentials only.
 *
 * The provider is a port (`ObjectStorageAdminPort`); the one adapter speaks the IAM API (`createIamAdminPort`), so any
 * IAM-compatible endpoint works. Evidence is contract-level (SDK mocked) plus an opt-in emulator lane; nothing has run against
 * a live account.
 */
import { createHash } from "node:crypto";
import type { ManagedStorageKey, RecordStorageKeyInput } from "@/lib/controlplane/db/repos/managed-serving";
import type { ZenithSubstrate } from "@/lib/providers/zenith/substrate";
import { tenantObjectPrefix } from "@/lib/providers/zenith/substrate";
import { ZenithError, type ZenithTenant } from "@/lib/providers/zenith/types";
import type { StorageCredentialSink } from "@/lib/secrets/resolver";

/* --------------------------------- policy ---------------------------------- */

export interface IamPolicyDocument {
  Version: "2012-10-17";
  Statement: IamStatement[];
}
export interface IamStatement {
  Sid: string;
  Effect: "Allow";
  Action: string[];
  Resource: string[];
  Condition?: Record<string, Record<string, string[]>>;
}

const PREFIX_CHARS = /^[A-Za-z0-9._~/-]+\/$/;

/** A prefix safe to embed in a policy: plain path characters, ends with '/', no wildcard, no traversal, never the bucket root or a shared parent (at least root/workspace/environment deep). */
export function assertScopedPrefix(prefix: string): string {
  if (!PREFIX_CHARS.test(prefix) || prefix.startsWith("/") || prefix.includes("//") || prefix.split("/").some((p) => p === "." || p === "..") || prefix.length > 500) {
    throw new ZenithError("isolation_violation", "The object-store prefix is not a plain, bounded path prefix.");
  }
  if (prefix.split("/").filter(Boolean).length < 3) throw new ZenithError("isolation_violation", "The object-store prefix is too shallow: it must sit under a tenant's own workspace and environment.");
  return prefix;
}

/**
 * The only policy a tenant object-store principal ever carries. Allow-only (IAM denies everything else by default): object
 * operations under the prefix, and listing the bucket only when the request names that prefix.
 */
export function scopedStoragePolicy(bucket: string, prefix: string): IamPolicyDocument {
  assertScopedPrefix(prefix);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new ZenithError("isolation_violation", "The object-store bucket name is not valid.");
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "ObjectsUnderPrefix", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], Resource: [`arn:aws:s3:::${bucket}/${prefix}*`] },
      { Sid: "ListOnlyUnderPrefix", Effect: "Allow", Action: ["s3:ListBucket", "s3:ListBucketMultipartUploads"], Resource: [`arn:aws:s3:::${bucket}`], Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } } },
      { Sid: "BucketLocation", Effect: "Allow", Action: ["s3:GetBucketLocation"], Resource: [`arn:aws:s3:::${bucket}`] },
    ],
  };
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
};
export const policyDigest = (policy: IamPolicyDocument): string => createHash("sha256").update(canonical(policy)).digest("hex");

/* --------------------------------- intents --------------------------------- */

/** What the managed apply must provision for one `object_store` node; carries references and non-secret facts only. */
export interface ManagedStorageIntent {
  address: string;
  bucket: string;
  prefix: string;
  principalName: string;
  /** vault references of the two halves of the credential (the workload's env `secretRef`s) */
  keyIdRef: string;
  secretRef: string;
  endpoint: string;
  region?: string;
  policyDigest: string;
  notes: string[];
}

const segmentOf = (address: string): string => {
  const flat = address.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return flat.length > 0 && flat.length <= 60 && !flat.includes("..") ? flat : `~${createHash("sha256").update(address).digest("hex").slice(0, 24)}`;
};

/** Stable, id-free principal name per (workspace, environment, address). */
export function principalNameFor(t: Pick<ZenithTenant, "workspaceId" | "environmentId">, address: string): string {
  return `zenith-t-${createHash("sha256").update(`zenith-managed-storage-v1\0${t.workspaceId}\0${t.environmentId}\0${address}`).digest("hex").slice(0, 24)}`;
}

export const storageKeyIdRef = (environmentId: string, address: string): string => `vault:generated/${environmentId}/${address}/storage-key-id`;
export const storageSecretRef = (environmentId: string, address: string): string => `vault:generated/${environmentId}/${address}/storage-secret`;

/**
 * Intent for one object store. Refuses (does not guess) when the substrate has no object storage; a missing admin credential
 * is reported at apply as `unavailable`, with the variable to set.
 */
export function storageIntentFromNode(tenant: ZenithTenant, substrate: ZenithSubstrate, node: { address: string }): ManagedStorageIntent {
  const base = tenantObjectPrefix(tenant, substrate);
  if (!base || !substrate.objectStorage) {
    throw new ZenithError("unsupported", `${node.address}: object storage is not configured on this platform (ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT, ZENITH_MANAGED_OBJECT_STORAGE_BUCKET).`);
  }
  const prefix = assertScopedPrefix(`${base.prefix}${segmentOf(node.address)}/`);
  const policy = scopedStoragePolicy(base.bucket, prefix);
  return {
    address: node.address,
    bucket: base.bucket,
    prefix,
    principalName: principalNameFor(tenant, node.address),
    keyIdRef: storageKeyIdRef(tenant.environmentId, node.address),
    secretRef: storageSecretRef(tenant.environmentId, node.address),
    endpoint: substrate.objectStorage.endpoint,
    ...(substrate.objectStorage.region ? { region: substrate.objectStorage.region } : {}),
    policyDigest: policyDigest(policy),
    notes: [
      `${node.address}: object store is a prefix of the shared platform bucket (${prefix}), reachable only with a credential scoped to that prefix.`,
      `${node.address}: bucket versioning is a property of the shared bucket, not of this store; the spec's versioning setting is not applied per tenant.`,
      `${node.address}: removing this object store revokes its credential and never deletes objects.`,
    ],
  };
}

/** The environment a workload needs: non-secret values plus the two credential halves as `secretRef`s. */
export function storageWorkloadEnv(intent: ManagedStorageIntent): ({ key: string; value: string } | { key: string; secretRef: string })[] {
  return [
    { key: "AWS_ACCESS_KEY_ID", secretRef: intent.keyIdRef },
    { key: "AWS_SECRET_ACCESS_KEY", secretRef: intent.secretRef },
    { key: "S3_BUCKET", value: intent.bucket },
    { key: "S3_PREFIX", value: intent.prefix },
    { key: "S3_ENDPOINT", value: intent.endpoint },
    ...(intent.region ? [{ key: "AWS_REGION", value: intent.region }] : []),
  ];
}

/* ------------------------------- admin port -------------------------------- */

export type StorageErrorCode = "unavailable" | "forbidden" | "throttled" | "conflict" | "provider_error" | "unreachable" | "invalid" | "aborted";
export interface StorageError { code: StorageErrorCode; message: string; retryable: boolean }
export type StorageResult<T> = { ok: true; value: T } | { ok: false; error: StorageError };
export const storageError = (code: StorageErrorCode, message: string, retryable: boolean): { ok: false; error: StorageError } => ({ ok: false, error: { code, message, retryable } });

export const STORAGE_POLICY_NAME = "zenith-prefix-scope";
export const OBJECT_STORAGE_UNCONFIGURED_REASON =
  "Per-tenant object storage needs an IAM-admin credential reference (ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF) so the platform can create one scoped principal per object store; none is configured.";

export interface ObjectStorageAdminPort {
  readonly id: string;
  availability(): { available: true } | { available: false; reason: string };
  /** Create the principal if absent (refusing one Zenith did not create) and converge its single inline policy. */
  ensurePrincipal(input: { name: string; policy: IamPolicyDocument }, opts?: { signal?: AbortSignal }): Promise<StorageResult<{ created: boolean }>>;
  /** The inline policy digest the provider currently holds for the principal, undefined when there is none. */
  readPolicyDigest(name: string, opts?: { signal?: AbortSignal }): Promise<StorageResult<string | undefined>>;
  createAccessKey(name: string, opts?: { signal?: AbortSignal }): Promise<StorageResult<{ accessKeyId: string; secretAccessKey: string }>>;
  listAccessKeys(name: string, opts?: { signal?: AbortSignal }): Promise<StorageResult<string[]>>;
  /** Idempotent: an absent key is success. */
  deleteAccessKey(name: string, accessKeyId: string, opts?: { signal?: AbortSignal }): Promise<StorageResult<void>>;
}

export function unavailableStorageAdmin(reason: string): ObjectStorageAdminPort {
  const no = async <T>(): Promise<StorageResult<T>> => storageError("unavailable", reason, false);
  return { id: "unavailable", availability: () => ({ available: false, reason }), ensurePrincipal: no, readPolicyDigest: no, createAccessKey: no, listAccessKeys: no, deleteAccessKey: no };
}

/* ------------------------------ store adapter ------------------------------ */

/** What provisioning needs from the platform store, bound to one workspace and environment. */
export interface StorageKeyStore {
  active(address: string): Promise<ManagedStorageKey | null>;
  /** active and revoke_pending keys of an address (keys the provider is allowed to hold) */
  known(address: string): Promise<ManagedStorageKey[]>;
  record(input: Omit<RecordStorageKeyInput, "workspaceId" | "environmentId">): Promise<{ key: ManagedStorageKey; superseded?: ManagedStorageKey }>;
  markRevoked(id: string): Promise<void>;
}

/** What a managed session carries for object stores: the admin port, the credential sink and the key store of ONE environment. */
export interface ObjectStoragePorts {
  admin: ObjectStorageAdminPort;
  sink: StorageCredentialSink;
  store: StorageKeyStore;
}

/* ------------------------------ provisioning ------------------------------- */

export interface EnsureStorageOutcome {
  address: string;
  status: "created" | "rotated" | "exists" | "planned" | "failed";
  bucket: string;
  prefix: string;
  keyIdRef: string;
  secretRef: string;
  accessKeyId?: string;
  error?: StorageError;
}

export interface StorageProvisionDeps {
  admin: ObjectStorageAdminPort;
  sink: StorageCredentialSink;
  store: StorageKeyStore;
  signal?: AbortSignal;
}

const failed = (i: ManagedStorageIntent, error: StorageError): EnsureStorageOutcome => ({ address: i.address, status: "failed", bucket: i.bucket, prefix: i.prefix, keyIdRef: i.keyIdRef, secretRef: i.secretRef, error });
const base = (i: ManagedStorageIntent) => ({ address: i.address, bucket: i.bucket, prefix: i.prefix, keyIdRef: i.keyIdRef, secretRef: i.secretRef });

/** Every intent failed `unavailable` with the reason (no provisioning ports in the session). */
export function refuseObjectStores(intents: readonly ManagedStorageIntent[], reason: string): EnsureStorageOutcome[] {
  return intents.map((i) => failed(i, { code: "unavailable", message: reason, retryable: false }));
}

/** Revoke every `revoke_pending` key the store knows for an address. Returns the ids still owed (a failure leaves them pending). */
export async function settleRevocations(principalName: string, address: string, deps: Pick<StorageProvisionDeps, "admin" | "store" | "signal">): Promise<{ revoked: number; owed: number }> {
  let revoked = 0;
  let owed = 0;
  for (const key of (await deps.store.known(address)).filter((k) => k.status === "revoke_pending")) {
    const r = await deps.admin.deleteAccessKey(principalName, key.accessKeyId, { signal: deps.signal });
    if (r.ok) { await deps.store.markRevoked(key.id); revoked++; } else owed++;
  }
  return { revoked, owed };
}

/**
 * Converge each object store's scoped credential. Stops at the first failure. Dry run changes nothing and reports `planned`
 * (an unavailable admin port is still `failed`, so a plan shows the blocker).
 *
 * Order for a new or rotated key: reconcile orphans (provider keys the store never recorded), converge the policy, create the
 * key, write both halves to the vault, record it (superseding the old one atomically), then revoke the old key.
 */
export async function provisionObjectStores(intents: readonly ManagedStorageIntent[], deps: StorageProvisionDeps, opts: { dryRun?: boolean } = {}): Promise<EnsureStorageOutcome[]> {
  if (intents.length === 0) return [];
  const availability = deps.admin.availability();
  if (!availability.available) return intents.map((i) => failed(i, { code: "unavailable", message: availability.reason, retryable: false }));
  const out: EnsureStorageOutcome[] = [];
  let stopped = false;
  for (const intent of intents) {
    if (stopped) { out.push(failed(intent, { code: "aborted", message: "Not attempted: an earlier object store failed.", retryable: true })); continue; }
    if (opts.dryRun === true) { out.push({ ...base(intent), status: "planned" }); continue; }
    const outcome = await provisionOne(intent, deps);
    if (outcome.status === "failed") stopped = true;
    out.push(outcome);
  }
  return out;
}

async function provisionOne(intent: ManagedStorageIntent, deps: StorageProvisionDeps): Promise<EnsureStorageOutcome> {
  const { admin, sink, store, signal } = deps;
  const policy = scopedStoragePolicy(intent.bucket, intent.prefix);
  const ensured = await admin.ensurePrincipal({ name: intent.principalName, policy }, { signal });
  if (!ensured.ok) return failed(intent, ensured.error);

  const known = await store.known(intent.address);
  const knownIds = new Set(known.map((k) => k.accessKeyId));
  const held = await admin.listAccessKeys(intent.principalName, { signal });
  if (!held.ok) return failed(intent, held.error);
  for (const id of held.value) {
    if (knownIds.has(id)) continue;
    // a key the store never recorded (a crash between create and record): it is nobody's, remove it
    const r = await admin.deleteAccessKey(intent.principalName, id, { signal });
    if (!r.ok) return failed(intent, r.error);
  }
  const live = new Set(held.value.filter((id) => knownIds.has(id)));

  const active = await store.active(intent.address);
  const settled = await settleRevocations(intent.principalName, intent.address, { admin, store, signal });
  if (active && active.policyDigest === intent.policyDigest && active.prefix === intent.prefix && active.bucket === intent.bucket && live.has(active.accessKeyId)
      && await sink.exists(intent.keyIdRef) && await sink.exists(intent.secretRef)) {
    return { ...base(intent), status: "exists", accessKeyId: active.accessKeyId };
  }
  if (settled.owed > 0 && live.size >= 2) return failed(intent, { code: "conflict", message: "An earlier credential could not be revoked yet, so no new key can be created; retry shortly.", retryable: true });

  const created = await admin.createAccessKey(intent.principalName, { signal });
  if (!created.ok) return failed(intent, created.error);
  try {
    await sink.put(intent.keyIdRef, created.value.accessKeyId);
    await sink.put(intent.secretRef, created.value.secretAccessKey);
  } catch {
    // the new key is unrecorded and unusable by anyone: remove it rather than leave an unmanaged credential
    await admin.deleteAccessKey(intent.principalName, created.value.accessKeyId, { signal });
    return failed(intent, { code: "unavailable", message: "The credential could not be written to the vault, so it was discarded.", retryable: true });
  }
  const recorded = await store.record({
    address: intent.address, bucket: intent.bucket, prefix: intent.prefix, policyDigest: intent.policyDigest, principalName: intent.principalName,
    accessKeyId: created.value.accessKeyId, secretRef: intent.secretRef,
  });
  if (recorded.superseded) await settleRevocations(intent.principalName, intent.address, { admin, store, signal });
  return { ...base(intent), status: active ? "rotated" : "created", accessKeyId: created.value.accessKeyId };
}

/** Retire an object store's credentials (the node was removed). Objects are never touched. */
export async function revokeObjectStoreKeys(principalName: string, address: string, deps: Pick<StorageProvisionDeps, "admin" | "store" | "signal"> & { retire(address: string): Promise<unknown> }): Promise<{ revoked: number; owed: number }> {
  await deps.retire(address);
  return settleRevocations(principalName, address, deps);
}

/* ------------------------------ IAM adapter -------------------------------- */

export interface IamAdminConfig {
  /** IAM-compatible endpoint; absent = the AWS default */
  endpoint?: string;
  region: string;
  /** `vault:` reference of the IAM-admin credential */
  credentialRef: string;
}

export interface IamAdminDeps {
  /** platform credential resolver (operator secrets, never workload values); JSON `{accessKeyId, secretAccessKey, sessionToken?}` */
  resolveSecret(ref: string): Promise<string | null | undefined>;
  /** injected for tests; production lazily imports the AWS SDK */
  loadSdk?(): Promise<IamSdk>;
  /**
   * Brokered mode: run `fn` with an IAM client obtained inside a credential-broker session (the credential never reaches this
   * module, and the client is only valid inside the callback). When set, `resolveSecret` and `loadSdk` are not used.
   */
  withClient?<T>(fn: (client: IamClientLike) => Promise<T>): Promise<T>;
}

/** The slice of `@aws-sdk/client-iam` used here, so contract tests can supply a recording client. */
export interface IamSdk {
  createClient(input: { endpoint?: string; region: string; credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } }): IamClientLike;
}
export interface IamClientLike {
  send(command: { name: string; input: Record<string, unknown> }): Promise<Record<string, unknown>>;
  destroy?(): void;
}

const MANAGED_TAG = { Key: "zenith-managed", Value: "tenant-object-store" };

type IamModule = typeof import("@aws-sdk/client-iam");

/** Wrap an AWS SDK IAM client in the narrow command interface used here. */
export function wrapIamClient(mod: IamModule, client: { send(c: never): Promise<unknown>; destroy?(): void }): IamClientLike {
  const commands = {
    GetUser: mod.GetUserCommand, CreateUser: mod.CreateUserCommand, PutUserPolicy: mod.PutUserPolicyCommand, GetUserPolicy: mod.GetUserPolicyCommand,
    CreateAccessKey: mod.CreateAccessKeyCommand, ListAccessKeys: mod.ListAccessKeysCommand, DeleteAccessKey: mod.DeleteAccessKeyCommand, ListUserTags: mod.ListUserTagsCommand,
  } as const;
  return {
    send: (command) => {
      const Ctor = (commands as unknown as Record<string, new (i: never) => never>)[command.name];
      if (!Ctor) throw new Error("unsupported IAM command");
      return (client as unknown as { send(c: unknown): Promise<Record<string, unknown>> }).send(new Ctor(command.input as never));
    },
    destroy: () => client.destroy?.(),
  };
}

async function loadAwsSdk(): Promise<IamSdk> {
  const mod = await import("@aws-sdk/client-iam");
  return {
    createClient(input) {
      return wrapIamClient(mod, new mod.IAMClient({ region: input.region, credentials: input.credentials, ...(input.endpoint ? { endpoint: input.endpoint } : {}), maxAttempts: 2 }) as never);
    },
  };
}

/** The admin port over a brokered provider session: every call opens a fresh session through `withClient` (credential custody, revocation and audit are the broker's). */
export function createBrokeredIamAdminPort(withClient: NonNullable<IamAdminDeps["withClient"]>): ObjectStorageAdminPort {
  return createIamAdminPort({ region: "us-east-1", credentialRef: "brokered" }, { resolveSecret: async () => undefined, withClient });
}

function mapIamError(error: unknown): StorageError {
  const e = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: number }; code?: unknown } | null;
  const name = String(e?.name ?? e?.Code ?? e?.code ?? "");
  const status = e?.$metadata?.httpStatusCode;
  if (name === "AccessDenied" || name === "AccessDeniedException" || name === "UnauthorizedOperation" || status === 403 || status === 401) return { code: "forbidden", message: "The IAM-admin credential was refused by the storage provider.", retryable: false };
  if (name === "Throttling" || name === "ThrottlingException" || name === "RequestLimitExceeded" || status === 429) return { code: "throttled", message: "The storage provider is throttling requests.", retryable: true };
  if (name === "ForeignPrincipal") return { code: "conflict", message: "A principal with that name exists but Zenith did not create it; it will not be used.", retryable: false };
  if (name === "LimitExceeded" || name === "LimitExceededException") return { code: "conflict", message: "The principal already holds the maximum number of access keys.", retryable: true };
  if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "TimeoutError", "NetworkingError"].includes(name)) return { code: "unreachable", message: "The storage provider could not be reached.", retryable: true };
  if (name === "AbortError") return { code: "aborted", message: "The call was cancelled.", retryable: true };
  return { code: "provider_error", message: "The storage provider rejected the request.", retryable: false };
}
const isMissing = (error: unknown): boolean => {
  const e = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: number } } | null;
  const name = String(e?.name ?? e?.Code ?? "");
  return name === "NoSuchEntity" || name === "NoSuchEntityException" || e?.$metadata?.httpStatusCode === 404;
};

export function createIamAdminPort(config: IamAdminConfig | undefined, deps: IamAdminDeps): ObjectStorageAdminPort {
  if (!config) return unavailableStorageAdmin(OBJECT_STORAGE_UNCONFIGURED_REASON);
  const cfg = config;
  async function client(): Promise<IamClientLike> {
    const raw = await deps.resolveSecret(cfg.credentialRef);
    if (!raw) throw Object.assign(new Error("credential missing"), { name: "CredentialMissing" });
    let parsed: { accessKeyId?: unknown; secretAccessKey?: unknown; sessionToken?: unknown };
    try { parsed = JSON.parse(raw) as typeof parsed; } catch { throw Object.assign(new Error("credential malformed"), { name: "CredentialMalformed" }); }
    if (typeof parsed.accessKeyId !== "string" || typeof parsed.secretAccessKey !== "string") throw Object.assign(new Error("credential malformed"), { name: "CredentialMalformed" });
    const sdk = await (deps.loadSdk ?? loadAwsSdk)();
    return sdk.createClient({
      region: cfg.region, ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      credentials: { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey, ...(typeof parsed.sessionToken === "string" ? { sessionToken: parsed.sessionToken } : {}) },
    });
  }
  const run = async <T>(opts: { signal?: AbortSignal } | undefined, fn: (c: IamClientLike) => Promise<T>): Promise<StorageResult<T>> => {
    let c: IamClientLike | undefined;
    try {
      opts?.signal?.throwIfAborted();
      if (deps.withClient) return { ok: true, value: await deps.withClient(fn) };
      c = await client();
      return { ok: true, value: await fn(c) };
    } catch (error) {
      const name = String((error as { name?: unknown } | null)?.name ?? "");
      if (name === "CredentialDeniedError") return storageError("unavailable", "The platform storage credential could not be obtained (denied, revoked or unavailable).", false);
      if (name === "CredentialMissing" || name === "CredentialMalformed") return storageError("unavailable", "The IAM-admin credential could not be read from the vault.", false);
      return { ok: false, error: mapIamError(error) };
    } finally {
      c?.destroy?.();
    }
  };

  return {
    id: "aws-iam",
    availability: () => ({ available: true }),

    ensurePrincipal: (input, opts) => run(opts, async (c) => {
      let created = false;
      try {
        await c.send({ name: "GetUser", input: { UserName: input.name } });
        const tags = await c.send({ name: "ListUserTags", input: { UserName: input.name } });
        const owned = Array.isArray(tags.Tags) && (tags.Tags as { Key?: string; Value?: string }[]).some((t) => t.Key === MANAGED_TAG.Key && t.Value === MANAGED_TAG.Value);
        if (!owned) throw Object.assign(new Error("foreign principal"), { name: "ForeignPrincipal" });
      } catch (error) {
        if (!isMissing(error)) throw error;
        await c.send({ name: "CreateUser", input: { UserName: input.name, Tags: [MANAGED_TAG] } });
        created = true;
      }
      await c.send({ name: "PutUserPolicy", input: { UserName: input.name, PolicyName: STORAGE_POLICY_NAME, PolicyDocument: JSON.stringify(input.policy) } });
      return { created };
    }),

    readPolicyDigest: (name, opts) => run(opts, async (c) => {
      try {
        const r = await c.send({ name: "GetUserPolicy", input: { UserName: name, PolicyName: STORAGE_POLICY_NAME } });
        const doc = typeof r.PolicyDocument === "string" ? decodeURIComponent(r.PolicyDocument) : undefined;
        return doc ? policyDigest(JSON.parse(doc) as IamPolicyDocument) : undefined;
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    }),

    createAccessKey: (name, opts) => run(opts, async (c) => {
      const r = await c.send({ name: "CreateAccessKey", input: { UserName: name } });
      const key = r.AccessKey as { AccessKeyId?: string; SecretAccessKey?: string } | undefined;
      if (!key?.AccessKeyId || !key.SecretAccessKey) throw Object.assign(new Error("malformed"), { name: "MalformedResponse" });
      return { accessKeyId: key.AccessKeyId, secretAccessKey: key.SecretAccessKey };
    }),

    listAccessKeys: (name, opts) => run(opts, async (c) => {
      const r = await c.send({ name: "ListAccessKeys", input: { UserName: name } });
      return ((r.AccessKeyMetadata as { AccessKeyId?: string }[] | undefined) ?? []).flatMap((k) => (k.AccessKeyId ? [k.AccessKeyId] : []));
    }),

    deleteAccessKey: (name, accessKeyId, opts) => run(opts, async (c) => {
      try { await c.send({ name: "DeleteAccessKey", input: { UserName: name, AccessKeyId: accessKeyId } }); }
      catch (error) { if (!isMissing(error)) throw error; }
    }),
  };
}
