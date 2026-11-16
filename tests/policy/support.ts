/**
 * Shared builders for the policy tests. Inputs are derived from the real
 * capability catalog so a scenario cannot drift from what the broker sends.
 */
import { CAPABILITIES, type CapabilityDef, type CapabilityName } from "@/lib/capabilities/catalog";
import { resolveWorkspacePolicy, type PlanFacts, type PolicyInput, type WorkspacePolicyOverrides } from "@/lib/policy";

/** A patch: nested objects merge, arrays and scalars replace, `undefined` removes the key. */
export type Patch = { [key: string]: unknown };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function merge<T>(base: T, patch: Patch | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key];
    else if (isPlainObject(value) && isPlainObject(out[key])) out[key] = merge(out[key], value as Patch);
    else out[key] = value;
  }
  return out as T;
}

export const NOW = "2026-09-30T12:00:00.000Z";

export function requestFor(name: CapabilityName): PolicyInput["request"] {
  const def: CapabilityDef = CAPABILITIES[name];
  return {
    capability: def.name,
    risk: def.risk,
    mutates: def.mutates,
    destructive: def.destructive ?? false,
    escapeHatch: def.escapeHatch ?? false,
    defaultAutonomy: def.defaultAutonomy,
    integrationScope: def.integrationScope,
    scope: { workspaceId: "ws_1", projectId: "prj_1", environmentId: "env_1", resourceId: "res_1" },
  };
}

/**
 * A policy input for `capability`: an editor on a development environment at
 * autonomy 4, acting on a managed, non-stateful resource, default workspace
 * policy, human origin. `patch` overrides any part of it.
 */
export function policyInput(capability: CapabilityName, patch?: Patch, workspace?: WorkspacePolicyOverrides): PolicyInput {
  const base: PolicyInput = {
    version: 1,
    request: requestFor(capability),
    principal: { kind: "user", id: "usr_1", role: "editor" },
    environment: { id: "env_1", class: "development", autonomyLevel: 4, provider: "aws", region: "us-east-1" },
    resource: { address: "aws_ecs_service.web", kind: "service", stateful: false, ownership: "managed", publiclyExposed: false },
    workspacePolicy: resolveWorkspacePolicy(workspace),
    context: { now: NOW, origin: "human" },
  };
  return merge(base, patch);
}

export function planFacts(patch?: Partial<PlanFacts> & { costDeltaUsdMonthly?: number; projectedMonthlyUsd?: number }): NonNullable<PolicyInput["plan"]> {
  const empty: NonNullable<PolicyInput["plan"]> = {
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
    unresolved: [],
  };
  return { ...empty, ...patch };
}

export const production = { environment: { class: "production", autonomyLevel: 5 } } as const;
