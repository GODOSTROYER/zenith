/**
 * Hypothesis rules, as data (spec §21, ADR-0014).
 *
 * A rule is a list of weighted CLAUSES over evidence, not code. A clause names
 * a check, the outcome it must have, and optionally exact `data` values; it is
 * satisfied when at least one evidence record matches. For each rule:
 *
 *   confidence = clamp( Σ weight(satisfied `requires`)
 *                     − Σ weight(satisfied `contradicts`), 0, cap ≤ 1 )
 *
 * rounded to three places. A rule only FIRES when at least one of its
 * `anchors` is satisfied, so side evidence alone (targets unhealthy, a recent
 * deploy) can never create a hypothesis. `unknown` evidence satisfies no
 * clause: an unread check neither supports nor contradicts, it just leaves the
 * confidence lower than if it had been read.
 *
 * Ranking is confidence descending, then code ascending: deterministic, with
 * no model in the loop. Only hypotheses at or above `HYPOTHESIS_THRESHOLD`
 * (0.3) are reported; when nothing reaches it and there is something to
 * explain, the `unknown` fallback says so instead of inventing a cause.
 *
 * Honest limit: the weights are engineering judgement, not fitted to data. They
 * are chosen so a typical textbook failure (the specific cause, its logs and
 * its symptom) lands at 0.8+ and any single indicator alone stays below that.
 * A confidence is "how much of the expected evidence was seen", not a
 * probability.
 */
import type { Evidence, Hypothesis, HypothesisBasis } from "./types";

export const HYPOTHESIS_THRESHOLD = 0.3;
export const UNKNOWN_CONFIDENCE = 0.2;

export interface EvidenceMatcher {
  /** exact `Evidence.check` */
  check: string;
  outcome: Evidence["outcome"];
  /** every key must equal the evidence's `data` value (scalars only) */
  data?: Record<string, string | number | boolean>;
}

export interface RuleClause {
  id: string;
  match: EvidenceMatcher;
  weight: number;
  note: string;
  /**
   * The clause is void while any evidence matches this. Used so that one
   * passing rule does not contradict a diagnosis while a sibling rule of the
   * same class (the :80 rule beside a missing :443 rule) is failing.
   */
  unless?: EvidenceMatcher;
}

export interface HypothesisRule {
  code: string;
  title: string;
  category: Hypothesis["category"];
  requires: readonly RuleClause[];
  contradicts: readonly RuleClause[];
  /** clause ids of which at least one must be satisfied for the rule to fire */
  anchors: readonly string[];
  /** confidence ceiling for deliberately generic rules */
  cap?: number;
}

const clause = (id: string, check: string, outcome: Evidence["outcome"], weight: number, note: string, data?: EvidenceMatcher["data"], unless?: EvidenceMatcher): RuleClause => ({
  id,
  match: { check, outcome, ...(data ? { data } : {}) },
  weight,
  note,
  ...(unless ? { unless } : {}),
});

/** A passing ingress rule of a class does not clear the diagnosis while another rule of that class fails. */
const rulePresent = (klass: string, noun: string): RuleClause =>
  clause("rule_present", "firewall.ingress_rule", "pass", 0.5, `the ingress rule to the ${noun} is present and matches`, { protects: klass }, { check: "firewall.ingress_rule", outcome: "fail", data: { protects: klass } });

/* --------------------------- shared symptom clauses -------------------------- */

const targetsUnhealthy = (w: number) => clause("targets_unhealthy", "lb.target_health", "fail", w, "the load balancer reports unhealthy targets");
const tasksShort = (w: number) => clause("tasks_short", "service.running_vs_desired", "fail", w, "fewer tasks are running than desired");
const recentDeploy = (w: number) => clause("recent_deploy", "changes.recent", "pass", w, "a deployment or apply happened recently", { recentDeployment: true });

/* --------------------------- unreachable-by-network -------------------------- */

