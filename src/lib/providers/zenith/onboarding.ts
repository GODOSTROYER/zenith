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
import { computeExecutableSemantics, type ExecutableSemantics } from "@/lib/execution/semantics/digest";
import type { SemanticsStore } from "@/lib/execution/semantics/store";
import type { BrokerPort } from "@/lib/execution/ports";
import { GUEST_TOKEN_MIN_SEC, GUEST_TOKEN_MAX_SEC } from "@/lib/providers/kubernetes/guest";
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

/** Versioned contract of this direct apply engine; never presents it as an OpenTofu saved plan. */
export const ISOLATION_APPLY_CONTRACT = "zenith-tenant-isolation/I1";

/**
 * Canonical DUR-B inputs for the isolation operation, using the existing semantics format/store.
 * Credential REFERENCES are bound, never credential values. Token scope/lifetime are executable effects,
 * even though the older proposal request digest did not include them. Lease renewal alone is not a change.
 */
export function isolationExecutableSemantics(request: TenantIsolationRequest, plan: Pick<TenantIsolationPlan, "planDigest" | "bundleDigest" | "namespace">): ExecutableSemantics {
  if (![plan.planDigest, plan.bundleDigest].every((d) => /^[a-f0-9]{64}$/.test(d))) throw new TenantIsolationError("invalid_request", "Isolation semantics require exact plan and bundle digests.");
  if (request.tokenTtlSec !== undefined && !Number.isFinite(request.tokenTtlSec)) throw new TenantIsolationError("invalid_request", "The operator token lifetime must be finite.");
  return computeExecutableSemantics({
    revision: { id: null, deployedRevisionId: null, manifestDigest: null },
    recipe: { executableSourceDigest: null, sources: [] },
    scripts: { release: null },
    migrations: null,
    targets: {
      graphDigest: isolationRequestDigest(request), provider: "zenith", region: request.substrate.region,
      environmentId: request.tenant.environmentId, connectionId: request.substrate.cluster.kubeconfigRef,
      connectionConfigDigest: digest({ cluster: request.substrate.cluster, namespace: plan.namespace, operatorCredentialPrefix: request.substrate.isolation?.operatorCredentialPrefix ?? null }),
    },
    configuration: { configDigest: digest({ bundleDigest: plan.bundleDigest, runtimeClass: request.substrate.isolation?.runtimeClass ?? null, audiences: [...new Set(request.audiences ?? [])].sort(), tokenTtlSec: Math.max(GUEST_TOKEN_MIN_SEC, Math.min(GUEST_TOKEN_MAX_SEC, Math.floor(request.tokenTtlSec ?? GUEST_TOKEN_MIN_SEC))) }) },
    providerLocks: { lockDigest: digest({ contract: ISOLATION_APPLY_CONTRACT }), tofuVersion: null },
    backend: { kind: "provider-direct", configDigest: null },
    savedPlan: { planDigest: plan.planDigest },
    provenance: { pipelines: [] }, ownership: { transfers: [] }, runbook: null, decommission: { adoptions: [] },
  });
}

/**
 * Assembly seam for MAN-01. Must be supplied with the production durable semantics store and current broker.
 * Planning callers publish the returned semantics in critical plan evidence BEFORE requesting human review.
 * Apply callers invoke assertReviewed at the dispatch guard, BEFORE the batch vet/effect/provider call.
 * This does not issue approval, credentials, a lease, or an effect. No missing-store/legacy bypass exists.
 * The base's execution provisioner does not call this seam yet; see PROD-MAN-04-05.md for the owned-file join.
 */
export function createIsolationSemanticsGuard(store: SemanticsStore | undefined, broker: Pick<BrokerPort, "approvalStatus">) {
  const requiredStore = (): SemanticsStore => {
    if (!store) throw new TenantIsolationError("not_configured", "Durable reviewed isolation semantics are not configured; onboarding must not dispatch.");
    return store;
  };
  return {
    async recordReviewed(request: TenantIsolationRequest, plan: TenantIsolationPlan): Promise<ExecutableSemantics> {
      const semantics = isolationExecutableSemantics(request, plan);
      await requiredStore().record({ workspaceId: request.tenant.workspaceId, operationId: request.operationId, planDigest: plan.planDigest, semantics });
      return semantics;
    },
    async assertReviewed(request: TenantIsolationRequest, plan: Pick<TenantIsolationPlan, "planDigest" | "bundleDigest" | "namespace">): Promise<void> {
      const approved = await requiredStore().get(request.tenant.workspaceId, request.operationId, plan.planDigest);
      const current = isolationExecutableSemantics(request, plan);
      if (!approved || approved.semantics.digest !== current.digest) throw new TenantIsolationError("plan_changed", "The reviewed isolation semantics are missing or changed; a new human review is required. Nothing was dispatched.");
      // Same existing worker broker: current policy, roles, separation and human approval still own admission.
      const authority = await broker.approvalStatus(request.operationId);
      if (!authority.approved || authority.rejected || !authority.approvalId || authority.dispatchApproval?.planDigest !== plan.planDigest) throw new TenantIsolationError("approval_required", "Current human approval is not bound to this isolation plan; nothing was dispatched.");
    },
  };
}
