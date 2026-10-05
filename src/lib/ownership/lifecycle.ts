/**
 * `lifecycle.ignore_changes` generation: fields the IaC does not own are left
 * alone by tofu, so an autoscaler's (or a release's) writes are never reverted
 * and never show up as plan updates.
 */
import { normalizePath } from "./paths";
import { defaultFieldOwnershipRegistry, type FieldOwnershipRegistry } from "./registry";
import type { OwnershipFacts, OwnershipTransfer } from "./types";

export interface IgnoreChangesInput {
  /** tofu type (`aws_ecs_service`) or Zenith native type */
  resourceType: string;
  address?: string;
  facts?: OwnershipFacts;
  transfers?: readonly OwnershipTransfer[];
  now?: Date;
}

/** Tofu attribute paths IaC must ignore for this resource: sorted, de-duplicated. */
export function ignoreChangesFor(input: IgnoreChangesInput, registry: FieldOwnershipRegistry = defaultFieldOwnershipRegistry): string[] {
  const out = new Set<string>();
  for (const rule of registry.rulesForType(input.resourceType)) {
    for (const path of rule.ignorePaths ?? []) {
      const r = registry.resolve(
        { resourceType: input.resourceType, path, ...(input.address ? { address: input.address } : {}), ...(input.facts ? { facts: input.facts } : {}) },
        { ...(input.transfers ? { transfers: input.transfers } : {}), ...(input.now ? { now: input.now } : {}) }
      );
      if (r.owner !== "iac") out.add(path);
    }
  }
  return [...out].sort();
}

/** `{ ignore_changes }` ready to spread into a tf.json resource body, or `undefined` when nothing is delegated. */
export function lifecycleIgnoreChanges(input: IgnoreChangesInput, registry?: FieldOwnershipRegistry): { ignore_changes: string[] } | undefined {
  const paths = ignoreChangesFor(input, registry);
  return paths.length > 0 ? { ignore_changes: paths } : undefined;
}

/** Union of generated paths and a driver's own, so a driver can adopt the registry without losing paths it already emits. */
export function mergeIgnoreChanges(existing: readonly string[], generated: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const p of [...existing, ...generated]) if (!seen.has(normalizePath(p))) seen.set(normalizePath(p), p);
  return [...seen.values()].sort();
}
