/**
 * Projecting a live object onto the fields ONE field manager owns.
 *
 * Why this exists: server-side apply REPLACES the applied set of the manager
 * that applies. Re-applying a partial object under `zenith` (for example just a
 * new pod template) would delete every other field `zenith` previously owned —
 * replicas, strategy, labels, probes. Anything that must change part of an
 * object Zenith owns (rollback) therefore extracts what `zenith` owns from
 * `metadata.managedFields`, edits it, and applies the WHOLE thing back. This is
 * the same pattern as client-go's generated `Extract<Kind>` helpers.
 *
 * `managedFields[].fieldsV1` format (Kubernetes FieldsV1): a tree where
 *   `f:<name>`      a map field; `{}` means the whole value is owned, a
 *                   non-empty object descends
 *   `k:{<json>}`    a list item selected by its merge-key fields
 *   `v:<json>`      a set item selected by its value
 *   `i:<n>`         a list item by index
 *   `.`             the node itself is owned (alongside children)
 * Only `operation: Apply` entries of the named manager (no subresource) are used.
 *
 * Honest limit: exercised against a fake API server that generates fieldsV1 by
 * the same rules; not yet against a real cluster's output.
 */
import { deepEqual, isRecord } from "./util";

interface ManagedFieldsEntry {
  manager?: string;
  operation?: string;
  subresource?: string;
  fieldsV1?: Record<string, unknown>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function hasChildren(sub: Record<string, unknown>): boolean {
  return Object.keys(sub).some((k) => k !== ".");
}

function projectMap(value: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, rawSub] of Object.entries(fields)) {
    if (!key.startsWith("f:")) continue;
    const name = key.slice(2);
    if (!(name in value)) continue;
    const child = value[name];
    const sub = isRecord(rawSub) ? rawSub : {};
    out[name] = hasChildren(sub) ? project(child, sub) : clone(child);
  }
  return out;
}

function projectList(list: unknown[], fields: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  list.forEach((item, index) => {
    for (const [key, rawSub] of Object.entries(fields)) {
      const sub = isRecord(rawSub) ? rawSub : {};
      let matched = false;
      let keyFields: Record<string, unknown> | undefined;
      if (key.startsWith("k:") && isRecord(item)) {
        try {
          const parsed = JSON.parse(key.slice(2)) as unknown;
          if (isRecord(parsed) && Object.entries(parsed).every(([k, v]) => deepEqual(item[k], v))) {
            matched = true;
            keyFields = parsed;
          }
        } catch {
          // a malformed key selects nothing
        }
      } else if (key.startsWith("v:")) {
        try {
          matched = deepEqual(item, JSON.parse(key.slice(2)));
        } catch {
          matched = false;
        }
      } else if (key.startsWith("i:")) {
        matched = Number(key.slice(2)) === index;
      }
      if (!matched) continue;
      if (hasChildren(sub) && isRecord(item)) {
        out.push({ ...(keyFields ?? {}), ...projectMap(item, sub) });
      } else {
        out.push(clone(item));
      }
      return;
    }
  });
  return out;
}

function project(value: unknown, fields: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return projectList(value, fields);
  if (isRecord(value)) return projectMap(value, fields);
  return clone(value);
}

/**
 * The part of `live` that `manager` owns through server-side apply, as an
 * apply-ready object (identity fields included), or `undefined` when the
 * manager has no Apply record on it.
 */
export function extractOwned(live: Record<string, unknown>, manager: string): Record<string, unknown> | undefined {
  const meta = isRecord(live.metadata) ? live.metadata : {};
  const entries = (Array.isArray(meta.managedFields) ? meta.managedFields : []) as ManagedFieldsEntry[];
  const mine = entries.filter((e) => e.manager === manager && e.operation === "Apply" && !e.subresource && isRecord(e.fieldsV1));
  if (mine.length === 0) return undefined;
  const merged: Record<string, unknown> = {};
  for (const entry of mine) {
    const part = projectMap(live, entry.fieldsV1 as Record<string, unknown>);
    for (const [k, v] of Object.entries(part)) merged[k] = isRecord(merged[k]) && isRecord(v) ? { ...(merged[k] as Record<string, unknown>), ...v } : v;
  }
  const projectedMeta = isRecord(merged.metadata) ? merged.metadata : {};
  return {
    ...merged,
    apiVersion: live.apiVersion,
    kind: live.kind,
    metadata: {
      ...projectedMeta,
      name: meta.name,
      ...(typeof meta.namespace === "string" ? { namespace: meta.namespace } : {}),
    },
  };
}
