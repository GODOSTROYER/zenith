/**
 * Identity grants are data: validate them, then render exact namespaced RBAC.
 * Portable `read` means API `get`; data-plane verbs do not imply API rights.
 * Referenced objects need their explicit namespace/name, never a guessed name.
 */
import type { IdentityGrant } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { dnsLabel, isDnsLabel, objectName } from "../naming";
import { RBAC_TARGETS, RBAC_VERBS, isResourceName } from "../rbac";
import { primaryName } from "../target";
import { isSupportedKind, type K8sObject, type K8sRenderContext, type RenderResult } from "../types";
import { isRecord } from "../util";
import { ctxNamespace, metadata, renderError, specOf } from "./common";

export function identityGrants(node: ResourceNode): IdentityGrant[] {
  const raw = specOf(node).grants;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw renderError(`${node.address}: grants must be a list.`);
  const grants: IdentityGrant[] = [];
  for (const g of raw) {
    if (!isRecord(g) || typeof g.target !== "string" || !g.target || g.target.includes("*") || !Array.isArray(g.access) || g.access.length === 0 || !g.access.every((v) => typeof v === "string" && /^[a-z_]+$/.test(v))) {
      throw renderError(`${node.address}: each grant needs an exact target and explicit non-wildcard verbs.`);
    }
    grants.push({ target: g.target, access: [...new Set(g.access as string[])].sort(), via: [] });
  }
  return grants.sort((a, b) => a.target.localeCompare(b.target) || a.access.join().localeCompare(b.access.join()));
}

export const isKubernetesNode = (node: ResourceNode): boolean => node.provider === "kubernetes" || node.provider === "zenith";

// These verbs describe access to a running service, not its Kubernetes API object.
const DATA_VERBS = new Set(["connect", "read_credentials", "pull", "publish", "consume", "invoke", "write"]);

function targetLocation(target: ResourceNode, ctx: K8sRenderContext, kind: string): { namespace: string; name: string } | undefined {
  if (target.ownership !== "managed") {
    if (typeof target.externalRef !== "string") return undefined;
    const parts = target.externalRef.split("/");
    if (parts.length !== 2 || !isDnsLabel(parts[0]) || !isResourceName(parts[1])) throw renderError("A referenced RBAC target needs an explicit valid namespace/name.");
    return { namespace: parts[0], name: parts[1] };
  }
  // Managed names must match what the renderer actually creates.
  if (!isSupportedKind(kind)) return undefined;
  return { namespace: ctxNamespace(target, ctx), name: primaryName(kind, target, ctx.environmentId) };
}

export function renderIdentityRbac(node: ResourceNode, ctx: K8sRenderContext, grants: readonly IdentityGrant[]): RenderResult {
  const notes: string[] = [];
  const rules = new Map<string, Map<string, Record<string, unknown>>>();
  for (const grant of grants) {
    const target = ctx.node?.(grant.target);
    if (!target) {
      notes.push(`${node.address}: grant target ${grant.target} is missing from the graph; no permission rendered.`);
      continue;
    }
    if (!isKubernetesNode(target)) continue;
    const kind = target.nativeType.startsWith("k8s:") ? target.nativeType.slice(4) : "";
    const info = Object.prototype.hasOwnProperty.call(RBAC_TARGETS, kind) ? RBAC_TARGETS[kind] : undefined;
    if (!info) {
      notes.push(`${node.address}: grant target ${grant.target} has no supported namespaced RBAC object; no permission rendered.`);
      continue;
    }
    if (grant.access.some((v) => DATA_VERBS.has(v))) {
      notes.push(`${node.address}: grant on ${grant.target} uses data-plane verbs; no Kubernetes API permission rendered.`);
      continue;
    }
    const verbs = [...new Set(grant.access.map((v) => v === "read" ? "get" : v))].sort();
    if (!verbs.every((v) => RBAC_VERBS.has(v))) throw renderError(`${node.address}: grant has unsupported Kubernetes verbs; create and deletecollection cannot be restricted to an exact name.`);
    const location = targetLocation(target, ctx, kind);
    if (!location) {
      notes.push(`${node.address}: grant target ${grant.target} has no explicit or rendered object location; no permission rendered.`);
      continue;
    }
    const rule = { apiGroups: [info.group], resources: [info.resource], resourceNames: [location.name], verbs };
    const inNamespace = rules.get(location.namespace) ?? new Map<string, Record<string, unknown>>();
    inNamespace.set(JSON.stringify(rule), rule);
    rules.set(location.namespace, inNamespace);
    if (verbs.some((v) => v === "list" || v === "watch")) notes.push(`${node.address}: list/watch on ${grant.target} requires a metadata.name field selector matching its exact resourceName.`);
  }
  const objects: K8sObject[] = [];
  for (const [namespace, entries] of [...rules.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const name = dnsLabel(`rbac-${objectName(node)}`);
    objects.push({
      apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role",
      metadata: metadata(node, ctx, { name, namespace }),
      rules: [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, rule]) => rule),
    }, {
      apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding",
      metadata: metadata(node, ctx, { name, namespace }),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
      subjects: [{ kind: "ServiceAccount", name: objectName(node), namespace: ctxNamespace(node, ctx) }],
    });
  }
  return { objects, notes };
}
