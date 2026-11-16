/**
 * Shared delivery guards. Errors carry fixed classifications only, never external
 * messages/codes/bodies. Content comparisons happen in memory; public hashes of
 * low-entropy secret values must never become metadata or evidence.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";

export type SecretFailure = "denied" | "throttled" | "unreachable" | "missing" | "invalid" | "unsupported" | "conflict";
export class SecretDeliveryError extends Error {
  constructor(readonly reason: SecretFailure) {
    super(`Secret delivery refused (${reason}).`);
    this.name = "SecretDeliveryError";
  }
}
export interface SecretWriteResult { changed: boolean; versionId?: string }
export interface SecretTenant { workspaceId: string; environmentId: string; projectId: string }

export function sameSecret(a: string | Uint8Array, b: string | Uint8Array): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Exact resources must be SIGNED by the capability broker, not added locally. */
export function assertSecretGrant(grant: CapabilityGrantClaims, tenant: SecretTenant, resources: readonly string[], now = Date.now()): void {
  const allowed = grant.constraints?.secretResources;
  if (grant.cap !== "secret.write" || grant.aud !== "worker" || grant.ws !== tenant.workspaceId || grant.env !== tenant.environmentId || grant.proj !== tenant.projectId || !Number.isFinite(grant.exp) || grant.exp * 1000 <= now ||
      !Array.isArray(allowed) || allowed.length !== resources.length || new Set(allowed).size !== allowed.length ||
      allowed.some((r) => typeof r !== "string" || !resources.includes(r))) throw new SecretDeliveryError("denied");
}

/** Branch only on known codes/statuses. Arbitrary external strings never escape. */
export function secretFailure(err: unknown): SecretDeliveryError {
  if (err instanceof SecretDeliveryError) return err;
  const e = err as { name?: unknown; code?: unknown; status?: unknown; $metadata?: { httpStatusCode?: number } } | null;
  const status = e?.status ?? e?.$metadata?.httpStatusCode;
  if (status === 401 || status === 403 || ["AccessDenied", "AccessDeniedException", "Forbidden", "credential_denied", "forbidden", "unauthorized", "namespace_forbidden", "ownership_conflict"].includes(String(e?.code ?? e?.name))) return new SecretDeliveryError("denied");
  if (status === 429 || ["Throttling", "ThrottlingException", "TooManyRequestsException", "LimitExceededException"].includes(String(e?.code ?? e?.name))) return new SecretDeliveryError("throttled");
  if (status === 404 || e?.name === "ResourceNotFoundException") return new SecretDeliveryError("missing");
  return new SecretDeliveryError("unreachable");
}
