/**
 * Activity-local vault resolver and managed-database sink. Workspace is always
 * the encrypted store key; project and generated-environment boundaries are
 * checked before reading. Passwords use atomic insert-or-return, across workers.
 * Connection URIs come from the adapter and cannot be fabricated by a resolver.
 * Only encrypted records persist. JavaScript strings cannot be securely zeroed;
 * callers must drop them after the provider request settles.
 */
import { randomBytes } from "node:crypto";
import type { ConnectionSecretSink } from "@/lib/providers/zenith/database";
import { asyncSecretsBackend, KEY_VERSION, type AsyncSecretsBackend } from "./backend";
import { seal, unseal } from "./index";
import { SecretDeliveryError, sameSecret, type SecretTenant } from "./delivery";

export interface SecretResolverScope extends SecretTenant {
  /** Managed resource addresses in the current environment. */
  resourceAddresses: readonly string[];
  /** When present, only refs of the current sync batch can be read. */
  allowedRefs?: readonly string[];
}

export function assertVaultScope(ref: string, scope: SecretResolverScope): "password" | "connection-uri" | "stored" {
  if (scope.allowedRefs && !scope.allowedRefs.includes(ref)) throw new SecretDeliveryError("denied");
  if (typeof ref !== "string" || ref.length > 1024 || /\s|\\|%/.test(ref)) throw new SecretDeliveryError("invalid");
  const generated = /^vault:generated\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)\/(password|connection-uri)$/.exec(ref);
  if (ref.startsWith("vault:generated/")) {
    if (!generated || generated[1] !== scope.environmentId || !scope.resourceAddresses.includes(generated[2])) throw new SecretDeliveryError("denied");
    return generated[3] as "password" | "connection-uri";
  }
  const regular = /^vault:([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?$/.exec(ref);
  if (!regular || regular.slice(1).some((p) => p === "." || p === "..") || (regular[2] && regular[1] !== scope.projectId)) throw new SecretDeliveryError("denied");
  // Legacy single-key references are intentionally workspace-shared.
  return "stored";
}

async function insertOnce(backend: AsyncSecretsBackend, scope: SecretResolverScope, ref: string, value: string): Promise<string> {
  if (!value || Buffer.byteLength(value, "utf8") > 8192) throw new SecretDeliveryError("invalid");
  const now = new Date().toISOString();
  const record = await backend.putIfAbsent(scope.workspaceId, {
    ref, createdAt: now, updatedAt: now, createdBy: "secret-sync", updatedBy: "secret-sync", version: 1, keyVersion: KEY_VERSION,
    ...seal(scope.workspaceId, ref, value),
  });
  return unseal(scope.workspaceId, ref, record);
}

export function createSecretResolver(scope: SecretResolverScope, backend: AsyncSecretsBackend = asyncSecretsBackend()): (ref: string) => Promise<string | undefined> {
  return async (ref) => {
    const kind = assertVaultScope(ref, scope);
    try {
      const record = await backend.get(scope.workspaceId, ref);
      if (record) return unseal(scope.workspaceId, ref, record);
      if (kind === "password") return await insertOnce(backend, scope, ref, randomBytes(32).toString("hex"));
      return undefined;
    } catch {
      throw new SecretDeliveryError("unreachable");
    }
  };
}

export function createConnectionSecretSink(scope: SecretResolverScope, backend: AsyncSecretsBackend = asyncSecretsBackend()): ConnectionSecretSink {
  const check = (ref: string) => { if (assertVaultScope(ref, scope) !== "connection-uri") throw new SecretDeliveryError("denied"); };
  return {
    async exists(ref) {
      check(ref);
      try { return Boolean(await backend.get(scope.workspaceId, ref)); }
      catch { throw new SecretDeliveryError("unreachable"); }
    },
    async put(ref, value) {
      check(ref);
      try {
        const stored = await insertOnce(backend, scope, ref, value);
        if (!sameSecret(stored, value)) throw new SecretDeliveryError("conflict");
      } catch (err) {
        if (err instanceof SecretDeliveryError) throw err;
        throw new SecretDeliveryError("unreachable");
      }
    },
  };
}
