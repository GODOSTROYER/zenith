/**
 * A minimal stand-in for the drift-v2 comparison (`computeDriftV2`, WS-RES),
 * which is not on this branch. It applies the same rule the real one applies:
 * only attributes the observation marks `known` are compared, scalars are
 * compared by their text (cloud APIs answer "3" for 3), structures canonically;
 * `missing` and `inaccessible` are findings, never silence. It exists to prove
 * that `expectedAttributes` and `observe` speak the same names and units.
 */
import { sameValue } from "@/lib/providers/aws/drivers/data/support";
import type { Observation, ResourceNode } from "@/lib/resources/types";

export interface DriftFinding {
  class: "missing" | "changed" | "inaccessible" | "unknown";
  severity: "medium" | "high";
  fields?: { attribute: string; desired: unknown; observed: unknown }[];
}

const truthy = (v: unknown): boolean => v === true || (typeof v === "string" && v.toLowerCase() === "true");

export function driftOf(node: ResourceNode, obs: Observation, expected: (n: ResourceNode) => Record<string, unknown>): DriftFinding[] {
  if (obs.presence === "inaccessible") return [{ class: "inaccessible", severity: "medium" }];
  if (obs.presence === "missing") return [{ class: "missing", severity: "high" }];
  if (obs.presence === "unknown" && Object.values(obs.attributes).every((a) => a.state !== "known")) return [{ class: "unknown", severity: "medium" }];
  const fields: NonNullable<DriftFinding["fields"]> = [];
  const want = expected(node);
  for (const attribute of Object.keys(want).sort()) {
    const seen = obs.attributes[attribute];
    if (want[attribute] === undefined || !seen || seen.state !== "known") continue;
    if (!sameValue(want[attribute], seen.value)) fields.push({ attribute, desired: want[attribute], observed: seen.value });
  }
  if (fields.length === 0) return [];
  const risky = fields.some((f) => /public/i.test(f.attribute) && truthy(f.observed) && !truthy(f.desired)) || node.kind === "identity";
  return [{ class: "changed", severity: risky ? "high" : "medium", fields }];
}

