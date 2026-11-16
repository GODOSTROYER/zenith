/**
 * The result of judging newly materialized dependency outputs against what a person
 * approved. Only `assessOutputConsumption` can create one (`issueDecision`); the run
 * state machine accepts a `rebind` only when it carries an issued decision, so a
 * caller cannot assemble "preauthorized" by hand.
 */
export interface DecisionConsumer {
  readonly childId: string;
  readonly previousEffectDigest: string;
  readonly newEffectDigest: string;
  readonly referenceIds: readonly string[];
}

export interface OutputConsumptionDecision {
  /**
   * unchanged: the outputs equal what was reviewed.
   * preauthorized: every changed reference is covered by a live, precise preauthorization.
   * review_required: a person must review the new parent digest (DUR-B) before any consumer starts.
   */
  readonly classification: "unchanged" | "preauthorized" | "review_required";
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly desiredDigest: string;
  /** The exact parent candidate a review or preauthorization covers. */
  readonly requiredParentDigest: string;
  readonly reasons: readonly string[];
  readonly consumers: readonly DecisionConsumer[];
  readonly preauthorizationIds: readonly string[];
  /** Reference ids with a changed materialization that no preauthorization covers. */
  readonly uncovered: readonly string[];
}

const issued = new WeakSet<object>();

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function issueDecision(decision: OutputConsumptionDecision): OutputConsumptionDecision {
  const sealed = freeze(structuredClone(decision));
  issued.add(sealed);
  return sealed;
}

export function isIssuedDecision(value: unknown): value is OutputConsumptionDecision {
  return typeof value === "object" && value !== null && issued.has(value);
}
