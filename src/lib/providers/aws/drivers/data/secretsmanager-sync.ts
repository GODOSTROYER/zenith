/**
 * Secret VALUE sync: the one place a secret value touches AWS from this
 * platform, and it is deliberately not a driver operation.
 *
 * The execution worker's secret-sync activity (a separate workstream) resolves
 * a `vault:` reference and calls `syncSecretValue`, passing a closure that
 * yields the value. The value therefore exists only:
 *
 *   - inside that closure's return value,
 *   - in this function's local scope, for the duration of one
 *     `PutSecretValue` request body.
 *
 * It is never logged, never returned, never placed in an error, a result, a
 * request token, a tag or OpenTofu state. `ctx.log` receives the secret's
 * NAME and the resulting version id only.
 *
 * Idempotency: `ClientRequestToken` (Secrets Manager's idempotency key, which
 * becomes the new version's id) is `HMAC-SHA256(key = operationId, message =
 * node address + value)` in hex (64 characters, the API maximum). So:
 *   - the same operation retrying the same value sends the same token, and
 *     Secrets Manager returns the version it already created;
 *   - a different value can never reuse a token (which the API would reject);
 *   - the token commits to the value, yet leaks nothing about it: it is keyed
 *     by the operation id, which never reaches AWS. A plain hash of the value
 *     would have let anyone with `DescribeSecret` (which lists version ids)
 *     confirm a guess of a short or common secret offline.
 *
 * Safety before sending: the target secret must exist, must not be scheduled
 * for deletion, and must carry THIS node's Zenith tags (workspace, environment,
 * resource address). A secret Zenith does not own is never written, even when
 * an id is supplied. The fence token is enforced by the caller holding the
 * lease; `PutSecretValue` has no tag parameter to carry it.
 *
 * Honest limits: exercised against a mocked SDK only. Whether the stored value
 * equals the vault's cannot be verified here, because reading it is refused.
 */
import { PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createHmac } from "node:crypto";
import type { ResourceNode } from "@/lib/resources/types";
import { describeNodeSecret } from "./secretsmanager-secret";
import { call, classifyAwsError, tagMap, tagsMatchNode, type AwsDriverContext } from "./support";

/** Secrets Manager's documented limit for one secret value. */
export const MAX_SECRET_BYTES = 65536;

export type SecretSyncFailure =
  | "no_operation_id"
  | "target_missing"
  | "target_ambiguous"
  | "target_not_owned"
  | "target_pending_deletion"
  | "value_unavailable"
  | "value_invalid"
  | "access_denied"
  | "throttled"
  | "conflict"
  | "error";

export interface SecretSyncResult {
  ok: boolean;
  /** model-safe and value-free */
  summary: string;
  /** the Secrets Manager version id (equals the client request token) */
  versionId?: string;
  failure?: SecretSyncFailure;
  requestId?: string;
}

/** The idempotency token for one (operation, node, value). 64 lowercase hex characters. */
export function secretSyncToken(operationId: string, nodeAddress: string, value: string): string {
  return createHmac("sha256", operationId).update(`zenith.secret.sync.v1\0${nodeAddress}\0`).update(value).digest("hex");
}

const fail = (failure: SecretSyncFailure, summary: string, requestId?: string): SecretSyncResult => ({ ok: false, failure, summary, ...(requestId ? { requestId } : {}) });

/**
 * Write one secret value into the node's Secrets Manager secret.
 *
 * @param readValue yields the plaintext from the Zenith vault. Called at most
 *        once, only after the target has been verified as this node's secret.
 *        If it throws, the failure is reported without its message.
 * @param options.externalId the secret ARN or name when known (from tofu
 *        outputs); otherwise the secret is found by its Zenith tags.
 */
export async function syncSecretValue(
  ctx: AwsDriverContext,
  node: ResourceNode,
  readValue: () => Promise<string>,
  options: { externalId?: string } = {}
): Promise<SecretSyncResult> {
  if (!ctx.operationId) return fail("no_operation_id", "A secret sync needs an operation id: the request token is derived from it so a retry is idempotent.");
  let value: string | undefined;
  try {
    const target = await describeNodeSecret(ctx, node, options.externalId);
    if (target === "missing") return fail("target_missing", `No Secrets Manager secret was found for ${node.address}; apply the infrastructure plan first.`);
    if ("ambiguous" in target) return fail("target_ambiguous", `Refusing to write: ${target.ambiguous}.`);
    const secret = target.secret;
    if (!secret.ARN) return fail("error", "The provider returned a secret without an ARN.");
    if (!tagsMatchNode(tagMap(secret.Tags), ctx, node)) {
      return fail("target_not_owned", `Refusing to write ${secret.Name ?? "the secret"}: it does not carry the Zenith tags for ${node.address} in this environment.`);
    }
    if (secret.DeletedDate !== undefined) return fail("target_pending_deletion", `${secret.Name ?? "The secret"} is scheduled for deletion; restore it before writing a value.`);

    try {
      value = await readValue();
    } catch {
      // The closure's error may carry vault internals; say only that it failed.
      return fail("value_unavailable", "The vault could not supply the value for this secret.");
    }
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
      value = undefined;
      return fail("value_invalid", `The value must be a non-empty string of at most ${MAX_SECRET_BYTES} bytes.`);
    }

    const token = secretSyncToken(ctx.operationId, node.address, value);
    const sm = ctx.session.client(SecretsManagerClient);
    const SecretId = secret.ARN;
    const SecretString = value;
    const out = await call(ctx, (o) => sm.send(new PutSecretValueCommand({ SecretId, SecretString, ClientRequestToken: token }), o));
    ctx.log(`secret sync: wrote version ${out.VersionId ?? "unknown"} of ${secret.Name ?? "a secret"} for ${node.address}`, "info");
    return { ok: true, summary: `Wrote a new version of ${secret.Name ?? "the secret"}.`, versionId: out.VersionId ?? token, ...(out.$metadata?.requestId ? { requestId: out.$metadata.requestId } : {}) };
  } catch (err) {
    const f = classifyAwsError(err, ctx.signal);
    if (f.kind === "aborted") throw err;
    // Only the error CODE (restricted to a safe alphabet) is ever surfaced: SDK messages can echo request fields.
    const code = f.code.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60);
    const base = `Secrets Manager refused the write (${code}).`;
    const requestId = f.requestId;
    if (f.kind === "inaccessible") return fail("access_denied", base, requestId);
    if (f.kind === "throttled") return fail("throttled", base, requestId);
    if (f.kind === "missing") return fail("target_missing", base, requestId);
    if (code === "ResourceExistsException") return fail("conflict", base, requestId);
    ctx.log(`secret sync failed for ${node.address}: ${code}`, "error");
    return fail("error", base, requestId);
  } finally {
    value = undefined;
  }
}
