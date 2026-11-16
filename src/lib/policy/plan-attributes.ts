/**
 * Rebuilds a resource's planned attribute tree from the flat attribute changes
 * of a normalized OpenTofu plan (`PlanAttributeChange`), so plan-fact rules can
 * ask "what does this resource look like after apply" instead of pattern
 * matching on paths.
 *
 * Path forms accepted (whatever the normalizer emits, both are common):
 *   `publicly_accessible`            `ingress[0].cidr_blocks[1]`
 *   `ingress.0.from_port`            `tags["Name"]`
 * A change may also carry a whole block or list as its `after` value (path
 * `ingress`, value `[{...}, {...}]`); it is placed as-is.
 *
 * Honesty about what the tree is: it contains only what the normalized plan
 * reports. An attribute the normalizer omitted (unchanged, so absent from the
 * diff) is absent here, and rules treat "absent" as "not asserted", never as
 * "safe". Values that are masked (`(sensitive)`) or not yet known
 * (`(known after apply)`) are kept as their sentinel strings so rules can tell
 * "unknown" from "absent" and report it instead of guessing.
 */
import type { PlanAttributeChange } from "@/lib/tofu/types";

export const UNKNOWN_VALUE = "(known after apply)";
export const MASKED_VALUE = "(sensitive)";

export type Attrs = Record<string, unknown>;

/** The value cannot be judged: it is masked or only known after apply. */
export const isUnresolvable = (value: unknown): boolean => value === UNKNOWN_VALUE || value === MASKED_VALUE;

/** Guards against absurd indexes turning into huge sparse arrays. */
const MAX_INDEX = 4096;
const MAX_DEPTH = 32;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type Segment = string | number;
type Container = Attrs | unknown[];

/** Tokenize a plan attribute path; `null` when it cannot be understood. */
export function parseAttributePath(path: string): Segment[] | null {
  const segments: Segment[] = [];
  let i = 0;
  const n = path.length;
  while (i < n) {
    const ch = path[i];
    if (ch === ".") {
      i += 1;
      continue;
    }
    if (ch === "[") {
      if (path[i + 1] === '"') {
        let j = i + 2;
        let key = "";
        while (j < n && path[j] !== '"') {
          if (path[j] === "\\" && j + 1 < n) j += 1;
          key += path[j];
          j += 1;
        }
        if (path[j] !== '"' || path[j + 1] !== "]") return null;
        segments.push(key);
        i = j + 2;
      } else {
        const close = path.indexOf("]", i);
        if (close === -1) return null;
        const raw = path.slice(i + 1, close);
        if (!/^\d+$/.test(raw)) return null;
        segments.push(Number(raw));
        i = close + 1;
      }
      continue;
    }
    let j = i;
    while (j < n && path[j] !== "." && path[j] !== "[") j += 1;
    const token = path.slice(i, j);
    segments.push(/^\d+$/.test(token) ? Number(token) : token);
    i = j;
  }
  return segments.length > 0 && segments.length <= MAX_DEPTH ? segments : null;
}

function emptyContainer(next: Segment): Container {
  return typeof next === "number" ? [] : (Object.create(null) as Attrs);
}

function slotOf(container: Container, key: Segment): unknown {
  return (container as Record<string | number, unknown>)[key];
}

function assignSlot(container: Container, key: Segment, value: unknown): void {
  (container as Record<string | number, unknown>)[key] = value;
}

/** Place `value` at `segments` inside `root`; returns false when it cannot be placed. */
function setAt(root: Attrs, segments: Segment[], value: unknown): boolean {
  // Validate the whole path first so a rejected path leaves no partial structure behind.
  const unsafe = segments.some((seg) => (typeof seg === "string" ? FORBIDDEN_KEYS.has(seg) : seg > MAX_INDEX));
  if (unsafe) return false;
  let cursor: Container = root;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (Array.isArray(cursor) !== (typeof seg === "number")) return false;
    if (i === segments.length - 1) {
      assignSlot(cursor, seg, value);
      return true;
    }
    const want = segments[i + 1];
    const existing: unknown = slotOf(cursor, seg);
    const usable = existing !== null && typeof existing === "object" && Array.isArray(existing) === (typeof want === "number");
    const child: Container = usable ? (existing as Container) : emptyContainer(want);
    assignSlot(cursor, seg, child);
    cursor = child;
  }
  return false;
}

/** The value a change asserts after apply; masked when the change is sensitive. */
function afterValue(change: PlanAttributeChange): unknown {
  return change.sensitive ? MASKED_VALUE : change.after;
}

/**
 * The planned attribute tree of one resource, from its attribute changes.
 * Changes whose path cannot be placed are skipped (they are not asserted).
 */
export function materializeAfter(changes: readonly PlanAttributeChange[]): Attrs {
  const root = Object.create(null) as Attrs;
  for (const change of changes) {
    if (change.after === undefined && !change.sensitive) continue;
    const segments = parseAttributePath(change.path);
    if (!segments) continue;
    setAt(root, segments, afterValue(change));
  }
  return root;
}

/** Array view of a value: a list stays a list, a scalar becomes one element, nothing becomes []. */
export function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/** A usable string value (not masked, not unknown). */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && !isUnresolvable(value) ? value : undefined;
}

/** A number, accepting numeric strings ("22"); masked/unknown yield undefined. */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

export function isRecord(value: unknown): value is Attrs {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