function unreachableRule(klass: "database" | "cache", code: string, title: string, noun: string, prefix: "db" | "cache"): HypothesisRule {
  return {
    code,
    title,
    category: "drift",
    requires: [
      clause("rule_missing", "firewall.ingress_rule", "fail", 0.45, `the ingress rule to the ${noun} is missing or changed`, { protects: klass }),
      clause("connect_timeout", `logs.${prefix}_connect_timeout`, "fail", 0.3, `the application logs connection timeouts to the ${noun}`),
      targetsUnhealthy(0.1),
      clause("errors_5xx", "lb.http_5xx", "fail", 0.05, "the load balancer is serving 5xx responses"),
      clause("drift_missing", "drift.missing", "fail", 0.1, "the drift report lists the ingress rule as missing", { nodeKind: "firewall", protects: klass }),
      clause("drift_changed", "drift.changed", "fail", 0.1, "the drift report lists the ingress rule as changed", { nodeKind: "firewall", protects: klass }),
    ],
    contradicts: [
      clause("store_down", `${prefix}.available`, "fail", 0.4, `the ${noun} itself is unhealthy, which explains timeouts without a network rule`, { health: "unhealthy" }),
      clause("store_missing", `${prefix}.exists`, "fail", 0.4, `the ${noun} does not exist`),
      rulePresent(klass, noun),
    ],
    anchors: ["rule_missing", "connect_timeout"],
  };
}

/* ------------------------------------ rules --------------------------------- */

