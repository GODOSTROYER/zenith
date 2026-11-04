/**
 * Redaction coverage as a ratchet (WS-SEC).
 *
 * A redactor is best-effort, so "it removes secrets" is never a true sentence;
 * "it removes THESE shapes in THESE positions and misses THOSE" is. This helper
 * measures exactly that and turns the answer into an assertion that can only
 * move deliberately:
 *
 *     const { leaks } = await measureCoverage({ contexts, redact });
 *     expectCoverage(leaks, KNOWN_GAPS, "MCP reader redact()");
 *
 * `KNOWN_GAPS` is the documented set of (position -> shapes) the redactor does
 * NOT cover today. The assertion fails in both directions:
 *   - a NEW gap (a shape that used to be removed now leaks) is a regression;
 *   - a gap that is now COVERED must be deleted from `KNOWN_GAPS` — so the
 *     document of what is unprotected never overstates the exposure and never
 *     goes stale.
 * That makes the threat model's residual-risk column a checked claim instead of
 * prose.
 */
import { CANARY_SHAPES, canarySecret, deepScanForCanaries, type CanaryShape } from "./canaries";

export interface CoverageContext {
  /** build the value the redactor will see, with `secret` planted in it */
  build(secret: string): unknown;
  /** shapes that make sense in this position (default: all) */
  shapes?: readonly CanaryShape[];
}

/** position -> shapes that survived redaction */
export type CoverageMap = Record<string, CanaryShape[]>;

export interface CoverageSpec {
  contexts: Record<string, CoverageContext>;
  /** may be async (an audit write followed by a read-back is) */
  redact(value: unknown): unknown | Promise<unknown>;
  shapes?: readonly CanaryShape[];
}

export interface CoverageResult {
  /** position -> shapes that leaked (sorted; positions with no leak are absent) */
  leaks: CoverageMap;
  /** position -> shapes that were removed */
  covered: CoverageMap;
  table(): string;
}

export async function measureCoverage(spec: CoverageSpec): Promise<CoverageResult> {
  const leaks: CoverageMap = {};
  const covered: CoverageMap = {};
  for (const [position, ctx] of Object.entries(spec.contexts)) {
    for (const shape of ctx.shapes ?? spec.shapes ?? CANARY_SHAPES) {
      const secret = canarySecret(`coverage/${position}`, shape, { stable: true });
      let output: unknown;
      try {
        output = await spec.redact(ctx.build(secret));
      } catch (error) {
        // a redactor that throws on a value has not protected it, but has not leaked it either: count as covered
        output = { threw: (error as Error).name };
      }
      const leaked = deepScanForCanaries(output, [secret]).length > 0;
      (leaked ? (leaks[position] ??= []) : (covered[position] ??= [])).push(shape);
    }
  }
  for (const map of [leaks, covered]) for (const k of Object.keys(map)) map[k].sort();
  return {
    leaks,
    covered,
    table() {
      const shapes = [...new Set(Object.values({ ...leaks, ...covered }).flat())].sort();
      const head = ["position", ...shapes.map((s) => s.replace("aws-", "").replace("-private-key", "").replace("-access-key-id", "-id"))];
      const rows = Object.keys(spec.contexts).map((position) => [
        position,
        ...shapes.map((s) => (leaks[position]?.includes(s) ? "LEAK" : covered[position]?.includes(s) ? "ok" : "-")),
      ]);
      const widths = head.map((_, i) => Math.max(head[i].length, ...rows.map((r) => r[i].length)));
      return [head, ...rows].map((r) => r.map((v, i) => v.padEnd(widths[i])).join("  ")).join("\n");
    },
  };
}

const show = (map: CoverageMap) =>
  Object.entries(map)
    .map(([k, v]) => `    ${k}: ${v.join(", ")}`)
    .join("\n");

/** Assert `actual` leaks are exactly `known`, reporting both directions of drift. */
export function expectCoverage(actual: CoverageMap, known: CoverageMap, name: string): void {
  const isIn = (map: CoverageMap, position: string, shape: CanaryShape) => map[position]?.includes(shape) ?? false;
  const fresh: CoverageMap = {};
  const fixed: CoverageMap = {};
  for (const [position, shapes] of Object.entries(actual)) for (const s of shapes) if (!isIn(known, position, s)) (fresh[position] ??= []).push(s);
  for (const [position, shapes] of Object.entries(known)) for (const s of shapes) if (!isIn(actual, position, s)) (fixed[position] ??= []).push(s);
  if (Object.keys(fresh).length === 0 && Object.keys(fixed).length === 0) return;
  const parts: string[] = [`REDACTION COVERAGE CHANGED for ${name}.`];
  if (Object.keys(fresh).length) parts.push(`NEW GAPS (a regression: these planted secrets now survive redaction):\n${show(fresh)}`);
  if (Object.keys(fixed).length) parts.push(`NOW COVERED (good: delete these from KNOWN_GAPS and from the threat model's residual risk):\n${show(fixed)}`);
  throw new Error(parts.join("\n"));
}
