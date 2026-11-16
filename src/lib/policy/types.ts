/**
 * Policy engine contract (spec §14, ADR-0008).
 *
 * Policy is Rego (Open Policy Agent), compiled to WebAssembly and evaluated
 * in-process, deterministically, with no network. The compiled bundle's
 * SHA-256 is the policy version recorded on every decision, together with
 * the digest of the exact input.
 *
 * The model never evaluates policy and never sees a way around it: the
 * capability broker builds `PolicyInput` from authoritative state (stores,
 * the normalized OpenTofu plan, the environment's configured autonomy), not
 * from anything a client or model asserted.
 */
import type { ApprovalRequirement, PolicyOutcome, PolicyReason } from "@/lib/controlplane/types";

export type EnvironmentClass = "sandbox" | "development" | "staging" | "production";
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** Facts extracted deterministically from a normalized OpenTofu plan. */
export interface PlanFacts {
  create: number;
  update: number;
  delete: number;
  replace: number;
  /** any delete/replace of a stateful resource */
  destroysData: boolean;
  destroyedStatefulAddresses: string[];
  /** Stateful resources deleted or replaced; optional for legacy plan evidence. */
  statefulDeletes?: string[];
  /** DNS records deleted or replaced, distinct from creates and updates. */
  dnsDeletes?: string[];
  /** regions any created/updated resource lands in */
  regions: string[];
  /** a database/cache made publicly accessible */
  publicDatabases: string[];
  /** ingress from 0.0.0.0/0 or ::/0 on a port other than 80/443 */
  openIngress: { address: string; port: string; cidr: string }[];
  /** IAM statements granting `*` actions or `*` resources */
  wildcardIam: string[];
  /** IAM/identity resources created, changed or deleted */
  identityChanges: string[];
  /** firewall/security group changes */
  firewallChanges: string[];
  dnsChanges: string[];
  /**
   * Security-relevant values the plan cannot settle before apply (a public-access
   * flag, an ingress CIDR or port, an IAM policy document that is masked, unknown
   * until apply, or unparseable), as `<address>:<attribute>`. The policy asks a
   * person to review a plan that has any. Additive and optional: facts built
   * without it are valid and mean "none reported".
   */
  unresolved?: string[];
}

export interface WorkspacePolicyParams {
  /** if set, any region outside this list is denied */
  approvedRegions?: string[];
  /** monthly cost increase (USD) at or above which approval is required */
  costApprovalThresholdUsd: number;
  budgetUsdMonthly?: number;
  /** machine.exec / container.exec / provider.native allowed in production at all */
  allowEscapeHatchInProduction: boolean;
  /** production mutations need an approver other than the requester */
  twoPersonProduction: boolean;
  /** which remediation may run without approval, per environment class */
  autoRemediation: Record<EnvironmentClass, "none" | "safe" | "any">;
  /** capabilities denied outright in this workspace */
  deniedCapabilities: string[];
}

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicyParams = {
  costApprovalThresholdUsd: 50,
  allowEscapeHatchInProduction: false,
  twoPersonProduction: false,
  autoRemediation: { sandbox: "any", development: "any", staging: "safe", production: "none" },
  deniedCapabilities: [],
};

export interface PolicyInput {
  version: 1;
  request: {
    capability: string;
    risk: "low" | "medium" | "high" | "critical";
    mutates: boolean;
    destructive: boolean;
    escapeHatch: boolean;
    /** minimum autonomy level for unattended execution, from the catalog */
    defaultAutonomy: number;
    /**
     * The coarse credential scope the capability needs (catalog `integrationScope`).
     * The engine fills it from the catalog when absent and rejects a value that
     * disagrees with the catalog, so a broker cannot understate what it asks for.
     */
    integrationScope?: "read" | "plan" | "logs" | "write" | "publish";
    scope: { workspaceId: string; projectId?: string; environmentId?: string; resourceId?: string };
    requestedDurationSec?: number;
    constraints?: Record<string, unknown>;
  };
  principal: {
    kind: "user" | "integration" | "navigator" | "system" | "runner" | "machine";
    id: string;
    /** workspace role of the human behind the request ("none" if not a member) */
    role: "viewer" | "editor" | "admin" | "none";
    /** integration credential scopes, when kind is integration */
    integrationScopes?: string[];
  };
  environment?: {
    id: string;
    class: EnvironmentClass;
    autonomyLevel: AutonomyLevel;
    provider: string;
    region: string;
  };
  resource?: {
    address: string;
    kind: string;
    stateful: boolean;
    ownership: "managed" | "referenced" | "external";
    publiclyExposed: boolean;
  };
  plan?: PlanFacts & { costDeltaUsdMonthly?: number; projectedMonthlyUsd?: number };
  workspacePolicy: WorkspacePolicyParams;
  context: {
    /** ISO time supplied by the broker, so evaluation is reproducible */
    now: string;
    origin: "human" | "agent" | "navigator" | "system" | "reconciler";
  };
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reasons: PolicyReason[];
  approval?: ApprovalRequirement;
  /** restrictions the executor must enforce when outcome is allow/require_approval */
  constraints?: Record<string, unknown>;
}

export interface EvaluatedPolicy {
  decision: PolicyDecision;
  /** sha256 of the policy bundle */
  policyVersion: string;
  inputDigest: string;
  evaluatedAt: string;
}

export interface PolicyEngine {
  readonly version: string;
  evaluate(input: PolicyInput): Promise<EvaluatedPolicy>;
}
