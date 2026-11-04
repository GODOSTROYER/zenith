/**
 * How one side of a planned attribute change is shown.
 *
 * `planView` (src/lib/tofu/plan.ts) already withholds sensitive values, unknown
 * values and anything that is not a short scalar; this module decides what the
 * reader sees in their place, and adds one more guard of its own so a value at a
 * secret-looking path can never be printed even if a caller hands one in.
 *
 *   "(sensitive)"          a value Zenith must not display (masked by the plan,
 *                          flagged sensitive, or at a secret-looking path)
 *   "(known after apply)"  preserved exactly: the provider decides it at apply time
 *   "(not shown)"          present in the plan but withheld from this view
 *                          (object, list or long text): the attribute did change
 *   "(not set)" etc.       the attribute had no value on that side
 *
 * None of these is ever blank, and "unknown" is never rendered as "unchanged".
 */
import type { PlanViewChange } from "@/lib/tofu/plan";
import type { TofuAction } from "@/lib/tofu/types";
import { formatScalar, isSecretReference, isSecretishPath } from "./text";

export const SENSITIVE_TEXT = "(sensitive)";
export const UNKNOWN_TEXT = "(known after apply)";
export const NOT_SHOWN_TEXT = "(not shown)";

/** A plan-view change, optionally carrying the `sensitive` flag from the normalized plan. */
export type PlanChange = PlanViewChange & { sensitive?: boolean };

export type ShownKind = "value" | "sensitive" | "unknown" | "absent" | "not_shown";

export interface ShownValue {
  text: string;
  kind: ShownKind;
  /** why the text is what it is, for a tooltip */
  explanation?: string;
}

export function describePlanValue(change: PlanChange, side: "before" | "after", action: TofuAction): ShownValue {
  const raw = change[side];

  if (change.sensitive === true || raw === SENSITIVE_TEXT) {
    return {
      text: SENSITIVE_TEXT,
      kind: "sensitive",
      explanation: "Zenith never displays this value. The attribute is marked sensitive.",
    };
  }
  if (raw === UNKNOWN_TEXT) {
    return { text: UNKNOWN_TEXT, kind: "unknown", explanation: "The provider decides this value when the change is applied." };
  }
  if (raw === undefined) {
    if (isSecretishPath(change.path)) {
      return { text: SENSITIVE_TEXT, kind: "sensitive", explanation: "The attribute name looks secret, so its value is withheld." };
    }
    return {
      text: NOT_SHOWN_TEXT,
      kind: "not_shown",
      explanation: "This attribute changed, but its value is long, structured or otherwise withheld from this view.",
    };
  }
  if (raw === null) {
    const text = side === "before" ? "(not set)" : action === "delete" ? "(removed)" : "(unset)";
    return { text, kind: "absent" };
  }
  if (isSecretishPath(change.path) && !isSecretReference(raw)) {
    return { text: SENSITIVE_TEXT, kind: "sensitive", explanation: "The attribute name looks secret, so its value is withheld." };
  }
  return { text: formatScalar(raw, 200), kind: "value" };
}

export interface NodeGroup<R extends { nodeAddress?: string }> {
  /** the Zenith resource address; undefined for changes the plan could not map to one */
  nodeAddress: string | undefined;
  resources: R[];
}

/** Group plan resources by the Zenith node they belong to. Unmapped changes come last. */
export function groupByNode<R extends { nodeAddress?: string }>(resources: readonly R[]): NodeGroup<R>[] {
  const map = new Map<string | undefined, R[]>();
  for (const r of resources) {
    const list = map.get(r.nodeAddress) ?? [];
    list.push(r);
    map.set(r.nodeAddress, list);
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return keys.map((k) => ({ nodeAddress: k, resources: map.get(k) ?? [] }));
}

/** delete and replace are the actions that remove running infrastructure. */
export const isDestructiveAction = (a: TofuAction): boolean => a === "delete" || a === "replace";
