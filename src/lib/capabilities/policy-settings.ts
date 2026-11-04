/**
 * Workspace policy parameters (ADR-0008): the data a workspace tunes —
 * approved regions, cost threshold, two-person rule, auto-remediation classes,
 * denied capabilities. Reading is open to members; writing is for a human
 * admin in a browser session, validated by `resolveWorkspacePolicy` so an
 * unknown key or capability name is refused loudly instead of silently
 * denying nothing.
 *
 * Only the OVERRIDES are stored (what the workspace changed); the response also
 * carries the fully resolved parameters the policy input will contain.
 */
import { entitlementPlanFor } from "@/lib/billing/admission";
import { firstPlanWith } from "@/lib/billing/plans";
import type { Principal } from "@/lib/controlplane/types";
import { PolicyConfigError, resolveWorkspacePolicy, type WorkspacePolicyOverrides, type WorkspacePolicyParams } from "@/lib/policy";
import { BrokerError } from "./errors";
import { memberAccess, newId, requireHumanSession } from "./internal";
import { ROLE_RANK, type BrokerDeps } from "./ports";
import type { BrowserSessionProof } from "./types";

export interface WorkspacePolicyView {
  workspaceId: string;
  /** what this workspace set; `{}` when it never did */
  overrides: Record<string, unknown>;
  /** the complete parameters policy evaluates with */
  effective: WorkspacePolicyParams;
  version: number;
  isDefault: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

function viewOf(row: { workspaceId: string; params: Record<string, unknown>; version: number; isDefault: boolean; updatedBy?: string; updatedAt?: string }): WorkspacePolicyView {
  let effective: WorkspacePolicyParams;
  try {
    effective = resolveWorkspacePolicy(row.params as WorkspacePolicyOverrides);
  } catch (error) {
    if (error instanceof PolicyConfigError) {
      throw new BrokerError("policy_unavailable", "This workspace's stored policy is invalid; every request is refused until an admin saves a valid one.", "Save a valid policy.");
    }
    throw error;
  }
  return { workspaceId: row.workspaceId, overrides: row.params, effective, version: row.version, isDefault: row.isDefault, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
}

export async function getWorkspacePolicy(deps: BrokerDeps, input: { workspaceId: string; principal: Principal }): Promise<WorkspacePolicyView> {
  await memberAccess(deps, input.principal, input.workspaceId);
  return viewOf(await deps.store.getWorkspacePolicy(input.workspaceId));
}

export async function setWorkspacePolicy(
  deps: BrokerDeps,
  input: { workspaceId: string; overrides: unknown; actor: Principal; session: BrowserSessionProof; expectedVersion?: number }
): Promise<WorkspacePolicyView> {
  requireHumanSession(input.actor, input.session, "change workspace policy");
  const access = await memberAccess(deps, input.actor, input.workspaceId);
  if (ROLE_RANK[access.role] < ROLE_RANK.admin) {
    throw new BrokerError("admin_required", `Changing workspace policy needs the admin role and you are ${access.role} in this workspace.`, "Ask a workspace admin.");
  }
  if (input.overrides === null || typeof input.overrides !== "object" || Array.isArray(input.overrides)) {
    throw new BrokerError("invalid_request", "Workspace policy must be a JSON object of overrides.");
  }
  try {
    resolveWorkspacePolicy(input.overrides as WorkspacePolicyOverrides);
  } catch (error) {
    if (error instanceof PolicyConfigError) {
      throw new BrokerError("invalid_request", `Invalid workspace policy: ${error.issues.join("; ").slice(0, 600)}`, "Fix the listed fields and save again.", { issues: error.issues.slice(0, 20) });
    }
    throw error;
  }
  // Managed billing only: organizational policies and team approval workflows belong to Team and Enterprise. Only EDITS are
  // refused; an existing policy stays fully enforced and readable after a downgrade (getWorkspacePolicy is not gated).
  const plan = await entitlementPlanFor(input.workspaceId, deps.billing);
  if (plan && !plan.entitlements.orgPolicies) {
    const includedIn = firstPlanWith("orgPolicies");
    throw new BrokerError(
      "plan_feature_unavailable",
      `${plan.name} does not include organizational policies and team approval workflows, so the workspace policy was not changed. Any policy already saved stays enforced.`,
      includedIn ? `Move this workspace to ${includedIn.name} or a higher plan to edit workspace policy.` : "Move this workspace to a plan that includes organizational policies.",
      { feature: "org_policies", plan: plan.id }
    );
  }
  const before = await deps.store.getWorkspacePolicy(input.workspaceId);
  const saved = await deps.store.putWorkspacePolicy({
    workspaceId: input.workspaceId,
    params: input.overrides as Record<string, unknown>,
    updatedBy: input.actor.id,
    expectedVersion: input.expectedVersion,
  });
  await deps.store.appendEvent({
    type: "policy.evaluated",
    workspaceId: input.workspaceId,
    correlationId: newId(deps, "corr"),
    actor: input.actor,
    data: { kind: "workspace_policy_changed", fromVersion: before.version, toVersion: saved.version, keys: Object.keys(input.overrides as object).sort().slice(0, 20) },
  });
  return viewOf(saved);
}
