/**
 * Shared vocabulary of the Zenith-managed provider (`provider = "zenith"`).
 *
 * Honest status, repeated wherever it matters: NOBODY operates a hosted Zenith
 * cluster today. Everything in this module is code plus contract tests against
 * fakes (a fake Neon API server, a fake Kubernetes toolkit). No evidence level
 * here is higher than `contract`; docs/platform/MANAGED-PLATFORM.md says what
 * would have to exist before any of it is `real`.
 *
 * The provider is an ordinary provider, not a fork of the product
 * architecture: Zenith-managed resources satisfy the same portable contracts
 * (`src/lib/resources`, `src/lib/drivers`) and reuse the Kubernetes provider's
 * renderers and apply path. What this module adds is the TENANCY layer that
 * makes one shared cluster safe to hand to many workspaces, the platform
 * SUBSTRATE configuration (domain, gateway, registry, managed database), and
 * the honest answers for everything the managed platform does not offer.
 */

/** Plan tiers a workspace can hold; quotas and limits derive from this (`plans.ts`). */
export const PLAN_TIERS = ["free", "starter", "pro"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

/**
 * Who a managed environment belongs to. Ids are the control plane's; slugs are
 * the DNS-safe names the control plane guarantees unique (workspace slugs
 * globally, environment slugs per workspace). Uniqueness is NOT checked here:
 * two workspaces sharing a slug would share hostnames, which is a control-plane
 * invariant this module depends on and documents.
 */
export interface ZenithTenant {
  workspaceId: string;
  environmentId: string;
  workspaceSlug: string;
  environmentSlug: string;
  planTier: PlanTier;
}

export type ZenithErrorCode =
  | "invalid_tenant"
  | "invalid_hostname"
  | "tenant_mismatch"
  | "isolation_violation"
  | "unsupported"
  | "plan_limit"
  | "render_error";

/** A failure with a stable code and a message that is safe to show (never a secret value). */
export class ZenithError extends Error {
  readonly code: ZenithErrorCode;
  constructor(code: ZenithErrorCode, message: string) {
    super(message);
    this.name = "ZenithError";
    this.code = code;
  }
}

/** The platform label keys Zenith puts on every managed namespace. */
export const TENANT_LABEL = {
  workspace: "zenith.dev/workspace",
  environment: "zenith.dev/environment",
  /** selected by the gateway's `allowedRoutes` so only tenant namespaces may attach routes */
  tenant: "zenith.dev/tenant",
  plan: "zenith.dev/plan",
  route: "zenith.dev/route",
} as const;

export const TENANT_ANNOTATION = {
  workspaceId: "zenith.dev/workspace-id",
  /** original hostnames a managed route stands in for (comma separated, sorted) */
  sourceHosts: "zenith.dev/source-hosts",
  planTier: "zenith.dev/plan-tier",
} as const;

/** The ServiceAccount every tenant pod runs as; it has no role bindings and no mounted token. */
export const TENANT_SERVICE_ACCOUNT = "zenith-tenant";

/** Object names of the tenancy baseline, one per namespace. */
export const TENANCY_OBJECTS = {
  defaultDeny: "zenith-default-deny",
  allowPlatform: "zenith-allow-platform",
  quota: "zenith-quota",
  limits: "zenith-limits",
  serviceAccount: TENANT_SERVICE_ACCOUNT,
} as const;

/** Synthetic addresses the tenancy objects carry in `zenith.dev/resource`, so ownership checks have something exact to compare. */
export const TENANCY_ADDRESS = {
  namespace: "tenancy/namespace",
  defaultDeny: "tenancy/default-deny",
  allowPlatform: "tenancy/allow-platform",
  quota: "tenancy/quota",
  limits: "tenancy/limits",
  serviceAccount: "tenancy/service-account",
} as const;
