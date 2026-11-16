/**
 * Tag conversion and Zenith tag matching for AWS drivers.
 *
 * Every object Zenith creates carries `ctx.tags` (zenith:workspace,
 * zenith:environment, zenith:managed, …) plus `zenith:resource` = the node
 * address. Observation finds objects by those tags, never by name alone
 * (DRIVER-CONVENTIONS), so the tag keys live in one place.
 *
 * `zenith:env-class` (sandbox | staging | production) is an optional tag the
 * orchestrator puts in `ctx.tags`; drivers use it only to choose protective
 * defaults (ALB deletion protection). An absent tag means "not production".
 */

import { tfLiteral } from "./names";

export const TAG_WORKSPACE = "zenith:workspace";
export const TAG_ENVIRONMENT = "zenith:environment";
export const TAG_RESOURCE = "zenith:resource";
export const TAG_MANAGED = "zenith:managed";
export const TAG_ENV_CLASS = "zenith:env-class";

export interface AwsTag {
  Key?: string;
  Value?: string;
}

/** AWS tag keys and values: ≤ 128 / ≤ 256 characters. Longer values are cut, not rejected. */
const MAX_KEY = 128;
const MAX_VALUE = 256;

function sortedEntries(tags: Record<string, string>): [string, string][] {
  return Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `{ k: v }` → `[{ Key, Value }]`, sorted by key (deterministic request bodies). */
export function toAwsTagList(tags: Record<string, string>): { Key: string; Value: string }[] {
  return sortedEntries(tags).map(([k, v]) => ({ Key: k.slice(0, MAX_KEY), Value: String(v).slice(0, MAX_VALUE) }));
}

/** `[{ Key, Value }]` (EC2 / ELBv2 / ACM / Route 53 shape) → `{ k: v }`. Entries without a key are dropped. */
export function fromAwsTagList(list: AwsTag[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of list ?? []) if (typeof t.Key === "string") out[t.Key] = t.Value ?? "";
  return Object.fromEntries(sortedEntries(out));
}

/**
 * The tags for a tofu resource owned by `node`: `ctx.tags` plus
 * `zenith:resource` = node address, plus `Name` when given. Keys are sorted so
 * compiled JSON is stable.
 */
export function resourceTags(ctxTags: Record<string, string>, address: string, name?: string): Record<string, string> {
  const tags: Record<string, string> = { ...ctxTags, [TAG_RESOURCE]: address };
  if (name !== undefined) tags.Name = name;
  // Values are data: escape interpolation so a hostile address or tag can never run as an expression.
  return safeTags(Object.fromEntries(sortedEntries(tags)));
}

/** Escape raw tag keys and values exactly once when writing a tofu body. */
export function safeTags(tags: Record<string, string>): Record<string, string> {
  return Object.fromEntries(sortedEntries(tags).map(([k, v]) => [tfLiteral(k), tfLiteral(String(v))]));
}

export function isProductionEnvironment(ctxTags: Record<string, string>): boolean {
  return ctxTags[TAG_ENV_CLASS] === "production";
}

/** The pieces of a DriverContext that tag matching needs. */
export interface TagScope {
  environmentId: string;
  workspaceId: string;
  tags: Record<string, string>;
}

/** The environment and workspace tag values objects of THIS context must carry. */
export function scopeTagValues(scope: TagScope): { environment: string; workspace: string } {
  return { environment: scope.tags[TAG_ENVIRONMENT] ?? scope.environmentId, workspace: scope.tags[TAG_WORKSPACE] ?? scope.workspaceId };
}

/** True when `tags` say this object belongs to this workspace + environment and is Zenith-managed. */
export function isZenithTagged(tags: Record<string, string>, scope: TagScope): boolean {
  const want = scopeTagValues(scope);
  return tags[TAG_MANAGED] === "true" && tags[TAG_ENVIRONMENT] === want.environment && tags[TAG_WORKSPACE] === want.workspace;
}

/** True when `tags` identify exactly the node at `address` in this environment. */
export function matchesNodeTags(tags: Record<string, string>, scope: TagScope, address: string): boolean {
  const want = scopeTagValues(scope);
  return tags[TAG_RESOURCE] === address && tags[TAG_ENVIRONMENT] === want.environment && tags[TAG_WORKSPACE] === want.workspace;
}

/** EC2-style `Filters` selecting the node's objects by tag: workspace, environment, resource. */
export function ec2TagFilters(scope: TagScope, address: string): { Name: string; Values: string[] }[] {
  const want = scopeTagValues(scope);
  return [
    { Name: `tag:${TAG_ENVIRONMENT}`, Values: [want.environment] },
    { Name: `tag:${TAG_RESOURCE}`, Values: [address] },
    { Name: `tag:${TAG_WORKSPACE}`, Values: [want.workspace] },
  ];
}

/** True when the tags say Zenith created the object (any workspace/environment): what discovery marks `zenithTagged`. */
export function hasZenithManagedTag(tags: Record<string, string>): boolean {
  return tags[TAG_MANAGED] === "true";
}
