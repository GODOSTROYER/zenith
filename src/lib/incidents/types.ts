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
}
