/**
 * The interface MAN-01's managed substrate calls on tenant onboarding (PROD-MAN-04).
 *
 * Onboarding a tenant is not finished when its namespace exists: it is finished when the namespace baseline, the
 * hostname egress policy, the system-priority quota and the per-tenant operator access are APPLIED to the cluster,
 * READ BACK and shown to match, and a short-lived credential for the tenant's own operator identity is minted and
 * stored. Anything less is a refusal: the interface throws `TenantIsolationError`, the caller must not mark the tenant
 * onboarded, and it must not give the tenant a session. There is no degraded mode.
 *
 * The implementation is `createTenantIsolationProvisioner` in `src/lib/execution/tenant-isolation.ts`. It runs the
 * normal guard chain (quota admission, lease fence, current human approval bound to the exact plan digest, plan digest
 * recheck, effect-ledger record before the cluster call) and applies with server-side apply under the platform
 * bootstrap identity, never the tenant's. This file holds only the contract so MAN-01 can code against it without
 * importing the execution runtime.
 *
 * Calling sequence for MAN-01 (one onboarding is one platform operation):
 *   1. create the operation through the normal propose / approval path (kind: day-two, the proposal input carries
 *      `isolationRequestDigest(request)`);
 *   2. `plan(request)` inside that operation's plan step. The returned `planDigest` is what the reviewer approves;
 *   3. after approval, `apply(request, planDigest)` inside the apply step; or `provision(request)` where the caller has
 *      already approved and wants plan, recheck and apply in one worker activity;
 *   4. on a schedule shorter than the token lifetime, `rotateCredential(request)` to mint the next token;
 *   5. treat ANY `TenantIsolationError` as "tenant not onboarded".
 */
import { digest } from "@/lib/controlplane/digest";
import type { ZenithSubstrate } from "./substrate";
import type { ZenithTenant } from "./types";

export type TenantIsolationErrorCode =
  | "not_configured"
  | "invalid_request"
  | "admission_refused"
  | "plan_failed"
  | "plan_changed"
  | "approval_required"
  | "lease_lost"
  | "effect_unresolved"
  | "apply_failed"
  | "verify_failed"
  | "credential_failed";

/** A fixed-code failure with a message that is safe to show: never a token, a kubeconfig or provider text. */
export class TenantIsolationError extends Error {
  readonly code: TenantIsolationErrorCode;
  constructor(code: TenantIsolationErrorCode, message: string) {
    super(message);
    this.name = "TenantIsolationError";
    this.code = code;
  }
}

export interface TenantIsolationRequest {
  tenant: ZenithTenant;
  substrate: ZenithSubstrate;
  /** the platform operation carrying this onboarding through plan and approval; the effect ledger needs it */
  operationId: string;
  /** the writer lease the apply runs under (DUR authority fence) */
  lease: { scope: string; fenceToken: number };
  /** hostnames this tenant may reach on 443 in addition to the platform list (needs a hostname engine) */
  egressFqdns?: readonly string[];
  /** the environment has a managed database, so its egress rules are rendered */
  withManagedDatabase?: boolean;
  /** TokenRequest audiences for the operator token; empty means the API server default */
  audiences?: readonly string[];
  /** operator token lifetime in seconds (clamped to 600..3600 by the MACH-02 minter) */
  tokenTtlSec?: number;
}

export interface TenantIsolationPlanObject {
  kind: string;
  namespace?: string;
  name: string;
  action: "create" | "update" | "none";
}

export interface TenantIsolationPlan {
  /** SHA-256 over the rendered bytes and each object's action against the live cluster; what approval binds */
  planDigest: string;
  /** SHA-256 over the rendered objects alone */
  bundleDigest: string;
  namespace: string;
  objects: TenantIsolationPlanObject[];
  notes: string[];
}

export interface TenantIsolationResult {
  planDigest: string;
  bundleDigest: string;
  namespace: string;
  /** objects created or changed by this apply (zero on a repeat) */
  applied: number;
  /** every object read back and matching what was rendered */
  verified: number;
  /** where the operator credential was stored and when the stored token expires; the token itself is never returned */
  credential: { ref: string; expiresAt: string };
  /** true when an earlier apply of this exact plan was found in the effect ledger and only verification ran */
  deduplicated: boolean;
}

export interface TenantIsolationProvisioner {
  plan(request: TenantIsolationRequest): Promise<TenantIsolationPlan>;
  apply(request: TenantIsolationRequest, approvedPlanDigest: string): Promise<TenantIsolationResult>;
  /** plan, then apply only if the current approval is bound to exactly that plan digest */
  provision(request: TenantIsolationRequest): Promise<TenantIsolationResult>;
  /** mint the next operator token for an already-provisioned tenant (MACH-02 minter) and store it */
  rotateCredential(request: TenantIsolationRequest): Promise<{ ref: string; expiresAt: string }>;
}

/** What the onboarding operation's proposal input should carry: the request without lease, audiences or ttl (those are not part of what is approved). */
export function isolationRequestDigest(request: Pick<TenantIsolationRequest, "tenant" | "egressFqdns" | "withManagedDatabase">): string {
  const t = request.tenant;
  return digest({
    kind: "zenith.tenant-isolation-request.v1",
    workspaceId: t.workspaceId,
    environmentId: t.environmentId,
    workspaceSlug: t.workspaceSlug,
    environmentSlug: t.environmentSlug,
    planTier: t.planTier,
    egressFqdns: [...new Set((request.egressFqdns ?? []).map((h) => h.trim().toLowerCase()))].sort(),
    withManagedDatabase: request.withManagedDatabase === true,
  });
}
