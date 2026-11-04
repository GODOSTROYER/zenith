/**
 * Narrow operator adapter reusing Kubernetes discovery, raw JSON, authentication,
 * request timeouts and cancellation. The tenant toolkit cannot write Gateways.
 * Only TLS objects in the explicitly allowlisted platform namespace are exposed.
 * No credentials, Secret bodies or API error messages leave this adapter's caller.
 */
import { PatchStrategy } from "@kubernetes/client-node";
import type { KubernetesSession } from "@/lib/credentials/types";
import { createK8sClient, readObject } from "@/lib/providers/kubernetes/client";
import { sessionNamespaces } from "@/lib/providers/kubernetes/session";
import { K8sError } from "@/lib/providers/kubernetes/types";
import { dig, type K8sObject, type ObjectRef } from "./k8s-port";
import { CERTIFICATE_API_VERSION, GATEWAY_API_VERSION } from "./tls";

export interface TlsObjectClient {
  read(ref: ObjectRef): Promise<Record<string, unknown> | undefined>;
  /** Missing objects use atomic CREATE; existing objects use SSA with resourceVersion. */
  apply(object: K8sObject, live: Record<string, unknown> | undefined, dryRun: boolean): Promise<void>;
  /** UID and resourceVersion preconditions protect against replacement after the ownership read. */
  delete(ref: ObjectRef, live: Record<string, unknown>, dryRun: boolean): Promise<void>;
}

export function createTlsObjectClient(session: KubernetesSession, namespace: string, opts: { signal?: AbortSignal; requestTimeoutMs?: number } = {}): TlsObjectClient {
  // Require the explicit platform allowlist; the broader owned-namespace fallback is inappropriate here.
  if (!sessionNamespaces(session).includes(namespace)) throw new K8sError("namespace_forbidden", "TLS needs an operator session scoped to the gateway namespace.");
  const client = createK8sClient(session, opts);
  const guard = (ref: ObjectRef) => {
    const version = ref.kind === "Gateway" ? GATEWAY_API_VERSION : ref.kind === "Certificate" ? CERTIFICATE_API_VERSION : ref.kind === "Secret" ? "v1" : undefined;
    if (!version || ref.apiVersion !== version || ref.namespace !== namespace || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(ref.name)) {
      throw new K8sError("bad_input", "Only platform TLS object references in the gateway namespace are allowed.");
    }
    opts.signal?.throwIfAborted();
  };
  const objectOf = (ref: ObjectRef) => ({ apiVersion: ref.apiVersion, kind: ref.kind, metadata: { name: ref.name, namespace } });
  return {
    async read(ref) {
      guard(ref);
      const live = await readObject(client, ref);
      // Secret data is never needed by ownership checks and never returned from the port.
      return ref.kind === "Secret" && live ? { apiVersion: live.apiVersion, kind: live.kind, metadata: live.metadata } : live;
    },
    async apply(object, live, dryRun) {
      guard({ apiVersion: object.apiVersion, kind: object.kind, name: object.metadata.name, namespace: object.metadata.namespace });
      if (object.kind === "Secret") throw new K8sError("bad_input", "Only cert-manager writes TLS Secret values.");
      if (!live) {
        // SSA could adopt an object created between GET and PATCH. POST fails with 409 instead.
        await client.objects.create(object, undefined, dryRun ? "All" : undefined, "zenith");
      } else {
        const resourceVersion = dig(live, "metadata", "resourceVersion");
        if (typeof resourceVersion !== "string" || !resourceVersion) throw new K8sError("invalid_object", "Live TLS object has no resourceVersion; refusing an unguarded update.");
        await client.objects.patch({ ...object, metadata: { ...object.metadata, resourceVersion } }, undefined, dryRun ? "All" : undefined, "zenith", false, PatchStrategy.ServerSideApply);
      }
    },
    async delete(ref, live, dryRun) {
      guard(ref);
      const uid = dig(live, "metadata", "uid");
      const resourceVersion = dig(live, "metadata", "resourceVersion");
      if (typeof uid !== "string" || !uid || typeof resourceVersion !== "string" || !resourceVersion) throw new K8sError("invalid_object", "Live TLS object lacks deletion preconditions.");
      await client.objects.delete(objectOf(ref), undefined, dryRun ? "All" : undefined, undefined, undefined, "Background", { preconditions: { uid, resourceVersion } });
    },
  };
}
