/**
 * Per-environment autonomy, 0–5 (ADR-0007), and its mapping onto the
 * Navigator's install-wide dial.
 *
 * What a level means to THIS broker (the policy bundle reads `autonomyLevel`
 * and the catalog's `defaultAutonomy`; the broker adds the agent floor):
 *
 *   0 observe    read everything; nothing executes; agents cannot propose changes
 *   1 recommend  as 0; agents recommend in prose but still cannot create proposals
 *   2 plan       agents may create exact proposals; EVERY mutation needs a human approval
 *   3 safe       low-risk mutations (catalog `defaultAutonomy` ≤ 3) execute without approval
 *   4 bounded    SRE operations (restart, scale, deploy, rollback, migrate…) execute under policy
 *   5 broad      high-risk changes execute unattended within workspace policy limits
 *
 * Level 5 is still bounded: `defaultAutonomy: 6` capabilities (destroy, delete,
 * restore, identity changes, escape hatches) never execute without approval,
 * and policy deny/approval rules apply at every level.
 *
 * DEFAULTS when an environment has no autonomy setting (never configured):
 *   production 2 · staging 3 · development 3 · sandbox 4.
 * "Never configured" is `EnvironmentSettings.isDefault`; a store's placeholder
 * value is never treated as a decision. Only a human admin can change a level
 * (`setEnvironmentAutonomy`), so an agent cannot raise its own autonomy.
 */
import type { AutonomyLevel as NavigatorAutonomy } from "@/lib/domain/types";
import type { AutonomyLevel, EnvironmentClass } from "@/lib/policy";
import { BrokerError, notFound } from "./errors";
import { memberAccess, newId, requireHumanSession } from "./internal";
import { ROLE_RANK, type BrokerDeps, type EnvironmentSettings } from "./ports";
import type { BrowserSessionProof } from "./types";
import type { Principal } from "@/lib/controlplane/types";

export type { AutonomyLevel } from "@/lib/policy";

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [0, 1, 2, 3, 4, 5];

export const DEFAULT_AUTONOMY_BY_CLASS: Readonly<Record<EnvironmentClass, AutonomyLevel>> = {
  production: 2,
  staging: 3,
  development: 3,
  sandbox: 4,
};

export const defaultAutonomyFor = (envClass: EnvironmentClass): AutonomyLevel => DEFAULT_AUTONOMY_BY_CLASS[envClass];

export const isAutonomyLevel = (value: unknown): value is AutonomyLevel =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 5;

/* --------------------------- Navigator enum mapping ------------------------- */

const NAVIGATOR_TO_LEVEL: Readonly<Record<NavigatorAutonomy, AutonomyLevel>> = {
  observe: 0,
  plan: 1,
  approve: 2,
  bounded: 3,
  autonomous: 5,
};

/** observe→0, plan→1, approve→2, bounded→3, autonomous→5. */
export const levelFromNavigator = (navigator: NavigatorAutonomy): AutonomyLevel => NAVIGATOR_TO_LEVEL[navigator];

/** The inverse. Levels 3 and 4 both read as "bounded"; 5 as "autonomous". */
export function navigatorFromLevel(level: AutonomyLevel): NavigatorAutonomy {
  switch (level) {
    case 0:
      return "observe";
    case 1:
      return "plan";
    case 2:
      return "approve";
    case 3:
    case 4:
      return "bounded";
    case 5:
      return "autonomous";
  }
}

/* -------------------------------- description ------------------------------ */

export interface AutonomyDescription {
  level: AutonomyLevel;
  name: string;
  summary: string;
  /** what executes without a human approval at this level */
  unattended: string;
  navigator: NavigatorAutonomy;
}

const DESCRIPTIONS: Readonly<Record<AutonomyLevel, Omit<AutonomyDescription, "level" | "navigator">>> = {
  0: {
    name: "Observe",
    summary: "Read-only. Agents can observe and explain; nothing changes.",
    unattended: "Nothing. Reads are always allowed for members; every change needs a person.",
  },
  1: {
    name: "Recommend",
    summary: "Agents recommend changes in prose but cannot create proposals.",
    unattended: "Nothing.",
  },
  2: {
    name: "Plan",
    summary: "Agents can propose exact changes; every change waits for a human approval.",
    unattended: "Nothing. Every change is an exact, digest-bound proposal a person approves.",
  },
  3: {
    name: "Safe execution",
    summary: "Low-risk changes run automatically under policy; the rest wait for approval.",
    unattended: "Low-risk changes such as restarting or scaling a service and taking a database snapshot.",
  },
  4: {
    name: "Bounded operations",
    summary: "Routine SRE operations run automatically under policy.",
    unattended: "Deploy, roll back, drift repair, migrations and function invocation, plus everything from level 3.",
  },
  5: {
    name: "Broad autonomy",
    summary: "High-risk changes run automatically within workspace policy limits.",
    unattended:
      "Infrastructure apply, firewall, DNS and secret changes, plus everything from level 4. Destroy, delete, restore, identity changes and escape hatches still need approval.",
  },
};

