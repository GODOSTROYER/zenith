/**
 * The evaluation pipeline shared by `propose`, `check`, `authorizeRead`, the
 * approval service and `beginExecution`: ONE place that turns "this principal
 * wants this capability on this scope" into a policy decision, so the decision
 * an approver saw and the decision execution re-checks are built identically.
 *
 *   scope level ─▶ principal access (member? role? integration scopes)
 *     ─▶ scope chain resolved server-side (foreign id ≡ missing id)
 *     ─▶ environment autonomy ─▶ workspace policy ─▶ plan facts
 *     ─▶ PolicyInput built FROM THE CATALOG ─▶ OPA decision ─▶ broker guards
 *
 * Trust rules this file enforces:
 *  - Nothing in `request.input` is a policy fact. Plan facts and costs arrive
 *    only as `plan`/`cost` from Zenith's own execution side.
 *  - `request.*` fields are derived from the catalog, never from the client;
 *    risk may be raised by the caller, never lowered.
 *  - Policy origin comes from the principal's kind, not from a caller claim.
 *  - A policy engine that cannot load, or a workspace policy that does not
 *    validate, is `policy_unavailable`: refused, never allowed.
 *
 * Broker guards (`applyGuards`) only TIGHTEN: they turn an outcome into a
 * `deny` and never lift one. They cover what the Rego bundle cannot see:
 *  - `plan_required`: `infrastructure.apply`/`destroy` need the reviewed
 *    OpenTofu plan from the execution side, or there is nothing to approve.
 *  - `agent_autonomy_too_low`: at autonomy 0–1 agents observe and recommend;
 *    they cannot create executable proposals (ADR-0007).
 */
import { extractPlanFacts, resolveWorkspacePolicy, PolicyConfigError, type PolicyDecision, type PolicyInput, type EvaluatedPolicy } from "@/lib/policy";
import type { PolicyReason, Principal, Scope } from "@/lib/controlplane/types";
import type { NormalizedPlan } from "@/lib/tofu/types";
import { CAPABILITIES, type CapabilityDef, type CapabilityRisk } from "./catalog";
import { effectiveAutonomy, type EffectiveAutonomy } from "./autonomy";
import { BrokerError, notFound } from "./errors";
import type { BrokerDeps, ResolvedAccess, ResolvedScope } from "./ports";
import type { ConstraintValue, PlanFactsWithCost } from "./types";

const RISK_RANK: Readonly<Record<CapabilityRisk, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Risk may be raised, never lowered: the higher of the catalog floor and the caller's floor. */
export function raiseRisk(floor: CapabilityRisk, requested?: CapabilityRisk): CapabilityRisk {
  return requested && RISK_RANK[requested] > RISK_RANK[floor] ? requested : floor;
}

/* ------------------------------ scope-level check --------------------------- */

/**
 * The ids the capability's scope level demands. A missing one is a 400 about the
 * request's own shape (it reveals nothing about any tenant).
 */
export function assertScopeComplete(def: CapabilityDef, scope: Scope): void {
  const missing: string[] = [];
  if ((def.scopeLevel === "project") && !scope.projectId) missing.push("projectId");
  if ((def.scopeLevel === "environment" || def.scopeLevel === "resource") && !scope.environmentId) missing.push("environmentId");
  if (def.scopeLevel === "resource" && !scope.resourceId) missing.push("resourceId");
  if (missing.length > 0) {
    throw new BrokerError("scope_incomplete", `${def.name} acts on a ${def.scopeLevel}; the request must name ${missing.join(" and ")}.`, "Add the missing ids to scope.", { missing });
  }
}

/* ---------------------------------- facts ---------------------------------- */

