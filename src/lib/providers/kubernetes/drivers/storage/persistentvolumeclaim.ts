/**
 * `k8s:PersistentVolumeClaim` — volume.
 *
 * A PVC is never pruned automatically (it holds data); `verify` also requires
 * it to be Bound, because a Pending claim with no provisioner looks configured
 * and serves nothing.
 */
import { volumeStorageGi } from "../../renderers/identity";
import { dig, isRecord } from "../../util";
import { compact, safeExpected, sortedStrings } from "../attrs";
import { pvcRuntime } from "../runtime";
import { makeKubernetesDriver, type KindDef } from "../shared";

export const persistentVolumeClaimDef: KindDef = {
  suffix: "persistentvolumeclaim",
  nativeType: "k8s:PersistentVolumeClaim",
  kind: "PersistentVolumeClaim",
  portable: ["volume"],
  attributes: (live) => ({
    storage: dig(live, "spec", "resources", "requests", "storage"),
    storageClassName: dig(live, "spec", "storageClassName") ?? null,
    accessModes: sortedStrings(dig(live, "spec", "accessModes")),
  }),
  expected: safeExpected((node) => {
    const s = isRecord(node.spec) ? node.spec : {};
    return {
      storage: `${volumeStorageGi(node)}Gi`,
      accessModes: sortedStrings(Array.isArray(s.accessModes) ? s.accessModes : ["ReadWriteOnce"]),
      ...(typeof s.storageClass === "string" && s.storageClass !== "" ? { storageClassName: s.storageClass } : {}),
    };
  }),
  summary: (live) => compact({ storage: dig(live, "spec", "resources", "requests", "storage"), phase: dig(live, "status", "phase") }),
  runtime: pvcRuntime,
  extraChecks: (_node, _obs, runtime) => [
    {
      id: "bound",
      description: "the claim is bound to a volume",
      passed: runtime === undefined ? "unknown" : (runtime.counts.bound ?? 0) === 1,
    },
  ],
};

export const persistentVolumeClaimDriver = makeKubernetesDriver(persistentVolumeClaimDef);
