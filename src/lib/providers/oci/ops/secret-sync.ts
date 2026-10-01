/**
 * Write a secret VALUE into an OCI Vault secret through the runner transport.
 *
 * Why this exists: a Zenith-managed secret compiles to an OCI Vault secret
 * CONTAINER (vault_secret.ts; OCI cannot create an empty secret, so the
 * container starts with an auto-generated placeholder value nobody knows). The
 * real value lives in Zenith's own vault and must reach OCI without ever
 * touching OpenTofu state, a plan, a log or an event. This helper is the only
 * place that does it:
 *
 *   control plane resolves `vault:…` → value (in memory, for this call only)
 *     → `PUT /20180608/secrets/{id}` body { secretContent } via the transport
 *     → the runner signs it with its principal and forwards it.
 *
 * Guarantees:
 *   - the value appears ONLY in the request body handed to the transport;
 *     results, errors, logs and the returned `data` never contain it or any
 *     digest of it (a digest of a low-entropy secret is a brute-force oracle);
 *   - before writing, the target is re-read and must carry THIS environment's
 *     Zenith tags for THIS node (never write a secret by OCID alone);
 *   - idempotent per operation: the new version is named from the operation
 *     id, so a retried call gets a conflict and reports `already applied`
 *     instead of adding a duplicate version;
 *   - OCI error messages are not echoed (`redactMessage`) because the request
 *     carried a secret;
 *   - size is checked against OCI's 25 KiB secret-content limit.
 *
 * Open point for the runner protocol (RUNNER-PROTOCOL-OCI.md §secret writes):
 * the job payload for this call contains the value. The proposal requires the
 * control plane to seal it to the runner's key and never persist the payload;
 * until that exists, treat `secret.write` on OCI as NOT production-ready.
 */
import { createHash } from "node:crypto";
import type { NativeOperationResult } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { arrayOrItems, asRecord, asString, isZenithObject, locate, type LocateDef, type OciContext } from "../observe-kit";
import { ociPath } from "../services";
import { ociCall } from "../transport";

export const MAX_SECRET_BYTES = 25 * 1024;

export const secretLocateDef: LocateDef = {
  service: "vault",
  get: (id) => ({ path: ociPath("vault", "secrets", id) }),
  list: (compartmentId) => ({ path: ociPath("vault", "secrets"), query: { compartmentId } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

/** Stable, non-secret version name from an idempotency key (the operation id). */
export const versionNameFor = (key: string): string => `zenith-${createHash("sha256").update(`oci-secret-version\0${key}`).digest("hex").slice(0, 20)}`;

export interface SecretSyncArgs {
  node: ResourceNode;
  externalId?: string;
  /** produces the value at the last moment; never stored */
  resolveValue: () => Promise<string> | string;
  /** the idempotency key, normally `ctx.operationId` */
  idempotencyKey: string;
}

export async function syncSecretValue(ctx: OciContext, args: SecretSyncArgs): Promise<NativeOperationResult> {
  const located = await locate(ctx, args.node, args.externalId, secretLocateDef);
  if (located.presence !== "present" || !located.item || !located.externalId) {
    return { ok: false, simulated: false, summary: `Secret container for ${args.node.address} not found or not readable (${located.presence}); nothing was written.`, requestIds: located.requestIds };
  }
  // Re-check ownership even when found by id: an OCID alone is not authority to write.
  if (!isZenithObject(located.item, ctx.environmentId, args.node.address)) {
    return { ok: false, simulated: false, summary: `The secret ${located.externalId} is not tagged as ${args.node.address} in this environment; refusing to write.`, requestIds: located.requestIds };
  }
  if (!args.idempotencyKey) return { ok: false, simulated: false, summary: "An idempotency key (the operation id) is required to write a secret value.", requestIds: located.requestIds };

  let value: string;
  try {
    value = await args.resolveValue();
  } catch {
    return { ok: false, simulated: false, summary: "The secret value could not be resolved; nothing was written.", requestIds: located.requestIds };
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0) return { ok: false, simulated: false, summary: "The secret value is empty; nothing was written.", requestIds: located.requestIds };
  if (bytes > MAX_SECRET_BYTES) return { ok: false, simulated: false, summary: `The secret value is ${bytes} bytes; OCI Vault allows at most ${MAX_SECRET_BYTES}.`, requestIds: located.requestIds };

  const r = await ociCall(
    ctx,
    {
      service: "vault",
      region: args.node.region || ctx.region,
      method: "PUT",
      path: ociPath("vault", "secrets", located.externalId),
      body: { secretContent: { contentType: "BASE64", content: Buffer.from(value, "utf8").toString("base64"), name: versionNameFor(args.idempotencyKey), stage: "CURRENT" } },
    },
    { redactMessage: true }
  );
  const requestIds = [...located.requestIds, ...(r.requestId ? [r.requestId] : [])];
  if (r.ok) return { ok: true, simulated: false, summary: `Wrote a new CURRENT version of the secret for ${args.node.address}.`, data: { bytes }, requestIds };
  if (r.outcome === "not_found" && r.code !== "NotAuthorizedOrNotFound") {
    return { ok: false, simulated: false, summary: "The secret disappeared before the write; nothing was written.", requestIds };
  }
  if (r.status === 409) return { ok: true, simulated: false, summary: `A version named for this operation already exists; the write was already applied.`, data: { alreadyApplied: true }, requestIds };
  return { ok: false, simulated: false, summary: `Writing the secret failed: HTTP ${r.status ?? "?"}${r.code ? ` ${r.code}` : ""} (${r.outcome}).`, requestIds };
}