export const RULES: readonly HypothesisRule[] = [
  unreachableRule("database", "db_unreachable_security_group", "The application cannot reach its database: the ingress rule that allows it was removed or changed", "database", "db"),
  unreachableRule("cache", "cache_unreachable_security_group", "The application cannot reach its cache: the ingress rule that allows it was removed or changed", "cache", "cache"),
  {
    code: "service_unreachable_security_group",
    title: "The load balancer cannot reach the service: the ingress rule that allows it was removed or changed",
    category: "drift",
    requires: [
      clause("rule_missing", "firewall.ingress_rule", "fail", 0.5, "the ingress rule from the load balancer to the service is missing or changed", { protects: "service" }),
      clause("none_healthy", "lb.target_health", "fail", 0.3, "no registered target is healthy", { noHealthy: true }),
      clause("some_unhealthy", "lb.target_health", "fail", 0.15, "some registered targets are unhealthy", { noHealthy: false }),
      clause("errors_5xx", "lb.http_5xx", "fail", 0.05, "the load balancer is serving 5xx responses"),
      clause("drift_missing", "drift.missing", "fail", 0.1, "the drift report lists the ingress rule as missing", { nodeKind: "firewall", protects: "service" }),
      clause("drift_changed", "drift.changed", "fail", 0.1, "the drift report lists the ingress rule as changed", { nodeKind: "firewall", protects: "service" }),
    ],
    contradicts: [rulePresent("service", "service")],
    anchors: ["rule_missing"],
  },
  {
    code: "public_ingress_blocked",
    title: "The internet cannot reach the load balancer: the public ingress rule was removed or changed",
    category: "drift",
    requires: [
      clause("rule_missing", "firewall.ingress_rule", "fail", 0.55, "a public ingress rule to the load balancer is missing or changed", { protects: "internet" }),
      clause("unreachable", "http.endpoint", "fail", 0.3, "the prober could not reach the public endpoint"),
      clause("drift_missing", "drift.missing", "fail", 0.1, "the drift report lists the public ingress rule as missing", { nodeKind: "firewall", protects: "internet" }),
      clause("drift_changed", "drift.changed", "fail", 0.1, "the drift report lists the public ingress rule as changed", { nodeKind: "firewall", protects: "internet" }),
    ],
    contradicts: [clause("endpoint_ok", "http.endpoint", "pass", 0.5, "the public endpoint answered"), rulePresent("internet", "load balancer")],
    anchors: ["rule_missing"],
  },
  {
    code: "db_down",
    title: "The database is down or not available",
    category: "dependency",
    requires: [
      clause("db_unhealthy", "db.available", "fail", 0.55, "the database status is unhealthy", { health: "unhealthy" }),
      clause("db_degraded", "db.available", "fail", 0.25, "the database status is degraded", { health: "degraded" }),
      clause("db_missing", "db.exists", "fail", 0.55, "the database does not exist at the provider"),
      clause("db_unavailable_logs", "logs.db_unavailable", "fail", 0.15, "the application logs the database refusing connections"),
      clause("refused", "logs.db_connect_refused", "fail", 0.15, "the application logs connection refusals from the database"),
      clause("timeout", "logs.db_connect_timeout", "fail", 0.1, "the application logs connection timeouts to the database"),
      targetsUnhealthy(0.1),
    ],
    contradicts: [clause("db_available", "db.available", "pass", 0.5, "the database reports available")],
    anchors: ["db_unhealthy", "db_degraded", "db_missing"],
  },
  {
    code: "bad_deploy",
    title: "A recent deployment introduced the failure",
    category: "deployment",
    requires: [
      recentDeploy(0.25),
      clause("errors_after", "changes.errors_after_deploy", "fail", 0.35, "known error signatures first appear or increase after the rollout"),
      clause("rollout_failed", "service.rollout", "fail", 0.5, "the rollout failed (circuit breaker or failed rollout check)"),
      clause("tasks_stopped", "service.stopped_tasks", "fail", 0.1, "tasks stopped abnormally"),
      targetsUnhealthy(0.05),
    ],
    contradicts: [
      clause("no_recent_deploy", "changes.recent", "pass", 0.2, "no deployment or apply happened recently", { recentDeployment: false }),
      clause("errors_not_new", "changes.errors_after_deploy", "pass", 0.2, "error signatures are not new after the rollout"),
    ],
    anchors: ["errors_after", "rollout_failed"],
  },
  {
    code: "container_crash_oom",
    title: "The service's containers are being killed for running out of memory",
    category: "runtime",
    requires: [
      clause("oom_stop", "service.stopped_tasks", "fail", 0.5, "tasks were stopped for out-of-memory (or exit 137)", { oom: true }),
      clause("oom_logs", "logs.oom", "fail", 0.25, "the application logs out-of-memory errors"),
      tasksShort(0.1),
      clause("memory_high", "capacity.memory", "fail", 0.15, "memory utilization is high"),
      targetsUnhealthy(0.05),
    ],
    contradicts: [clause("image_pull", "service.image_pull", "fail", 0.3, "the container never started because its image could not be pulled")],
    anchors: ["oom_stop", "oom_logs"],
  },
  {
    code: "image_pull_failure",
    title: "The container image cannot be pulled",
    category: "deployment",
    requires: [
      clause("pull_failed", "service.image_pull", "fail", 0.65, "the image pull failed"),
      tasksShort(0.1),
      clause("rollout_failed", "service.rollout", "fail", 0.1, "the rollout failed"),
      recentDeploy(0.1),
    ],
    contradicts: [],
    anchors: ["pull_failed"],
  },
  {
    code: "missing_secret",
    title: "A required secret or configuration value is missing or wrong",
    category: "configuration",
    requires: [
      clause("secret_missing", "secret.present", "fail", 0.5, "a referenced secret does not exist"),
      clause("secret_error", "secret.resolution_error", "fail", 0.3, "the workload failed to fetch a secret"),
      clause("missing_env", "logs.missing_env", "fail", 0.4, "the application logs a missing environment variable"),
      clause("auth_failure", "logs.db_auth_failure", "fail", 0.3, "the application logs rejected credentials"),
      tasksShort(0.1),
      clause("tasks_stopped", "service.stopped_tasks", "fail", 0.05, "tasks stopped abnormally"),
    ],
    contradicts: [],
    anchors: ["secret_missing", "secret_error", "missing_env", "auth_failure"],
  },
  {
    code: "iam_denied",
    title: "The workload identity is denied an action it needs",
    category: "identity",
    requires: [
      clause("denied", "identity.access_denied", "fail", 0.6, "the workload logs access-denied errors"),
      clause("identity_missing", "identity.exists", "fail", 0.4, "the workload identity does not exist"),
      clause("drift_changed", "drift.changed", "fail", 0.15, "the identity drifted from the desired graph", { nodeKind: "identity" }),
      clause("drift_missing", "drift.missing", "fail", 0.15, "the identity is missing versus the desired graph", { nodeKind: "identity" }),
      tasksShort(0.05),
      targetsUnhealthy(0.05),
    ],
    contradicts: [],
    anchors: ["denied", "identity_missing"],
  },
  {
    code: "dns_misconfigured",
    title: "The DNS record is missing or points at the wrong target",
    category: "configuration",
    requires: [
      clause("record_missing", "dns.record_present", "fail", 0.55, "the DNS record does not exist"),
      clause("record_target", "dns.record_target", "fail", 0.55, "the DNS record points at the wrong target"),
      clause("resolution", "http.dns_resolution", "fail", 0.45, "the public host name does not resolve"),
      clause("drift_missing", "drift.missing", "fail", 0.1, "the drift report lists the record as missing", { nodeKind: "dns_record" }),
      clause("drift_changed", "drift.changed", "fail", 0.1, "the drift report lists the record as changed", { nodeKind: "dns_record" }),
    ],
    contradicts: [clause("resolves", "http.dns_resolution", "pass", 0.5, "the host name resolved and answered")],
    anchors: ["record_missing", "record_target", "resolution"],
  },
  {
    code: "certificate_invalid",
    title: "The TLS certificate is not issued, expired, or about to expire",
    category: "configuration",
    requires: [
      clause("not_issued", "tls.certificate_issued", "fail", 0.55, "the certificate is not issued"),
      clause("expiry", "tls.certificate_expiry", "fail", 0.5, "the certificate is expired or within 14 days of expiry"),
      clause("handshake", "http.tls_handshake", "fail", 0.45, "a TLS handshake to the public host failed"),
      clause("tls_logs", "logs.tls_error", "fail", 0.1, "the application logs TLS errors"),
    ],
    contradicts: [clause("handshake_ok", "http.tls_handshake", "pass", 0.15, "a TLS handshake to the public host succeeded")],
    anchors: ["not_issued", "expiry", "handshake"],
  },
  {
    code: "dependency_unavailable",
    title: "A cache, queue or object store the service depends on is unavailable",
    category: "dependency",
    requires: [
      clause("cache_down", "cache.available", "fail", 0.55, "the cache is unhealthy"),
      clause("cache_missing", "cache.exists", "fail", 0.55, "the cache does not exist"),
      clause("queue_down", "queue.available", "fail", 0.55, "the queue is unhealthy"),
      clause("queue_missing", "queue.exists", "fail", 0.55, "the queue does not exist"),
      clause("storage_missing", "storage.exists", "fail", 0.55, "the object store does not exist"),
      clause("cache_refused", "logs.cache_connect_refused", "fail", 0.15, "the application logs connection refusals from the cache"),
      targetsUnhealthy(0.05),
    ],
    contradicts: [],
    anchors: ["cache_down", "cache_missing", "queue_down", "queue_missing", "storage_missing"],
  },
  {
    code: "lb_no_healthy_targets",
    title: "The load balancer has no healthy targets",
    category: "runtime",
    requires: [
      clause("none_healthy", "lb.target_health", "fail", 0.4, "no registered target is healthy", { noHealthy: true }),
      clause("some_unhealthy", "lb.target_health", "fail", 0.2, "some registered targets are unhealthy", { noHealthy: false }),
      clause("tasks_running", "service.running_vs_desired", "pass", 0.05, "the tasks are running, so health checks rather than process death are failing"),
      clause("errors_5xx", "lb.http_5xx", "fail", 0.05, "the load balancer is serving 5xx responses"),
    ],
    contradicts: [],
    anchors: ["none_healthy", "some_unhealthy"],
    cap: 0.5,
  },
  {
    code: "capacity_saturation",
    title: "The service is saturated: CPU or memory is high with all tasks running",
    category: "capacity",
    requires: [
      clause("cpu", "capacity.cpu", "fail", 0.35, "CPU utilization is high"),
      clause("memory", "capacity.memory", "fail", 0.35, "memory utilization is high"),
      clause("steady", "service.running_vs_desired", "pass", 0.15, "all desired tasks are running"),
      clause("errors_5xx", "lb.http_5xx", "fail", 0.1, "the load balancer is serving 5xx responses"),
      clause("logs_5xx", "logs.http_5xx", "fail", 0.1, "the application logs a burst of 5xx"),
    ],
    contradicts: [clause("oom_stop", "service.stopped_tasks", "fail", 0.3, "tasks are being killed for memory, which is a crash, not saturation", { oom: true })],
    anchors: ["cpu", "memory"],
  },
];