/** Facts from the authoritative plan and cost numbers; `undefined` when there are none. */
export function buildPlanFacts(plan?: NormalizedPlan, cost?: { deltaUsdMonthly?: number; projectedUsdMonthly?: number }): PlanFactsWithCost | undefined {
  if (!plan && !cost) return undefined;
  const numbers: Partial<Pick<PlanFactsWithCost, "costDeltaUsdMonthly" | "projectedMonthlyUsd">> = {};
  if (cost?.deltaUsdMonthly !== undefined) {
    if (!Number.isFinite(cost.deltaUsdMonthly)) throw new BrokerError("invalid_request", "cost.deltaUsdMonthly must be a finite number.");
    numbers.costDeltaUsdMonthly = cost.deltaUsdMonthly;
  }
  if (cost?.projectedUsdMonthly !== undefined) {
    if (!Number.isFinite(cost.projectedUsdMonthly)) throw new BrokerError("invalid_request", "cost.projectedUsdMonthly must be a finite number.");
    numbers.projectedMonthlyUsd = cost.projectedUsdMonthly;
  }
  const base = plan
    ? extractPlanFacts(plan)
    : {
        create: 0,
        update: 0,
        delete: 0,
        replace: 0,
        destroysData: false,
        destroyedStatefulAddresses: [],
        regions: [],
        publicDatabases: [],
        openIngress: [],
        wildcardIam: [],
        identityChanges: [],
        firewallChanges: [],
        dnsChanges: [],
      };
  return { ...base, ...numbers };
}

/* ---------------------------------- origin ---------------------------------- */

/** Policy origin follows the principal's kind; a caller cannot claim a friendlier one. */
export function originFor(principal: Principal, claimed?: "reconciler"): PolicyInput["context"]["origin"] {
  switch (principal.kind) {
    case "user":
      return "human";
    case "integration":
      return "agent";
    case "navigator":
      return "navigator";
    case "system":
      return claimed === "reconciler" ? "reconciler" : "system";
    default:
      return "system";
  }
}

/* --------------------------------- evaluate --------------------------------- */

export interface EvaluationRequest {
  def: CapabilityDef;
  /** the scope as the request named it */
  scope: Scope;
  principal: Principal;
  risk: CapabilityRisk;
  requestedDurationSec?: number;
  constraints?: Record<string, ConstraintValue>;
  /** authoritative facts (plan + cost), when the execution side supplied them */
  plan?: PlanFactsWithCost;
  /** digest of the reviewed OpenTofu plan those facts came from */
  planDigest?: string;
  origin?: "reconciler";
}

export interface Evaluation {
  def: CapabilityDef;
  access: ResolvedAccess;
  resolved: ResolvedScope;
  autonomy?: EffectiveAutonomy;
  input: PolicyInput;
  evaluated: EvaluatedPolicy;
  /** the decision after broker guards */
  decision: PolicyDecision;
  risk: CapabilityRisk;
}

const guardReason = (code: string, message: string): PolicyReason => ({ code, message, rule: `zenith.broker.${code}` });

export function applyGuards(args: {
  def: CapabilityDef;
  principal: Principal;
  autonomyLevel?: number;
  plan?: PlanFactsWithCost;
  planDigest?: string;
}): PolicyReason[] {
  const reasons: PolicyReason[] = [];
  if ((args.def.name === "infrastructure.apply" || args.def.name === "infrastructure.destroy") && (!args.plan || !args.planDigest)) {
    reasons.push(
      guardReason("plan_required", `${args.def.name} must be proposed with the reviewed OpenTofu plan produced by Zenith's execution side; there is nothing exact to approve without it.`)
    );
  }
  if (
    args.def.mutates &&
    (args.principal.kind === "integration" || args.principal.kind === "navigator") &&
    args.autonomyLevel !== undefined &&
    args.autonomyLevel < 2
  ) {
    reasons.push(
      guardReason(
        "agent_autonomy_too_low",
        `At autonomy level ${args.autonomyLevel} agents observe and recommend; they cannot create executable proposals. A workspace admin can raise the environment to level 2 (plan) or above.`
      )
    );
  }
  return reasons;
}

