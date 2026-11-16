/**
 * identity → ServiceAccount + exact namespaced RBAC and cloud annotations;
 * secret → Secret (metadata only); volume → PVC.
 *
 * Secret: the rendered object has NO `data` and never will. It carries the
 * reference in `zenith.dev/secret-ref`; the execution worker resolves that
 * reference through an injected `resolveSecret(ref)` at apply time and merges
 * the value into the request body in memory only (`apply.ts`). This file never
 * sees a value.
 *
 * Tokens default off; rendered RBAC opts the identity and its workload into a
 * bound API token. Cloud annotation values come only from resolved published
 * attributes. Missing counterparts render no cloud annotation and emit notes.
 */
import type { SecretSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { ANNOTATION, LABEL, type K8sObject, type K8sRenderContext, type RenderResult } from "../types";
import { looksLikeSecretRef, objectName, secretObjectName } from "../naming";
import { isRecord } from "../util";
import { ctxNamespace, metadata, renderError, specOf } from "./common";
import { identityGrants, renderIdentityRbac } from "./identity-grants";
import { cloudIdentity } from "./cloud-identity";

export function identityAccess(node: ResourceNode, ctx: K8sRenderContext) {
  const grants = identityGrants(node);
  const rbac = renderIdentityRbac(node, ctx, grants);
  const cloud = cloudIdentity(node, ctx, grants);
  return { objects: rbac.objects, annotations: cloud.annotations, podLabels: cloud.podLabels,
    automount: ctx.automountServiceAccountToken === true || rbac.objects.length > 0,
    notes: [...rbac.notes, ...cloud.notes] };
}

export function renderIdentity(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const access = identityAccess(node, ctx);
  const sa: K8sObject = {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: metadata(node, ctx, { name: objectName(node), namespace: ctxNamespace(node, ctx), labels: { [LABEL.name]: objectName(node) }, annotations: access.annotations }),
    automountServiceAccountToken: access.automount,
  };
  return { objects: [sa, ...access.objects], notes: access.notes };
}

export function renderSecret(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const spec = specOf(node) as unknown as Partial<SecretSpec>;
  if (typeof spec.secretRef !== "string" || !looksLikeSecretRef(spec.secretRef)) {
    throw renderError(`${node.address}: spec.secretRef must be a reference (scheme:path), never a value.`);
  }
  const secret: K8sObject = {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: metadata(node, ctx, {
      name: secretObjectName(spec.secretRef),
      namespace: ctxNamespace(node, ctx),
      annotations: { [ANNOTATION.secretRef]: spec.secretRef },
    }),
  };
  return {
    objects: [secret],
    notes: [`${node.address}: the Secret is rendered without data; its value is resolved from ${spec.store === "provider_secret_manager" ? "the provider secret manager" : "the Zenith vault"} at apply time, in memory only.`],
  };
}

const VOLUME_SIZES: Record<string, number> = { nano: 1, small: 5, standard: 20, performance: 100 };

/** Read VolumeSpec defensively, retaining the legacy size-tier fallback for hand-built nodes. */
export function volumeStorageGi(node: ResourceNode): number {
  const s = specOf(node);
  if (s.sizeGb !== undefined) {
    if (typeof s.sizeGb !== "number" || !Number.isInteger(s.sizeGb) || s.sizeGb < 1 || s.sizeGb > 16384) throw renderError(`${node.address}: spec.sizeGb must be an integer between 1 and 16384.`);
    return s.sizeGb;
  }
  if (typeof s.size === "string" && VOLUME_SIZES[s.size] !== undefined) return VOLUME_SIZES[s.size];
  throw renderError(`${node.address}: a volume needs spec.sizeGb or a known spec.size (${Object.keys(VOLUME_SIZES).join(", ")}).`);
}

export function renderVolume(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const s = specOf(node);
  const storageGi = volumeStorageGi(node);
  if (s.storageClass !== undefined && typeof s.storageClass !== "string") throw renderError(`${node.address}: spec.storageClass must be a string.`);
  const modes = isRecord(s) && Array.isArray(s.accessModes) ? s.accessModes : ["ReadWriteOnce"];
  const allowed = new Set(["ReadWriteOnce", "ReadOnlyMany", "ReadWriteMany", "ReadWriteOncePod"]);
  if (!modes.every((m) => typeof m === "string" && allowed.has(m))) throw renderError(`${node.address}: spec.accessModes contains an unknown access mode.`);
  const pvc: K8sObject = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: metadata(node, ctx, { name: objectName(node), namespace: ctxNamespace(node, ctx), labels: { [LABEL.name]: objectName(node) } }),
    spec: {
      accessModes: modes,
      resources: { requests: { storage: `${storageGi}Gi` } },
      ...(typeof s.storageClass === "string" && s.storageClass !== "" ? { storageClassName: s.storageClass } : {}),
    },
  };
  return { objects: [pvc], notes: [`${node.address}: a PersistentVolumeClaim is never pruned automatically; removing the node leaves the data in place.`] };
}
