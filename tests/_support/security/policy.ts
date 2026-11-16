/**
 * Policy input builders for the security suite (WS-SEC).
 *
 * Deliberately NOT imported from `tests/policy/support.ts`: that file belongs
 * to the policy workstream and may change shape; these tests must keep
 * attacking the PUBLIC contract (`PolicyInput` in `src/lib/policy/types.ts`) and
 * the real capability catalog, so the builder here derives `request` from the
 * catalog exactly as the broker will.
 */
import { CAPABILITIES, type CapabilityDef, type CapabilityName } from "@/lib/capabilities/catalog";
import { resolveWorkspacePolicy, type PlanFacts, type PolicyInput, type WorkspacePolicyOverrides } from "@/lib/policy";

export const POLICY_NOW = "2026-09-30T12:00:00.000Z";

type Patch = { [key: string]: unknown };
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Nested objects merge; arrays and scalars replace; `undefined` removes the key. */
export function patchOf<T>(base: T, patch?: Patch): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = patchOf(out[k], v as Patch);
    else out[k] = v;
  }
  return out as T;
}

export const allCapabilities = (): CapabilityDef[] => Object.values(CAPABILITIES) as CapabilityDef[];

export function requestOf(name: CapabilityName | string): PolicyInput["request"] {
  const def = (CAPABILITIES as Record<string, CapabilityDef>)[name];
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
 * An editor on a development environment at autonomy 4, human origin, acting on
 * a managed non-stateful resource, default workspace policy. `patch` overrides.
 */
export function policyInputFor(capability: CapabilityName | string, patch?: Patch, workspace?: WorkspacePolicyOverrides): PolicyInput {
  const base: PolicyInput = {
    version: 1,
    request: requestOf(capability),
    principal: { kind: "user", id: "usr_1", role: "editor" },
    environment: { id: "env_1", class: "development", autonomyLevel: 4, provider: "aws", region: "us-east-1" },
    resource: { address: "aws_ecs_service.web", kind: "service", stateful: false, ownership: "managed", publiclyExposed: false },
    workspacePolicy: resolveWorkspacePolicy(workspace),
    context: { now: POLICY_NOW, origin: "human" },
  };
  return patchOf(base, patch);
}

export function emptyPlanFacts(patch: Partial<PlanFacts> & { costDeltaUsdMonthly?: number; projectedMonthlyUsd?: number } = {}): NonNullable<PolicyInput["plan"]> {
  return {
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
    ...patch,
  };
}

export const PRINCIPAL_KINDS = ["user", "integration", "navigator", "system", "runner", "machine"] as const;
export const ROLES = ["viewer", "editor", "admin", "none"] as const;
export const ORIGINS = ["human", "agent", "navigator", "system", "reconciler"] as const;
export const ENV_CLASSES = ["sandbox", "development", "staging", "production"] as const;
export const AUTONOMY_LEVELS = [0, 1, 2, 3, 4, 5] as const;
