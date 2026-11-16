/**
 * Attribute readers shared by several drivers: a live container's normalized
 * attributes, and guards that keep `expectedAttributes` from throwing on a
 * malformed spec (the renderer is the place that rejects bad specs loudly).
 */
import type { ResourceNode } from "@/lib/resources/types";
import { cpuToMillicores, dig, isRecord, quantityToMiB } from "../util";

/** image, cpu (millicores), memory (MiB), first port and readiness path of one container. */
export function containerAttributes(container: unknown): Record<string, unknown> {
  if (!isRecord(container)) return {};
  const port = dig(container, "ports", 0, "containerPort");
  const path = dig(container, "readinessProbe", "httpGet", "path");
  return {
    image: typeof container.image === "string" ? container.image : undefined,
    cpuMillicores: cpuToMillicores(dig(container, "resources", "limits", "cpu")),
    memoryMi: quantityToMiB(dig(container, "resources", "limits", "memory")),
    port: typeof port === "number" ? port : undefined,
    healthPath: typeof path === "string" ? path : undefined,
  };
}

/** `expected(node)` that degrades to "only ownership is expected" when the spec is unusable. */
export function safeExpected(fn: (node: ResourceNode) => Record<string, unknown>): (node: ResourceNode) => Record<string, unknown> {
  return (node) => {
    try {
      return fn(node);
    } catch {
      return {};
    }
  };
}

export function labelsOf(live: Record<string, unknown>): Record<string, string> {
  const l = dig(live, "metadata", "labels");
  return isRecord(l) ? (Object.fromEntries(Object.entries(l).filter(([, v]) => typeof v === "string")) as Record<string, string>) : {};
}

export function sortedStrings(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))].sort() : [];
}

/** Keep only scalar (string/number/boolean) entries: the shape a discovery candidate's attributes need. */
export function compact(obj: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(obj)) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  return out;
}
