/**
 * Selector labels for label-based backends (Prometheus, Loki).
 *
 * A stream/series is selected by labels taken from the resource graph, never
 * from query text. Which graph label feeds which backend label is explicit
 * configuration (`labelMap`), with a conservative default. Label NAMES are
 * sanitized to the backend grammar and label VALUES are escaped as string
 * literals by `escape.ts`; a node that yields no usable label is not queried
 * (an empty selector would match everything).
 */
import type { ResourceNode } from "@/lib/resources/types";
import { toLabelName } from "../escape";

/** graph label key → backend label name */
export type LabelMap = Record<string, string>;

/** Graph label keys that commonly identify a workload, mapped to conventional backend label names. */
export const DEFAULT_LABEL_MAP: LabelMap = {
  app: "app",
  "app.kubernetes.io/name": "app_kubernetes_io_name",
  service: "service",
  namespace: "namespace",
  job: "job",
};

const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/**
 * Backend label → value for one node. Values must be non-empty strings of
 * sane length; `spec.namespace` (a Kubernetes namespace name) also feeds a
 * `namespace` label when the map does not already provide one.
 */
export function selectorLabelsFor(node: ResourceNode, labelMap: LabelMap = DEFAULT_LABEL_MAP): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [graphKey, backendName] of Object.entries(labelMap)) {
    const value = node.labels[graphKey];
    const name = toLabelName(backendName);
    if (name !== undefined && typeof value === "string" && value !== "" && value.length <= 253) out[name] = value;
  }
  const ns = node.spec.namespace;
  if (out.namespace === undefined && typeof ns === "string" && K8S_NAME.test(ns)) out.namespace = ns;
  return out;
}