export function describeAutonomy(level: AutonomyLevel): AutonomyDescription {
  return { level, navigator: navigatorFromLevel(level), ...DESCRIPTIONS[level] };
}

/* ----------------------------- effective autonomy --------------------------- */

export interface EffectiveAutonomy {
  level: AutonomyLevel;
  /** true when the environment was never configured and the class default applies */
  defaulted: boolean;
  version: number;
  updatedBy?: string;
  updatedAt?: string;
}

/** The autonomy in force for an environment: its setting, or the class default when never set. */
export function effectiveAutonomy(settings: EnvironmentSettings, envClass: EnvironmentClass): EffectiveAutonomy {
  return settings.isDefault
    ? { level: defaultAutonomyFor(envClass), defaulted: true, version: 0 }
    : { level: settings.autonomyLevel, defaulted: false, version: settings.version, updatedBy: settings.updatedBy, updatedAt: settings.updatedAt };
}

/* --------------------------------- get / set ------------------------------- */

export interface AutonomyView extends AutonomyDescription {
  workspaceId: string;
  environmentId: string;
  environmentClass: EnvironmentClass;
  defaulted: boolean;
  defaultForClass: AutonomyLevel;
  version: number;
  updatedBy?: string;
  updatedAt?: string;
}

async function resolveEnvironment(deps: BrokerDeps, workspaceId: string, environmentId: string, access: { allowedProjectIds?: string[]; allowedEnvironmentIds?: string[] }) {
  const resolved = await deps.scopes.resolve({ workspaceId, environmentId });
  if (!resolved?.environment) throw notFound();
  if (access.allowedEnvironmentIds && !access.allowedEnvironmentIds.includes(environmentId)) throw notFound();
  if (access.allowedProjectIds && resolved.scope.projectId && !access.allowedProjectIds.includes(resolved.scope.projectId)) throw notFound();
  return { scope: resolved.scope, environment: resolved.environment };
}

/** Any member may read an environment's autonomy. */
export async function getEnvironmentAutonomy(
  deps: BrokerDeps,
  input: { workspaceId: string; environmentId: string; principal: Principal }
): Promise<AutonomyView> {
  const access = await memberAccess(deps, input.principal, input.workspaceId);
  const { environment } = await resolveEnvironment(deps, input.workspaceId, input.environmentId, access);
  const settings = await deps.store.getEnvironmentSettings(input.workspaceId, input.environmentId);
  const effective = effectiveAutonomy(settings, environment.class);
  return {
    ...describeAutonomy(effective.level),
    workspaceId: input.workspaceId,
    environmentId: input.environmentId,
    environmentClass: environment.class,
    defaulted: effective.defaulted,
    defaultForClass: defaultAutonomyFor(environment.class),
    version: effective.version,
    updatedBy: effective.updatedBy,
    updatedAt: effective.updatedAt,
  };
}

/**
 * Set an environment's autonomy. Admin only, human only, browser session only:
 * an agent that could raise its own autonomy would make every other gate
 * decorative.
 */
export async function setEnvironmentAutonomy(
  deps: BrokerDeps,
  input: {
    workspaceId: string;
    environmentId: string;
    level: unknown;
    actor: Principal;
    session: BrowserSessionProof;
    expectedVersion?: number;
  }
): Promise<AutonomyView> {
  if (!isAutonomyLevel(input.level)) {
    throw new BrokerError("invalid_request", "Autonomy level must be an integer from 0 to 5.", "Use 0 (observe) through 5 (broad autonomy).");
  }
  requireHumanSession(input.actor, input.session, "change autonomy");
  const access = await memberAccess(deps, input.actor, input.workspaceId);
  const { scope, environment } = await resolveEnvironment(deps, input.workspaceId, input.environmentId, access);
  if (ROLE_RANK[access.role] < ROLE_RANK.admin) {
    throw new BrokerError("admin_required", `Changing autonomy needs the admin role and you are ${access.role} in this workspace.`, "Ask a workspace admin to change it.");
  }
  const before = await deps.store.getEnvironmentSettings(input.workspaceId, input.environmentId);
  const previous = effectiveAutonomy(before, environment.class).level;
  await deps.store.putEnvironmentAutonomy({
    workspaceId: input.workspaceId,
    environmentId: input.environmentId,
    autonomyLevel: input.level,
    updatedBy: input.actor.id,
    expectedVersion: input.expectedVersion,
  });
  await deps.store.appendEvent({
    type: "policy.evaluated",
    workspaceId: input.workspaceId,
    projectId: scope.projectId,
    environmentId: input.environmentId,
    correlationId: newId(deps, "corr"),
    actor: input.actor,
    data: { kind: "autonomy_changed", from: previous, to: input.level, environmentClass: environment.class },
  });
  return getEnvironmentAutonomy(deps, { workspaceId: input.workspaceId, environmentId: input.environmentId, principal: input.actor });
}
