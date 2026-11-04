/**
 * Incident stability rules (PROD-OBS-03). Pure and deterministic: no I/O, no
 * clock, no randomness. The durable store (`controlplane/db/repos/
 * incident-stability.ts`) loads a snapshot under a lock and asks these
 * functions what is allowed; a model never decides any of it.
 *
 *   fingerprint   one stable id per problem, so repeats attach to one incident
 *   hysteresis    open after N consecutive bad observations, clear only after
 *                 M consecutive good ones (M >= N); `unknown` changes nothing
 *   cooldown      minimum gap between repair attempts for a fingerprint, with
 *                 exponential backoff while attempts keep failing
 *   limits        attempts per incident, in-flight repairs, repairs per
 *                 environment/workspace per window, distinct resources touched
 *   blast radius  proposals wider than the cap are never made autonomously
 *   windows       maintenance windows suppress repair proposals
 *   autoscaler    a manual scale is never proposed against an autoscaled target
 *   escalation    inconclusive diagnosis, exhausted attempts or a cap that
 *                 needs a person produce an escalation, not another guess
 */
import { digest } from "@/lib/controlplane/digest";
import type { TelemetryState } from "@/lib/observability/telemetry";
import type { ResourceGraph } from "@/lib/resources/types";

/* --------------------------------- policy ---------------------------------- */

export type BlastRadius = "low" | "medium" | "high";
export type RiskLevel = "low" | "medium" | "high" | "critical";
const BLAST_ORDER: readonly BlastRadius[] = ["low", "medium", "high"];
const RISK_ORDER: readonly RiskLevel[] = ["low", "medium", "high", "critical"];

export interface StabilityPolicy {
  hysteresis: { openAfter: number; clearAfter: number };
  remediation: {
    maxAttemptsPerIncident: number;
    baseCooldownMs: number;
    maxCooldownMs: number;
    /** a reserved attempt that never settles stops counting as in flight after this */
    inflightTtlMs: number;
    maxInflightPerEnvironment: number;
    windowMs: number;
    maxAttemptsPerEnvironmentWindow: number;
    maxAttemptsPerWorkspaceWindow: number;
    maxDistinctResourcesPerWindow: number;
    /** widest blast radius an automatic proposal may have */
    maxBlastRadius: BlastRadius;
    /** highest catalog risk an automatic proposal may have */
    maxRisk: RiskLevel;
    /** hypotheses below this confidence are not turned into proposals */
    minConfidence: number;
  };
  escalation: {
    unresolvedAfterMs: number;
    criticalUnresolvedAfterMs: number;
  };
}

export const DEFAULT_STABILITY_POLICY: StabilityPolicy = Object.freeze({
  hysteresis: Object.freeze({ openAfter: 3, clearAfter: 5 }),
  remediation: Object.freeze({
    maxAttemptsPerIncident: 3,
    baseCooldownMs: 5 * 60_000,
    maxCooldownMs: 60 * 60_000,
    inflightTtlMs: 15 * 60_000,
    maxInflightPerEnvironment: 1,
    windowMs: 60 * 60_000,
    maxAttemptsPerEnvironmentWindow: 5,
    maxAttemptsPerWorkspaceWindow: 20,
    maxDistinctResourcesPerWindow: 3,
    maxBlastRadius: "medium" as BlastRadius,
    maxRisk: "high" as RiskLevel,
    minConfidence: 0.5,
  }),
  escalation: Object.freeze({ unresolvedAfterMs: 2 * 3_600_000, criticalUnresolvedAfterMs: 30 * 60_000 }),
});

