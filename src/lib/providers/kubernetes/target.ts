/**
 * Where a node's primary object lives: kind, namespace and name, derived from
 * the node alone (drivers have no graph), or parsed from a stored externalId.
 *
 * externalId format (stable, human-readable):
 *   namespaced kinds   `<namespace>/<name>`
 *   Namespace          `<name>`
 * Untrusted input never picks a namespace or name: operations derive both from
 * the node; `externalId` comes from Zenith's own state.
 */
import type { ResourceNode } from "@/lib/resources/types";
import { K8sError, KIND_INFO, type ObjectRef, type SupportedKind } from "./types";
import { isDnsLabel, objectName, secretObjectName } from "./naming";
import { namespaceOf } from "./renderers/common";
import { certificateObjectName, dnsObjectName, firewallObjectName } from "./renderers/network";
import { isRecord } from "./util";

/** The object name each native kind's primary object is rendered under. Mirrors the renderers. */
export function primaryName(kind: SupportedKind, node: ResourceNode, environmentId: string): string {
  const spec = isRecord(node.spec) ? node.spec : {};
  switch (kind) {
    case "Namespace":
      return namespaceOf(node, environmentId);
    case "NetworkPolicy":
      return firewallObjectName(node);
    case "Certificate":
      return certificateObjectName(typeof spec.domain === "string" ? spec.domain : node.address);
    case "DNSEndpoint":
      return dnsObjectName(typeof spec.name === "string" ? spec.name : node.address);
    case "Secret":
      return typeof spec.secretRef === "string" ? secretObjectName(spec.secretRef) : objectName(node);
    default:
      return objectName(node);
  }
}

export function externalIdFor(ref: Pick<ObjectRef, "namespace" | "name">): string {
  return ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
}

export function parseExternalId(kind: SupportedKind, externalId: string): { namespace?: string; name: string } {
  const parts = externalId.split("/");
  const namespaced = KIND_INFO[kind].namespaced;
  if (namespaced) {
    if (parts.length !== 2 || !isDnsLabel(parts[0]) || !isDnsLabel(parts[1])) throw new K8sError("bad_input", "externalId must be <namespace>/<name>.");
    return { namespace: parts[0], name: parts[1] };
  }
  if (parts.length !== 1 || !isDnsLabel(parts[0])) throw new K8sError("bad_input", "externalId must be a name.");
  return { name: parts[0] };
}

export function targetFor(kind: SupportedKind, node: ResourceNode, environmentId: string, externalId?: string): ObjectRef {
  const info = KIND_INFO[kind];
  if (externalId) {
    const p = parseExternalId(kind, externalId);
    return { apiVersion: info.apiVersion, kind, ...(p.namespace ? { namespace: p.namespace } : {}), name: p.name };
  }
  return {
    apiVersion: info.apiVersion,
    kind,
    ...(info.namespaced ? { namespace: namespaceOf(node, environmentId) } : {}),
    name: primaryName(kind, node, environmentId),
  };
}
