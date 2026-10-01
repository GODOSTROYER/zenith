/**
 * Incident investigation engine (spec §21, ADR-0014).
 *
 * Deterministic, evidence-first: traverse the resource graph along the request
 * path, run bounded read-only probes at each hop through injected ports, score
 * hypotheses with data-driven rules, and propose remediations as exact
 * capability requests whose approval status comes from a policy dry-run.
 * Models may narrate (`summarizeForModel`); they cannot add evidence.
 */
export type {
  Evidence,
  Hop,
  Hypothesis,
  HypothesisBasis,
  Investigation,
  RemediationOption,
  RemediationPolicy,
} from "./types";
export type { ExpectedAttributes, HttpProbeResult, InvestigationPorts, PortOptions, RecentChange } from "./ports";
export { investigate, InvestigationInputError } from "./investigate";
export type { InvestigateInput, InvestigateOptions, InvestigationEnvironment } from "./investigate";
export { traverse, TraversalError, MAX_SERVICE_DEPTH, dependencyClassOf, hopOfKind } from "./traverse";
export type { DependencyClass, PathStep, RequestPath } from "./traverse";
export { HYPOTHESIS_THRESHOLD, RULES, UNKNOWN_CONFIDENCE, rankHypotheses, scoreRule } from "./rules";
export type { EvidenceMatcher, HypothesisRule, RuleClause, ScoredRule } from "./rules";
export { attachRemediations, draftRemediations, requestFor } from "./remediation";
export type { Draft, RemediationContext } from "./remediation";
export { SIGNATURES, scanText } from "./signatures";
export type { Signature, SignatureHit, SignatureId, TextItem } from "./signatures";
export { sanitizeText, redactSecrets, stripControl } from "./sanitize";
export { summarizeForModel } from "./summarize";