/** Overrides may tighten or loosen within these ceilings, never remove a limit. */
const CEILING = {
  openAfter: [1, 20],
  clearAfter: [1, 60],
  maxAttemptsPerIncident: [1, 10],
  baseCooldownMs: [10_000, 24 * 3_600_000],
  maxCooldownMs: [10_000, 24 * 3_600_000],
  inflightTtlMs: [60_000, 6 * 3_600_000],
  maxInflightPerEnvironment: [1, 5],
  windowMs: [60_000, 24 * 3_600_000],
  maxAttemptsPerEnvironmentWindow: [1, 50],
  maxAttemptsPerWorkspaceWindow: [1, 200],
  maxDistinctResourcesPerWindow: [1, 20],
  unresolvedAfterMs: [60_000, 7 * 24 * 3_600_000],
  criticalUnresolvedAfterMs: [60_000, 7 * 24 * 3_600_000],
} as const;

export class StabilityPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StabilityPolicyError";
  }
}

export type StabilityPolicyOverrides = {
  hysteresis?: Partial<StabilityPolicy["hysteresis"]>;
  remediation?: Partial<StabilityPolicy["remediation"]>;
  escalation?: Partial<StabilityPolicy["escalation"]>;
};

function bounded(name: keyof typeof CEILING, value: number): number {
  const [min, max] = CEILING[name];
  if (!Number.isInteger(value) || value < min || value > max) throw new StabilityPolicyError(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

/** Merge overrides over the defaults and validate every field; throws on a bad value. */
export function resolveStabilityPolicy(overrides: StabilityPolicyOverrides = {}): StabilityPolicy {
  const h = { ...DEFAULT_STABILITY_POLICY.hysteresis, ...overrides.hysteresis };
  const r = { ...DEFAULT_STABILITY_POLICY.remediation, ...overrides.remediation };
  const e = { ...DEFAULT_STABILITY_POLICY.escalation, ...overrides.escalation };
  bounded("openAfter", h.openAfter);
  bounded("clearAfter", h.clearAfter);
  if (h.clearAfter < h.openAfter) throw new StabilityPolicyError("clearAfter must be at least openAfter (hysteresis).");
  for (const k of ["maxAttemptsPerIncident", "baseCooldownMs", "maxCooldownMs", "inflightTtlMs", "maxInflightPerEnvironment", "windowMs", "maxAttemptsPerEnvironmentWindow", "maxAttemptsPerWorkspaceWindow", "maxDistinctResourcesPerWindow"] as const) bounded(k, r[k]);
  if (r.maxCooldownMs < r.baseCooldownMs) throw new StabilityPolicyError("maxCooldownMs must be at least baseCooldownMs.");
  if (!BLAST_ORDER.includes(r.maxBlastRadius)) throw new StabilityPolicyError("maxBlastRadius must be low, medium or high.");
  if (!RISK_ORDER.includes(r.maxRisk) || r.maxRisk === "critical") throw new StabilityPolicyError("maxRisk must be low, medium or high; critical is never automatic.");
  if (!(r.minConfidence >= 0.3 && r.minConfidence <= 1)) throw new StabilityPolicyError("minConfidence must be between 0.3 and 1.");
  bounded("unresolvedAfterMs", e.unresolvedAfterMs);
  bounded("criticalUnresolvedAfterMs", e.criticalUnresolvedAfterMs);
  return { hysteresis: h, remediation: r, escalation: e };
}

/* ------------------------------- fingerprint -------------------------------- */

export interface FingerprintInput {
  workspaceId: string;
  environmentId: string;
  /** stable problem class: a hypothesis code, an alert rule id, a probe name */
  problem: string;
  /** the resource the problem is about, when there is one (an address, never a timestamp) */
  subject?: string;
}

/** Same problem on the same subject: same fingerprint, regardless of when or how often it is seen. */
export function incidentFingerprint(input: FingerprintInput): string {
  for (const k of ["workspaceId", "environmentId", "problem"] as const)
    if (typeof input[k] !== "string" || input[k].trim() === "") throw new StabilityPolicyError(`fingerprint needs a non-empty ${k}.`);
  return digest({ v: 1, ws: input.workspaceId, env: input.environmentId, problem: input.problem.trim().toLowerCase(), subject: (input.subject ?? "").trim() });
}

/* -------------------------------- hysteresis -------------------------------- */

export type Observation = "bad" | "good" | "unknown";
export interface SignalState {
  state: "quiet" | "active";
  consecutiveBad: number;
  consecutiveGood: number;
}
export type SignalTransition = "none" | "activated" | "cleared";

export const INITIAL_SIGNAL: SignalState = Object.freeze({ state: "quiet", consecutiveBad: 0, consecutiveGood: 0 });

export function advanceSignal(policy: StabilityPolicy, prev: SignalState, observation: Observation): { next: SignalState; transition: SignalTransition } {
  // An observation that proves nothing neither opens nor clears an incident.
  if (observation === "unknown") return { next: { ...prev }, transition: "none" };
  const { openAfter, clearAfter } = policy.hysteresis;
  if (observation === "bad") {
    const bad = prev.consecutiveBad + 1;
    if (prev.state === "quiet" && bad >= openAfter) return { next: { state: "active", consecutiveBad: bad, consecutiveGood: 0 }, transition: "activated" };
    return { next: { state: prev.state, consecutiveBad: bad, consecutiveGood: 0 }, transition: "none" };
  }
  const good = prev.consecutiveGood + 1;
  if (prev.state === "active" && good >= clearAfter) return { next: { state: "quiet", consecutiveBad: 0, consecutiveGood: 0 }, transition: "cleared" };
  return { next: { state: prev.state, consecutiveBad: 0, consecutiveGood: good }, transition: "none" };
}

/**
 * Telemetry trust gate: an observation only counts as strongly as the data
 * behind it. A `bad` needs fresh data; a `good` needs fresh data or a reachable
 * source with nothing in the window (`empty`). Stale, unknown or inaccessible
 * telemetry proves nothing either way, so it can neither open nor clear.
 */
export function trustedObservation(observation: Observation, state: TelemetryState | undefined): Observation {
  if (state === undefined || observation === "unknown") return observation;
  if (observation === "bad") return state === "fresh" ? "bad" : "unknown";
  return state === "fresh" || state === "empty" ? "good" : "unknown";
}

/* ------------------------------ remediation gate ----------------------------- */

export type GateCode =
  | "maintenance_window"
  | "incident_inactive"
  | "escalated_to_human"
  | "signal_not_confirmed"
  | "low_confidence"
  | "risk_too_high"
  | "blast_radius_exceeded"
  | "autoscaler_conflict"
  | "attempts_exhausted"
  | "cooldown_active"
  | "inflight_limit"
  | "environment_rate_limit"
  | "resource_spread_limit"
  | "workspace_rate_limit"
  | "gate_unavailable";

/** Codes that mean a person has to act, so the incident is escalated. */
const NEEDS_HUMAN: ReadonlySet<GateCode> = new Set(["attempts_exhausted", "blast_radius_exceeded", "risk_too_high", "autoscaler_conflict"]);

export interface AttemptView {
  id: string;
  incidentId: string;
  environmentId: string;
  fingerprint: string;
  capability: string;
  resourceId?: string;
  status: "reserved" | "succeeded" | "failed" | "abandoned";
  /** ISO time */
  reservedAt: string;
}

export interface WindowView {
  id: string;
  /** absent: the whole workspace */
  environmentId?: string;
  startsAt: string;
  endsAt: string;
}

export interface GateSnapshot {
  now: Date;
  environmentId: string;
  /** null: no durable incident is tracked (a read-only investigation); incident-scoped limits are skipped */
  incident: { id: string; status: "open" | "investigating" | "mitigating" | "resolved"; escalatedAt?: string } | null;
  /** null: signal state is not tracked for this proposal */
  signalActive: boolean | null;
  /** cooldown carried by the fingerprint's signal state (set when an incident clears) */
  fingerprintCooldownUntil?: string;
  /** every counted attempt for this incident */
  incidentAttempts: readonly AttemptView[];
  /** counted attempts for this fingerprint across incidents, most recent first is not required */
  fingerprintAttempts: readonly AttemptView[];
  /** counted attempts in this environment inside the policy window */
  environmentAttempts: readonly AttemptView[];
  /** number of counted attempts in this workspace inside the policy window */
  workspaceAttemptCount: number;
  windows: readonly WindowView[];
}

export interface GateRequest {
  capability: string;
  resourceId?: string;
  blastRadius: BlastRadius;
  risk: RiskLevel;
  confidence: number;
  /** the target is managed by an autoscaler and the capability would fight it */
  autoscalerManaged: boolean;
}

export interface GateDecision {
  allowed: boolean;
  /** every rule that blocks, in fixed order; empty when allowed */
  codes: GateCode[];
  /** plain words per code */
  messages: string[];
  /** ISO time after which a time-based block (cooldown, window) lifts */
  retryAfter?: string;
  /** a person must act: record an escalation */
  escalate: boolean;
}

const MESSAGES: Record<GateCode, string> = {
  maintenance_window: "A maintenance window is active, so automatic repairs are held.",
  incident_inactive: "The incident is resolved or not tracked, so no repair is proposed.",
  escalated_to_human: "The incident was escalated; a person owns the next step.",
  signal_not_confirmed: "The problem has not persisted long enough to act on (hysteresis).",
  low_confidence: "The diagnosis is not confident enough to act on.",
  risk_too_high: "The change is riskier than automatic repair allows.",
  blast_radius_exceeded: "The change touches more than the automatic blast-radius cap allows.",
  autoscaler_conflict: "An autoscaler manages this target; a manual change would fight it.",
  attempts_exhausted: "The attempt limit for this incident has been reached.",
  cooldown_active: "A repair for this problem ran too recently; waiting out the cooldown.",
  inflight_limit: "Another repair is still in flight in this environment.",
  environment_rate_limit: "This environment reached its repair limit for the window.",
  resource_spread_limit: "Repairs already touched the maximum number of distinct resources in this window.",
  workspace_rate_limit: "This workspace reached its repair limit for the window.",
  gate_unavailable: "The stability store could not be read, so no repair is proposed.",
};

export const gateMessage = (code: GateCode): string => MESSAGES[code];

const ms = (iso: string): number => Date.parse(iso);

/** Consecutive failed attempts at the tail of the fingerprint's history (by time). */
function trailingFailures(attempts: readonly AttemptView[]): number {
  const ordered = [...attempts].sort((a, b) => ms(b.reservedAt) - ms(a.reservedAt) || (a.id < b.id ? -1 : 1));
  let n = 0;
  for (const a of ordered) {
    if (a.status !== "failed") break;
    n++;
  }
  return n;
}

export function cooldownMs(policy: StabilityPolicy, failures: number): number {
  const r = policy.remediation;
  return Math.min(r.maxCooldownMs, r.baseCooldownMs * 2 ** Math.min(failures, 20));
}

export function decideRemediation(policy: StabilityPolicy, snap: GateSnapshot, req: GateRequest): GateDecision {
  const r = policy.remediation;
  const now = snap.now.getTime();
  const codes: GateCode[] = [];
  let retryAfter: number | undefined;
  const push = (code: GateCode, until?: number) => {
    codes.push(code);
    if (until !== undefined && until > now) retryAfter = Math.max(retryAfter ?? 0, until);
  };

  const windows = snap.windows.filter((w) => (w.environmentId === undefined || w.environmentId === snap.environmentId) && ms(w.startsAt) <= now && now < ms(w.endsAt));
  if (windows.length) push("maintenance_window", Math.max(...windows.map((w) => ms(w.endsAt))));

  if (snap.incident && snap.incident.status === "resolved") push("incident_inactive");
  if (snap.incident?.escalatedAt) push("escalated_to_human");
  if (snap.signalActive === false) push("signal_not_confirmed");
  if (!(req.confidence >= r.minConfidence)) push("low_confidence");
  if (RISK_ORDER.indexOf(req.risk) > RISK_ORDER.indexOf(r.maxRisk)) push("risk_too_high");
  if (BLAST_ORDER.indexOf(req.blastRadius) > BLAST_ORDER.indexOf(r.maxBlastRadius)) push("blast_radius_exceeded");
  if (req.autoscalerManaged) push("autoscaler_conflict");

  if (snap.incident && snap.incidentAttempts.length >= r.maxAttemptsPerIncident) push("attempts_exhausted");

  // Cooldown: measured from the latest counted attempt for the fingerprint, widened by backoff after failures.
  const fpAttempts = snap.fingerprintAttempts.length ? snap.fingerprintAttempts : snap.incidentAttempts;
  if (fpAttempts.length) {
    const last = Math.max(...fpAttempts.map((a) => ms(a.reservedAt)));
    const until = last + cooldownMs(policy, trailingFailures(fpAttempts));
    if (now < until) push("cooldown_active", until);
  }
  if (snap.fingerprintCooldownUntil && now < ms(snap.fingerprintCooldownUntil)) push("cooldown_active", ms(snap.fingerprintCooldownUntil));

  const inflight = snap.environmentAttempts.filter((a) => a.status === "reserved" && now - ms(a.reservedAt) < r.inflightTtlMs);
  if (inflight.length >= r.maxInflightPerEnvironment) push("inflight_limit", Math.min(...inflight.map((a) => ms(a.reservedAt) + r.inflightTtlMs)));

  const windowStart = now - r.windowMs;
  const inWindow = snap.environmentAttempts.filter((a) => ms(a.reservedAt) > windowStart);
  if (inWindow.length >= r.maxAttemptsPerEnvironmentWindow) push("environment_rate_limit", Math.min(...inWindow.map((a) => ms(a.reservedAt))) + r.windowMs);
  const touched = new Set(inWindow.map((a) => a.resourceId ?? `capability:${a.capability}`));
  const target = req.resourceId ?? `capability:${req.capability}`;
  if (!touched.has(target) && touched.size >= r.maxDistinctResourcesPerWindow) push("resource_spread_limit");
  if (snap.workspaceAttemptCount >= r.maxAttemptsPerWorkspaceWindow) push("workspace_rate_limit");

  return {
    allowed: codes.length === 0,
    codes,
    messages: codes.map((c) => MESSAGES[c]),
    ...(retryAfter !== undefined ? { retryAfter: new Date(retryAfter).toISOString() } : {}),
    escalate: codes.some((c) => NEEDS_HUMAN.has(c)),
  };
}

/** The fail-closed decision used when the gate cannot be evaluated. */
export function gateUnavailable(): GateDecision {
  return { allowed: false, codes: ["gate_unavailable"], messages: [MESSAGES.gate_unavailable], escalate: false };
}

/* ---------------------------- autoscaler conflict ---------------------------- */

const AUTOSCALED_CAPABILITIES: ReadonlySet<string> = new Set(["service.scale"]);

/**
 * True when `capability` would set a replica count on `resourceId` while the
 * graph holds an autoscaler for it. The match is deliberately conservative: an
 * autoscaler whose target names the address, its short name, or that depends on
 * it counts; an autoscaler with no resolvable target counts for every service.
 */
export function autoscalerManaged(graph: ResourceGraph, capability: string, resourceId: string | undefined): boolean {
  if (!AUTOSCALED_CAPABILITIES.has(capability) || !resourceId) return false;
  const short = resourceId.includes("/") ? resourceId.slice(resourceId.indexOf("/") + 1) : resourceId;
  for (const n of graph.nodes) {
    if (!/autoscal/i.test(n.nativeType) && !/autoscal/i.test(n.address)) continue;
    const target = (n.spec as { target?: unknown } | undefined)?.target;
    if (typeof target !== "string" || target === "") return true;
    if (target === resourceId || target === short || n.dependsOn.includes(resourceId)) return true;
  }
  return graph.edges.some((e) => /autoscal/i.test(e.from) && e.to === resourceId);
}

/* -------------------------------- escalation -------------------------------- */

export type EscalationReason = "inconclusive_diagnosis" | "attempts_exhausted" | "remediation_requires_human" | "unresolved_too_long" | "verification_failed";

export interface EscalationInput {
  now: Date;
  incident: { severity: RiskLevel; openedAt: string; escalatedAt?: string; status: string };
  /** latest investigation outcome, when one exists */
  diagnosis?: { hypotheses: readonly { code: string; confidence: number }[] };
  countedAttempts: number;
  /** gate codes from the most recent blocked proposals */
  blockedCodes: readonly GateCode[];
}

export interface EscalationDecision {
  escalate: boolean;
  reasons: EscalationReason[];
  /** already escalated: nothing new to record */
  alreadyEscalated: boolean;
}

export function isInconclusive(policy: StabilityPolicy, diagnosis: EscalationInput["diagnosis"]): boolean {
  if (!diagnosis) return false;
  const known = diagnosis.hypotheses.filter((h) => h.code !== "unknown");
  if (known.length === 0) return true;
  return Math.max(...known.map((h) => h.confidence)) < policy.remediation.minConfidence;
}

export function decideEscalation(policy: StabilityPolicy, input: EscalationInput): EscalationDecision {
  const reasons: EscalationReason[] = [];
  if (input.incident.status === "resolved") return { escalate: false, reasons, alreadyEscalated: Boolean(input.incident.escalatedAt) };
  if (isInconclusive(policy, input.diagnosis)) reasons.push("inconclusive_diagnosis");
  if (input.countedAttempts >= policy.remediation.maxAttemptsPerIncident || input.blockedCodes.includes("attempts_exhausted")) reasons.push("attempts_exhausted");
  if (input.blockedCodes.some((c) => c === "blast_radius_exceeded" || c === "risk_too_high" || c === "autoscaler_conflict")) reasons.push("remediation_requires_human");
  const age = input.now.getTime() - ms(input.incident.openedAt);
  const limit = input.incident.severity === "critical" ? policy.escalation.criticalUnresolvedAfterMs : policy.escalation.unresolvedAfterMs;
  if (age >= limit) reasons.push("unresolved_too_long");
  return { escalate: reasons.length > 0, reasons, alreadyEscalated: Boolean(input.incident.escalatedAt) };
}

/* -------------------------------- postmortem -------------------------------- */

export interface PostmortemInput {
  incident: {
    id: string;
    title: string;
    severity: string;
    source: string;
    openedAt: string;
    resolvedAt: string;
    occurrenceCount: number;
    escalatedAt?: string;
    escalationReasons: readonly string[];
  };
  investigations: readonly {
    id: string;
    startedAt: string;
    hypotheses: readonly { code: string; title: string; confidence: number; supportingEvidence: readonly string[] }[];
    notes?: readonly string[];
  }[];
  attempts: readonly (AttemptView & { operationId?: string; settledAt?: string; blockCodes?: readonly string[] })[];
  blocked: readonly { capability: string; resourceId?: string; at: string; codes: readonly string[] }[];
}

export interface PostmortemDocument {
  version: 1;
  incidentId: string;
  summary: string;
  durationMs: number;
  rootCause: { status: "identified" | "undetermined"; code?: string; title?: string; confidence?: number; evidence: string[] };
  timeline: { at: string; kind: string; detail: string }[];
  remediation: { attempts: number; succeeded: number; failed: number; blocked: number };
  escalation: { escalated: boolean; at?: string; reasons: string[] };
  followUps: string[];
}

/** Built only from stored facts: no model text, no free-form input. */
export function buildPostmortem(policy: StabilityPolicy, p: PostmortemInput): PostmortemDocument {
  const rankedOf = (inv: PostmortemInput["investigations"][number]) => [...inv.hypotheses].filter((h) => h.code !== "unknown").sort((a, b) => b.confidence - a.confidence || (a.code < b.code ? -1 : 1))[0];
  const latest = [...p.investigations].sort((a, b) => ms(b.startedAt) - ms(a.startedAt))[0];
  const top = latest ? rankedOf(latest) : undefined;
  const identified = top !== undefined && top.confidence >= policy.remediation.minConfidence;

  const timeline: PostmortemDocument["timeline"] = [
    { at: p.incident.openedAt, kind: "opened", detail: `Opened from ${p.incident.source} at severity ${p.incident.severity}.` },
    ...p.investigations.map((i) => ({ at: i.startedAt, kind: "investigated", detail: rankedOf(i) ? `Leading hypothesis ${rankedOf(i)!.code} (confidence ${rankedOf(i)!.confidence}).` : "No hypothesis reached the confidence threshold." })),
    ...p.attempts.map((a) => ({ at: a.reservedAt, kind: `attempt_${a.status}`, detail: `${a.capability}${a.resourceId ? ` on ${a.resourceId}` : ""}${a.operationId ? ` (operation ${a.operationId})` : ""}.` })),
    ...p.blocked.map((b) => ({ at: b.at, kind: "proposal_blocked", detail: `${b.capability}${b.resourceId ? ` on ${b.resourceId}` : ""} held back: ${b.codes.join(", ")}.` })),
    ...(p.incident.escalatedAt ? [{ at: p.incident.escalatedAt, kind: "escalated", detail: `Escalated to a person: ${p.incident.escalationReasons.join(", ") || "unspecified"}.` }] : []),
    { at: p.incident.resolvedAt, kind: "resolved", detail: "Observations stayed healthy past the clear threshold." },
  ].sort((a, b) => ms(a.at) - ms(b.at) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  const counted = p.attempts.filter((a) => a.status !== "abandoned");
  const succeeded = counted.filter((a) => a.status === "succeeded").length;
  const failed = counted.filter((a) => a.status === "failed").length;
  const followUps: string[] = [];
  if (!identified) followUps.push("The cause was not established. Add or repair the telemetry behind the checks that returned unknown, then re-run the investigation.");
  if (failed > 0) followUps.push("At least one repair attempt failed. Review the failed operations before adding more automation for this problem.");
  if (p.blocked.length > 0) followUps.push("Safety limits held back some proposals. Check whether the limits or the underlying capacity need to change.");
  if (p.incident.occurrenceCount > 1) followUps.push(`The problem was seen ${p.incident.occurrenceCount} times while open; consider a permanent fix or a tuned alert.`);
  if (p.incident.escalatedAt) followUps.push("The incident needed a person. Record what the person did so it can be considered for a bounded automatic repair.");

  const durationMs = Math.max(0, ms(p.incident.resolvedAt) - ms(p.incident.openedAt));
  return {
    version: 1,
    incidentId: p.incident.id,
    summary: `${p.incident.title}: open for ${Math.round(durationMs / 60_000)} minutes, ${counted.length} repair attempt${counted.length === 1 ? "" : "s"}, ${identified ? `cause ${top!.code}` : "cause undetermined"}.`,
    durationMs,
    rootCause: identified ? { status: "identified", code: top!.code, title: top!.title, confidence: top!.confidence, evidence: [...top!.supportingEvidence].slice(0, 25) } : { status: "undetermined", evidence: [] },
    timeline,
    remediation: { attempts: counted.length, succeeded, failed, blocked: p.blocked.length },
    escalation: { escalated: Boolean(p.incident.escalatedAt), ...(p.incident.escalatedAt ? { at: p.incident.escalatedAt } : {}), reasons: [...p.incident.escalationReasons] },
    followUps,
  };
}
