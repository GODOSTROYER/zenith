/**
 * Pure helpers for the incident investigation view (ADR-0014).
 *
 * The investigation engine is a deterministic toolkit: evidence is what bounded
 * read-only checks observed, hypotheses are rules over that evidence, and a
 * hypothesis's confidence is computed from which checks passed and failed. So the
 * numbers shown come straight from the data (`toPercent` only rounds for display)
 * and nothing here re-ranks by anything but the confidence the rule produced.
 */
import type { Evidence, Hypothesis, Investigation } from "@/lib/incidents/types";

export const INVESTIGATION_NOTE = "Evidence is observed data; hypotheses are rule-based.";

/** Highest confidence first. Unusable confidences sort last; ties break on title then id for stable output. */
export function sortHypotheses(hypotheses: readonly Hypothesis[]): Hypothesis[] {
  const key = (h: Hypothesis) => (Number.isFinite(h.confidence) ? h.confidence : -Infinity);
  return [...hypotheses].sort((a, b) => {
    const d = key(b) - key(a);
    if (d !== 0 && !Number.isNaN(d)) return d;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface ResolvedEvidence {
  id: string;
  /** undefined when the hypothesis cites an id that is not in the investigation's evidence list */
  evidence?: Evidence;
}

/** Resolve a hypothesis's evidence ids against the investigation. A missing one is reported, not dropped. */
export function resolveEvidence(investigation: Pick<Investigation, "evidence">, ids: readonly string[]): ResolvedEvidence[] {
  const byId = new Map(investigation.evidence.map((e) => [e.id, e] as const));
  return ids.map((id) => ({ id, evidence: byId.get(id) }));
}

export interface EvidenceTally {
  pass: number;
  fail: number;
  unknown: number;
}

export function tallyEvidence(evidence: readonly Evidence[]): EvidenceTally {
  const t: EvidenceTally = { pass: 0, fail: 0, unknown: 0 };
  for (const e of evidence) t[e.outcome] += 1;
  return t;
}
