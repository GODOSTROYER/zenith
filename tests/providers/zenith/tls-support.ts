/** In-memory TLS contract double. It does not model issuance, admission or RBAC. */
import { K8sError } from "@/lib/providers/kubernetes/types";
import type { K8sObject, ObjectRef } from "@/lib/providers/zenith/k8s-port";
import type { TlsObjectClient } from "@/lib/providers/zenith/tls-client";

export class FakeTlsClient implements TlsObjectClient {
  store = new Map<string, K8sObject>();
  writes: { method: "apply" | "delete"; object: K8sObject | ObjectRef; dryRun: boolean }[] = [];
  error?: Error;
  beforeApply?: (object: K8sObject) => void;
  beforeDelete?: (ref: ObjectRef) => void;
  private sequence = 0;
  static key(object: ObjectRef) { return `${object.kind}/${object.namespace}/${object.name}`; }
  put(object: K8sObject) {
    const version = String(++this.sequence);
    this.store.set(FakeTlsClient.key({ ...object, ...object.metadata }), structuredClone({
      ...object, metadata: { uid: `uid-${version}`, resourceVersion: version, ...object.metadata },
    }));
  }
  async read(ref: ObjectRef) {
    if (this.error) throw this.error;
    return structuredClone(this.store.get(FakeTlsClient.key(ref))) as Record<string, unknown> | undefined;
  }
  async apply(object: K8sObject, live: Record<string, unknown> | undefined, dryRun: boolean) {
    this.beforeApply?.(object);
    const key = FakeTlsClient.key({ ...object, ...object.metadata });
    const current = this.store.get(key);
    if ((!live && current) || (live && current?.metadata.resourceVersion !== (live.metadata as K8sObject["metadata"]).resourceVersion)) {
      throw new K8sError("field_conflict", "TLS object changed.");
    }
    this.writes.push({ method: "apply", object: structuredClone(object), dryRun });
    if (!dryRun) this.put(object);
  }
  async delete(ref: ObjectRef, live: Record<string, unknown>, dryRun: boolean) {
    this.beforeDelete?.(ref);
    const key = FakeTlsClient.key(ref);
    const current = this.store.get(key);
    const metadata = live.metadata as K8sObject["metadata"];
    if (!current) throw new K8sError("not_found", "Absent.");
    if (current.metadata.uid !== metadata.uid || current.metadata.resourceVersion !== metadata.resourceVersion) throw new K8sError("field_conflict", "TLS object replaced.");
    this.writes.push({ method: "delete", object: ref, dryRun });
    if (!dryRun) this.store.delete(key);
  }
}
