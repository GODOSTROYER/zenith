/**
 * Incident investigation contract (spec §21, ADR-0014).
 *
 * A deterministic toolkit: traverse the environment's resource graph along
 * the request path (DNS → load balancer → firewall → compute → container →
 * application → database), run bounded read-only probes at each hop, and
 * produce hypotheses that cite evidence. Confidence is computed from which
 * checks passed/failed — a rule, not a model's guess. A model may narrate
 * the result; it cannot add evidence.
 */
import type { CapabilityRequest } from "@/lib/capabilities/catalog";

export type Hop =
  | "dns"
  | "tls"
  | "load_balancer"
  | "firewall"
  | "compute"
  | "container"
  | "application"
  | "database"
  | "cache"
  | "queue"
  /** object stores: no compute, only "does it exist and can it be reached" */
  | "storage"
  | "secret"
  | "identity"
  | "deployment"
  | "drift";

export interface Evidence {
  id: string;
  hop: Hop;
  address?: string;
  /** the exact read-only check that produced it, e.g. `aws.elbv2.DescribeTargetHealth` */
  check: string;
  outcome: "pass" | "fail" | "unknown";
  /** what was observed, in plain words, from data (not interpretation) */
  finding: string;
  observedAt: string;
  /** bounded structured data (target states, SG rules, log excerpts — redacted) */
  data: Record<string, unknown>;
  simulated: boolean;
  /**
   * Additive. Which backend answered (`aws.cloudwatch-logs`, a driver id, …),
   * as reported by the port. Optional: a derived check has no single source.
   */
  source?: string;
}

/** Additive. Why the policy dry-run decided what it did, for the approver. */
export interface RemediationPolicy {
  /** `unavailable`: the dry-run port failed; approval is then assumed REQUIRED (fail closed) */
  outcome: "allow" | "require_approval" | "deny" | "unavailable";
  /** stable reason codes from the decision, never free text from a model */
  reasons: string[];
}

export interface RemediationOption {
  id: string;
  title: string;
  /** the exact capability request that would perform it */
  request: CapabilityRequest;
  risk: "low" | "medium" | "high" | "critical";
  /** from a policy dry-run, not assumed */
  approvalRequired: boolean;
  /** can it be undone, and how */
  reversibility: string;
  expectedEffect: string;
  /**
   * Additive. How much else the change can touch. `risk` is floored by the
   * capability catalog (a drift repair is never below `high`); this says how
   * narrow this particular use is (e.g. one firewall rule → `low`).
   */
  blastRadius?: "low" | "medium" | "high";
  /** Additive. The dry-run outcome `approvalRequired` was derived from. */
  policy?: RemediationPolicy;
  /**
   * Additive. True when the request cannot run without a person supplying
   * something Zenith must never hold (a secret value). The request then names
   * the reference only; `manualSteps` says what to do.
   */
  humanInputRequired?: boolean;
  /** Additive. What a person does, in order, for the parts no capability can do. */
  manualSteps?: string[];
}

/** Additive. One weighted clause of a rule and the evidence that satisfied it. */
export interface HypothesisBasis {
  clause: string;
  kind: "supports" | "contradicts";
  weight: number;
  note: string;
  evidence: string[];
}

export interface Hypothesis {
  id: string;
  /** stable code, e.g. `db_unreachable_security_group` */
  code: string;
  title: string;
  /** 0..1 from the rule's evidence weights */
  confidence: number;
  /** is it drift from desired state, a runtime failure, or a bad deploy? */
  category: "drift" | "runtime" | "deployment" | "configuration" | "capacity" | "dependency" | "identity" | "unknown";
  supportingEvidence: string[];
  contradictingEvidence: string[];
  remediations: RemediationOption[];
  /**
   * Additive. The satisfied clauses behind `confidence`, so the number can be
   * re-derived by hand: supports add their weight, contradicts subtract it,
   * the sum is clamped to 0..1 (and to the rule's cap, if it has one).
   */
  basis?: HypothesisBasis[];
  /** Additive. Read-only follow-ups for a person when no capability applies. */
  nextSteps?: string[];
  /**
   * Additive. Proposals the stability gate refused (cooldown, attempt or
   * blast-radius limit, maintenance window, autoscaler conflict, ...), with the
   * stable codes. They are never offered as remediations.
   */
  suppressedRemediations?: SuppressedRemediation[];
}

export interface SuppressedRemediation {
  id: string;
  title: string;
  codes: string[];
  messages: string[];
  /** ISO time a time-based block lifts */
  retryAfter?: string;
  /** a person must act */
  escalate: boolean;
}

/** Additive. Set when no safe automatic next step exists and a person must take over. */
export interface InvestigationEscalation {
  required: boolean;
  reasons: string[];
}

export interface Investigation {
  id: string;
  incidentId?: string;
  workspaceId: string;
  environmentId: string;
  startedAt: string;
  finishedAt: string;
  /** the hops traversed, in order, with their status */
  path: { hop: Hop; address?: string; status: "healthy" | "failing" | "unknown" }[];
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  /** what changed recently: deployments, applies, drift, config */
  recentChanges: { at: string; kind: string; summary: string; operationId?: string }[];
  simulated: boolean;
  /** Additive. The entry point the path was computed from. */
  entry?: { address: string; kind: string };
  /** Additive. The reported symptom, redacted and bounded; data, never instructions. */
  symptom?: string;
  /** Additive. Plain-language limits of this run (a port missing, a window truncated). */
  notes?: string[];
  /** Additive. Escalation derived by rule: inconclusive diagnosis, or a limit that needs a person. */
  escalation?: InvestigationEscalation;
}
