/**
 * Secret VALUE sync into Azure Key Vault (data plane).
 *
 * The compiled infrastructure holds references only (a vault and a versionless
 * secret URI). The value reaches Key Vault here, at deploy time, inside the
 * credential-broker session that holds the deploy identity's token
 * ("Key Vault Secrets Officer" on the vault):
 *
 *   GET  <vault>/secrets/<name>   compare in memory → identical ⇒ "unchanged"
 *   PUT  <vault>/secrets/<name>   a new version otherwise
 *
 * so a retried deploy does not mint a new version each time (idempotent), and
 * the value is never written to tofu state, logs, events, errors or results:
 * the result carries the status and the version id only. The GET/PUT response
 * bodies contain the value; they are read for `id`/`value` in memory and
 * dropped. Error text comes from `ArmError`, which takes the error message
 * from Azure and never echoes a request body.
 *
 * Failure modes are distinguished because they need different fixes:
 *   - `forbidden_by_firewall`: the vault's network rules exclude this caller
 *     (tighter-than-default vaults; needs a runner inside the network);
 *   - `forbidden_by_rbac`: the deploy identity lacks a data-plane role;
 *   - `throttled` / `unreachable`: retry later.
 *
 * Honest limits: contract-tested against a fake Key Vault only. Key Vault
 * caps a secret at 25 KiB; larger values are refused before any call.
 */
import type { AzureSession } from "@/lib/credentials/types";
import { ArmError, safeText, sendJson, type Json } from "@/lib/providers/azure/arm";
import { API } from "@/lib/providers/azure/platform";
import { sameSecret } from "@/lib/secrets/delivery";
import { kvSecretName } from "@/lib/providers/azure/drivers/identity/key-vault-secret";

export const MAX_SECRET_BYTES = 25 * 1024;
const VAULT_URI = /^https:\/\/([a-z0-9][a-z0-9-]{1,22}[a-z0-9])\.vault\.azure\.net\/?$/;
const SECRET_NAME = /^[0-9A-Za-z-]{1,127}$/;

export type SecretSyncFailure = "invalid_input" | "forbidden_by_firewall" | "forbidden_by_rbac" | "throttled" | "unreachable" | "conflict" | "rejected";

export class SecretSyncError extends Error {
  readonly code = "secret_sync_failed";
  constructor(
    readonly reason: SecretSyncFailure,
    message: string,
    readonly requestId?: string,
    readonly retryAfterSec?: number
  ) {
    super(message);
    this.name = "SecretSyncError";
  }
}

export interface SyncSecretInput {
  /** `https://<vault>.vault.azure.net/` from the vault's export/observation */
  vaultUri: string;
  /** the secret node's reference (`vault:…`); the Key Vault secret name is derived exactly as the compiled URI is */
  secretRef: string;
  /** the value; never logged, never returned */
  value: string;
  /** operation id + fence token for the Azure Activity Log */
  clientRequestId?: string;
}

export interface SyncSecretResult {
  status: "created" | "updated" | "unchanged";
  secretName: string;
  /** Key Vault version id (not secret material) */
  version: string;
  requestId?: string;
}

const versionOf = (id: unknown): string => (typeof id === "string" ? (id.split("/").pop() ?? "") : "").replace(/[^0-9a-f]/gi, "").slice(0, 64);

function fail(e: unknown): never {
  if (e instanceof SecretSyncError) throw e;
  if (e instanceof ArmError) {
    if (e.kind === "forbidden") {
      // Key Vault names the cause in the error code; the message wording is only a fallback
      const code = (e.armCode ?? "").toLowerCase();
      const firewall = code === "forbiddenbyfirewall" || (code !== "forbiddenbyrbac" && /firewall|client address is not authorized|not a trusted service/i.test(e.message));
      throw new SecretSyncError(firewall ? "forbidden_by_firewall" : "forbidden_by_rbac", firewall ? "The Key Vault firewall refused this caller." : "The deploy identity has no data-plane permission on this vault.", e.requestId);
    }
    if (e.kind === "throttled") throw new SecretSyncError("throttled", "Key Vault throttled the request.", e.requestId, e.retryAfterSec);
    if (e.kind === "conflict") throw new SecretSyncError("conflict", "Key Vault reported a conflict (for example a soft-deleted secret of the same name).", e.requestId);
    if (e.kind === "network" || e.kind === "aborted" || e.kind === "server") throw new SecretSyncError("unreachable", "Key Vault could not be reached.", e.requestId);
    throw new SecretSyncError("rejected", `Key Vault rejected the request (HTTP ${e.status}).`, e.requestId);
  }
  throw new SecretSyncError("unreachable", "Key Vault could not be reached.");
}

/** Write `value` as the current version of the node's secret, unless it already is. */
export async function syncSecretValue(session: AzureSession, input: SyncSecretInput, signal?: AbortSignal): Promise<SyncSecretResult> {
  const vault = VAULT_URI.exec(input.vaultUri);
  if (!vault) throw new SecretSyncError("invalid_input", "vaultUri is not a Key Vault URI (https://<name>.vault.azure.net).");
  const secretName = kvSecretName(input.secretRef);
  if (!SECRET_NAME.test(secretName)) throw new SecretSyncError("invalid_input", "The derived Key Vault secret name is not valid.");
  if (typeof input.value !== "string" || input.value.length === 0) throw new SecretSyncError("invalid_input", "The secret value is empty.");
  if (Buffer.byteLength(input.value, "utf8") > MAX_SECRET_BYTES) throw new SecretSyncError("invalid_input", `The secret value exceeds Key Vault's ${MAX_SECRET_BYTES / 1024} KiB limit.`);
  const base = `https://${vault[1]}.vault.azure.net/secrets/${secretName}`;
  const headers = input.clientRequestId ? { "x-ms-client-request-id": input.clientRequestId.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80) } : undefined;

  let current: { id?: unknown; value?: unknown } | undefined;
  try {
    current = (await sendJson<Json>(session, signal, "GET", `${base}?api-version=${API.keyVaultData}`, { headers })).body;
  } catch (e) {
    if (!(e instanceof ArmError && e.kind === "not_found")) fail(e);
  }
  if (current && typeof current.value === "string" && sameSecret(current.value, input.value)) {
    return { status: "unchanged", secretName, version: versionOf(current.id) };
  }
  try {
    const r = await sendJson<Json>(session, signal, "PUT", `${base}?api-version=${API.keyVaultData}`, {
      headers,
      body: { value: input.value, contentType: "text/plain", attributes: { enabled: true }, tags: { "zenith:managed": "true" } },
    });
    return { status: current ? "updated" : "created", secretName, version: versionOf(r.body.id), requestId: r.requestId };
  } catch (e) {
    fail(e);
  }
}

/** A safe, value-free description of a failure for logs and operation results. */
export const describeSecretSyncError = (e: unknown): string => (e instanceof SecretSyncError ? `${e.reason}: ${safeText(e.message)}` : "secret sync failed");