/* --------------------------------- evaluation ------------------------------- */

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function matches(e: Evidence, m: EvidenceMatcher): boolean {
  if (e.check !== m.check || e.outcome !== m.outcome) return false;
  if (m.data) for (const [k, v] of Object.entries(m.data)) if (e.data?.[k] !== v) return false;
  return true;
}

export interface ScoredRule {
  rule: HypothesisRule;
  confidence: number;
  fired: boolean;
  basis: HypothesisBasis[];
  supporting: string[];
  contradicting: string[];
}

/** Score one rule against the evidence. Pure. */
export function scoreRule(rule: HypothesisRule, evidence: readonly Evidence[]): ScoredRule {
  const basis: HypothesisBasis[] = [];
  const satisfied = new Set<string>();
  const order = new Map(evidence.map((e, i) => [e.id, i]));
  let support = 0;
  let against = 0;
  const supporting = new Set<string>();
  const contradicting = new Set<string>();

  for (const [kind, clauses] of [["supports", rule.requires], ["contradicts", rule.contradicts]] as const) {
    for (const c of clauses) {
      if (c.unless && evidence.some((e) => matches(e, c.unless!))) continue;
      const ids = evidence.filter((e) => matches(e, c.match)).map((e) => e.id);
      if (ids.length === 0) continue;
      satisfied.add(c.id);
      ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      basis.push({ clause: c.id, kind, weight: c.weight, note: c.note, evidence: ids.slice(0, 10) });
      for (const id of ids) (kind === "supports" ? supporting : contradicting).add(id);
      if (kind === "supports") support += c.weight;
      else against += c.weight;
    }
  }
  const fired = rule.anchors.some((a) => satisfied.has(a));
  const raw = fired ? Math.min(Math.max(support - against, 0), rule.cap ?? 1) : 0;
  const byOrder = (a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  return {
    rule,
    confidence: round3(raw),
    fired,
    basis,
    supporting: [...supporting].sort(byOrder),
    contradicting: [...contradicting].sort(byOrder),
  };
}

/**
 * Score every rule and return the hypotheses that reach the threshold, ranked
 * by confidence (descending) then code (ascending). When none does and there is
 * something to explain, the `unknown` fallback is returned alone.
 */
export function rankHypotheses(evidence: readonly Evidence[], opts: { hasSymptom?: boolean } = {}, rules: readonly HypothesisRule[] = RULES): Hypothesis[] {
  const scored = rules.map((r) => scoreRule(r, evidence)).filter((s) => s.fired && s.confidence >= HYPOTHESIS_THRESHOLD);
  scored.sort((a, b) => b.confidence - a.confidence || cmp(a.rule.code, b.rule.code));
  if (scored.length > 0)
    return scored.map((s) => ({
      id: `hyp:${s.rule.code}`,
      code: s.rule.code,
      title: s.rule.title,
      confidence: s.confidence,
      category: s.rule.category,
      supportingEvidence: s.supporting,
      contradictingEvidence: s.contradicting,
      remediations: [],
      basis: s.basis,
    }));

  const failing = evidence.filter((e) => e.outcome === "fail").map((e) => e.id);
  const unknowns = evidence.filter((e) => e.outcome === "unknown").map((e) => e.id);
  if (failing.length === 0 && unknowns.length === 0 && !opts.hasSymptom) return [];
  const title =
    failing.length > 0
      ? `${failing.length} failing check${failing.length === 1 ? "" : "s"} that no known rule explains`
      : unknowns.length > 0
        ? `${unknowns.length} check${unknowns.length === 1 ? "" : "s"} could not be completed, so the cause cannot be established`
        : "No fault was found on the checked request path";
  return [
    {
      id: "hyp:unknown",
      code: "unknown",
      title,
      confidence: UNKNOWN_CONFIDENCE,
      category: "unknown",
      supportingEvidence: [...failing, ...unknowns].slice(0, 25),
      contradictingEvidence: evidence.filter((e) => e.outcome === "pass").map((e) => e.id).slice(0, 25),
      remediations: [],
      basis: [],
    },
  ];
}
