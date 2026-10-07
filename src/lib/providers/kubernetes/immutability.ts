/**
 * Fields Kubernetes will not let an existing object change. Applying a change
 * to one fails late, at the API server, possibly after earlier objects in the
 * batch were already applied. This finds the change first so the whole batch is
 * refused before anything is written (apply preflight).
 *
 * Only StatefulSet is checked: its persistent claims make a half-applied batch
 * expensive, and its immutable set is the one users hit (volumeClaimTemplates,
 * selector, serviceName, podManagementPolicy). Returns field paths and names,
 * never values.
 */
import type { K8sObject } from "./types";
import { deepEqual, dig, isRecord, sortedUnique } from "./util";

interface Claim {
  name: string;
  storage: unknown;
  storageClassName: unknown;
  accessModes: string[];
}

function claimsOf(templates: unknown): Map<string, Claim> {
  const out = new Map<string, Claim>();
  if (!Array.isArray(templates)) return out;
  for (const t of templates) {
    const name = dig(t, "metadata", "name");
    if (typeof name !== "string") continue;
    const modes = dig(t, "spec", "accessModes");
    out.set(name, {
      name,
      storage: dig(t, "spec", "resources", "requests", "storage"),
      storageClassName: dig(t, "spec", "storageClassName"),
      accessModes: sortedUnique(Array.isArray(modes) ? modes.filter((m): m is string => typeof m === "string") : []),
    });
  }
  return out;
}

export function immutableViolations(live: Record<string, unknown>, desired: K8sObject): string[] {
  if (desired.kind !== "StatefulSet") return [];
  const out: string[] = [];
  const want = isRecord(desired.spec) ? desired.spec : {};

  if (isRecord(want.selector) && !deepEqual(dig(live, "spec", "selector", "matchLabels"), (want.selector as Record<string, unknown>).matchLabels)) out.push("spec.selector");
  if (typeof want.serviceName === "string" && dig(live, "spec", "serviceName") !== want.serviceName) out.push("spec.serviceName");
  if (typeof want.podManagementPolicy === "string") {
    const have = dig(live, "spec", "podManagementPolicy") ?? "OrderedReady";
    if (have !== want.podManagementPolicy) out.push("spec.podManagementPolicy");
  }

  if (Array.isArray(want.volumeClaimTemplates)) {
    const wanted = claimsOf(want.volumeClaimTemplates);
    const have = claimsOf(dig(live, "spec", "volumeClaimTemplates"));
    for (const name of sortedUnique([...wanted.keys(), ...have.keys()])) {
      const w = wanted.get(name);
      const h = have.get(name);
      if (!w || !h) {
        out.push(`spec.volumeClaimTemplates[${name}] (${w ? "added" : "removed"})`);
        continue;
      }
      if (!deepEqual(w.storage, h.storage)) out.push(`spec.volumeClaimTemplates[${name}].resources.requests.storage`);
      // an unspecified class means "the cluster default"; only a stated class can disagree
      if (w.storageClassName !== undefined && !deepEqual(w.storageClassName, h.storageClassName)) out.push(`spec.volumeClaimTemplates[${name}].storageClassName`);
      if (!deepEqual(w.accessModes, h.accessModes)) out.push(`spec.volumeClaimTemplates[${name}].accessModes`);
    }
  }
  return out;
}