/** Everything the decision depends on, from current state. Never persists anything. */
export async function evaluate(deps: BrokerDeps, req: EvaluationRequest): Promise<Evaluation> {
  const { def, principal } = req;
  const workspaceId = req.scope.workspaceId;

  assertScopeComplete(def, req.scope);

  const access = await deps.roles.resolve(principal, workspaceId);
  // A non-member (of any acting kind) gets the same answer as a foreign id;
  // `system` principals are not human members and are governed by policy.
  if (access.role === "none" && principal.kind !== "system") throw notFound();

  const resolved = await deps.scopes.resolve(req.scope);
  if (!resolved) throw notFound();
  if (access.allowedProjectIds && (!resolved.scope.projectId || !access.allowedProjectIds.includes(resolved.scope.projectId))) throw notFound();
  if (access.allowedEnvironmentIds && resolved.scope.environmentId && !access.allowedEnvironmentIds.includes(resolved.scope.environmentId)) throw notFound();

  let autonomy: EffectiveAutonomy | undefined;
  if (resolved.environment) {
    autonomy = effectiveAutonomy(await deps.store.getEnvironmentSettings(workspaceId, resolved.environment.id), resolved.environment.class);
  }

  const policyRow = await deps.store.getWorkspacePolicy(workspaceId);
  let workspacePolicy;
  try {
    workspacePolicy = resolveWorkspacePolicy(policyRow.params);
  } catch (error) {
    if (error instanceof PolicyConfigError) {
      throw new BrokerError("policy_unavailable", "This workspace's stored policy is invalid, so every request is refused until an admin repairs it.", "Open workspace policy and save a valid configuration.");
    }
    throw error;
  }

  const input: PolicyInput = {
    version: 1,
    request: {
      capability: def.name,
      risk: req.risk,
      mutates: def.mutates,
      destructive: def.destructive ?? false,
      escapeHatch: def.escapeHatch ?? false,
      defaultAutonomy: def.defaultAutonomy,
      integrationScope: def.integrationScope,
      scope: { ...resolved.scope },
      ...(req.requestedDurationSec !== undefined ? { requestedDurationSec: req.requestedDurationSec } : {}),
      ...(req.constraints ? { constraints: { ...req.constraints } } : {}),
    },
    principal: {
      kind: principal.kind,
      id: principal.id,
      role: access.role,
      ...(principal.kind === "integration" ? { integrationScopes: [...(access.integrationScopes ?? [])] } : {}),
    },
    ...(resolved.environment && autonomy
      ? {
          environment: {
            id: resolved.environment.id,
            class: resolved.environment.class,
            autonomyLevel: autonomy.level,
            provider: resolved.environment.provider,
            region: resolved.environment.region,
          },
        }
      : {}),
    ...(resolved.resource ? { resource: resolved.resource } : {}),
    ...(req.plan ? { plan: req.plan } : {}),
    workspacePolicy,
    context: { now: deps.clock.now().toISOString(), origin: originFor(principal, req.origin) },
  };

  let engine;
  try {
    engine = await deps.policy();
  } catch {
    // "Deny everything": nothing is persisted and nothing executes.
    throw new BrokerError("policy_unavailable", "The policy engine could not be loaded, so every request is refused.", "An operator must repair the policy bundle (policy/dist).");
  }
  const evaluated = await engine.evaluate(input);

  const guard = applyGuards({ def, principal, autonomyLevel: autonomy?.level, plan: req.plan, planDigest: req.planDigest });
  const decision: PolicyDecision = guard.length > 0 ? { outcome: "deny", reasons: [...guard, ...evaluated.decision.reasons] } : evaluated.decision;

  return { def, access, resolved, autonomy, input, evaluated, decision, risk: req.risk };
}

export const catalogDef = (capability: string): CapabilityDef => (CAPABILITIES as Record<string, CapabilityDef>)[capability];
