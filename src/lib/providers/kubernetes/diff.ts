/**
 * Comparing a live object with the object a server-side dry-run says it would
 * become, as a list of changed field paths. Paths only: never values, so a
 * Secret (or any field) can be reported as changed without being disclosed.
 *
 * Server-owned noise (resourceVersion, uid, managedFields, status, the
 * Deployment revision counter, …) is removed before comparing, so a no-op
 * apply diffs to nothing.
 */
import { ANNOTATION } from "./types";
import { isRecord } from "./util";

const SERVER_METADATA = [
  "managedFields",
  "resourceVersion",
  "uid",
  "creationTimestamp",
  "generation",
  "selfLink",
  "deletionTimestamp",
  "deletionGracePeriodSeconds",
  "ownerReferences",
];

const SERVER_ANNOTATIONS = [ANNOTATION.revision, "kubectl.kubernetes.io/last-applied-configuration"];

/** A copy of `obj` without server-maintained fields; Secret values become key names only. */
export function normalizeForDiff(obj: Record<string, unknown>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  delete out.status;
  const meta = isRecord(out.metadata) ? out.metadata : undefined;
  if (meta) {
    for (const k of SERVER_METADATA) delete meta[k];
    if (isRecord(meta.annotations)) {
      for (const k of SERVER_ANNOTATIONS) delete meta.annotations[k];
      if (Object.keys(meta.annotations).length === 0) delete meta.annotations;
    }
  }
  if (out.kind === "Secret") {
    // values are never compared here, only which keys exist
    if (isRecord(out.data)) out.data = Object.fromEntries(Object.keys(out.data).map((k) => [k, "<value>"]));
    delete out.stringData;
  }
  return out;
}

const LIST_KEYS = ["name", "containerPort", "mountPath", "port"] as const;

function listKey(items: unknown[]): ((item: unknown) => string) | undefined {
  if (items.length === 0 || !items.every(isRecord)) return undefined;
  for (const key of LIST_KEYS) {
    if (items.every((i) => (i as Record<string, unknown>)[key] !== undefined)) {
      return (i) => `${key}=${String((i as Record<string, unknown>)[key])}`;
    }
  }
  return undefined;
}

const SAFE_KEY = /^[A-Za-z0-9_-]+$/;
const join = (base: string, key: string) => (SAFE_KEY.test(key) ? (base ? `${base}.${key}` : key) : `${base}[${JSON.stringify(key)}]`);

function walk(a: unknown, b: unknown, path: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  if (a === b) return;
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) walk(a[k], b[k], join(path, k), out, limit);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const keyA = listKey(a);
    const keyB = listKey(b);
    if (keyA && keyB) {
      const ma = new Map(a.map((i) => [keyA(i), i]));
      const mb = new Map(b.map((i) => [keyB(i), i]));
      for (const k of [...new Set([...ma.keys(), ...mb.keys()])].sort()) walk(ma.get(k), mb.get(k), `${path}[${k}]`, out, limit);
      return;
    }
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) walk(a[i], b[i], `${path}[${i}]`, out, limit);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(path || "(root)");
}

/** Sorted changed paths between two normalized objects, at most `limit`. */
export function diffPaths(before: unknown, after: unknown, limit = 200): string[] {
  const out: string[] = [];
  walk(before, after, "", out, limit);
  return out.sort();
}
