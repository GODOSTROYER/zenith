/**
 * Builders for the platform component tests. Every value is invented for the
 * test; nothing here is a real account, digest or secret. Times are fixed so
 * countdowns and ordering are deterministic.
 */
import type {
  ApprovalRecord,
  OperationRecord,
  PlatformEvent,
  PlatformEventType,
  PolicyDecisionRecord,
} from "@/lib/controlplane/types";
import type { Investigation } from "@/lib/incidents/types";
import type { CostEstimate, PlacementResult } from "@/lib/placement/types";
import type { DriftReport, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import type { PlanView } from "@/lib/tofu/plan";
import type { PricedCostEstimate } from "@/components/platform/price-evidence";

export const NOW = "2026-09-30T12:00:00.000Z";
export const NOW_MS = Date.parse(NOW);
export const SOON = "2026-09-30T12:40:00.000Z";
export const LATER = "2026-09-30T13:00:00.000Z";
export const EARLIER = "2026-09-30T11:00:00.000Z";

export const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
export const DIGEST_2 = "60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752";
export const PLAN_DIGEST = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
export const POLICY_VERSION = "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9";

export function operation(over: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "op_1",
    workspaceId: "ws_1",
    projectId: "proj_1",
    environmentId: "env_prod",
    capability: "infrastructure.apply",
    principal: { kind: "user", id: "user_requester", name: "Riya Shah" },
    status: "awaiting_approval",
    proposal: {
      capability: "infrastructure.apply",
      scope: { workspaceId: "ws_1", projectId: "proj_1", environmentId: "env_prod" },
      input: {},
      summary: "Apply the reviewed plan to production",
      details: ["Changes the web service to 3 tasks", "Replaces the database instance"],
      risk: "high",
      planDigest: PLAN_DIGEST,
      costDeltaUsd: 18.5,
    },
    proposalDigest: DIGEST,
    inputDigest: DIGEST_2,
    planDigest: PLAN_DIGEST,
    approvalRequired: true,
    correlationId: "corr_1",
    createdAt: EARLIER,
    updatedAt: EARLIER,
    expiresAt: SOON,
    ...over,
  };
}

export function decision(over: Partial<PolicyDecisionRecord> = {}): PolicyDecisionRecord {
  return {
    id: "pd_1",
    workspaceId: "ws_1",
    operationId: "op_1",
    policyVersion: POLICY_VERSION,
    inputDigest: DIGEST_2,
    outcome: "require_approval",
    reasons: [
      {
        code: "autonomy_below_capability",
        message: "Environment autonomy level 2 is below the level (5) at which this capability runs without approval.",
        rule: "zenith.rules.approval.autonomy_below_capability",
      },
    ],
    approval: { count: 1, minRole: "editor", separationOfDuties: true },
    evaluatedAt: EARLIER,
    ...over,
  };
}

export function approval(over: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "ap_1",
    operationId: "op_1",
    workspaceId: "ws_1",
    proposalDigest: DIGEST,
    decision: "approve",
    approver: { kind: "user", id: "user_other", name: "Dev Patel" },
    approverRole: "admin",
    policyVersion: POLICY_VERSION,
    createdAt: EARLIER,
    expiresAt: LATER,
    ...over,
  };
}

let seq = 0;
export function event(type: PlatformEventType, over: Partial<PlatformEvent> = {}): PlatformEvent {
  seq += 1;
  return {
    seq,
    id: `evt_${seq}`,
    ts: EARLIER,
    type,
    workspaceId: "ws_1",
    correlationId: "corr_1",
    data: {},
    ...over,
  };
}

export function planView(over: Partial<PlanView> = {}): PlanView {
  return {
    planDigest: PLAN_DIGEST,
    tofuVersion: "1.12.5",
    empty: false,
    summary: { create: 1, update: 1, delete: 0, replace: 1, noop: 3 },
    resources: [
      {
        address: "aws_ecs_service.web",
        nodeAddress: "service/web",
        type: "aws_ecs_service",
        action: "update",
        destroysData: false,
        omittedChanges: 0,
        changes: [
          { path: "desired_count", forcesReplacement: false, before: 2, after: 3 },
          { path: "task_definition", forcesReplacement: false, before: "web:4", after: "(known after apply)" },
          // the view drops values at secret-looking paths: the change is listed with no values
          { path: "environment.DATABASE_PASSWORD", forcesReplacement: false },
        ],
      },
      {
        address: "aws_db_instance.main",
        nodeAddress: "resource/db",
        type: "aws_db_instance",
        action: "replace",
        destroysData: true,
        omittedChanges: 2,
        changes: [
          { path: "engine_version", forcesReplacement: true, before: "15.4", after: "16.1" },
          { path: "password", forcesReplacement: false, before: "(sensitive)", after: "(sensitive)" },
          { path: "tags", forcesReplacement: false },
        ],
      },
      {
        address: "aws_cloudwatch_log_group.app",
        type: "aws_cloudwatch_log_group",
        action: "create",
        destroysData: false,
        omittedChanges: 0,
        changes: [{ path: "retention_in_days", forcesReplacement: false, before: null, after: 30 }],
      },
    ],
    outputs: [
      { name: "service_url", action: "create", sensitive: false },
      { name: "db_connection", action: "create", sensitive: true },
    ],
    diagnostics: [],
    truncated: false,
    untrustedValues: true,
    ...over,
  };
}

export function node(over: Partial<ResourceNode> = {}): ResourceNode {
  return {
    address: "service/web",
    kind: "container_service",
    provider: "aws",
    region: "ap-south-1",
    nativeType: "aws:ecs_service",
    ownership: "managed",
    spec: { replicas: 3, image: "web:4", cpu: 512, health: { path: "/healthz", interval: 30 }, secretEnv: { secretRef: "vault:web/db" } },
    origin: ["service/web"],
    dependsOn: [],
    specDigest: DIGEST,
    labels: {},
    ...over,
  };
}

export function observation(over: Partial<Observation> = {}): Observation {
  return {
    address: "service/web",
    externalId: "arn:aws:ecs:ap-south-1:123456789012:service/web",
    presence: "present",
    attributes: {
      replicas: { state: "known", value: 3, observedAt: NOW },
      image: { state: "known", value: "web:3", observedAt: NOW },
      cpu: { state: "unknown", reason: "access_denied" },
      "health.path": { state: "known", value: "/healthz", observedAt: NOW },
    },
    observedAt: NOW,
    source: "aws.ecs_service@1",
    simulated: false,
    ...over,
  };
}

export function runtime(over: Partial<RuntimeState> = {}): RuntimeState {
  return {
    address: "service/web",
    health: "degraded",
    counts: { desired: 3, running: 2, pending: 1 },
    signals: ["target_unhealthy:2", "task_stopped:OutOfMemory", "crash_loop_backoff"],
    observedAt: NOW,
    source: "aws.ecs_service@1",
    simulated: false,
    ...over,
  };
}

export function driftReport(over: Partial<DriftReport> = {}): DriftReport {
  return {
    environmentId: "env_prod",
    graphDigest: DIGEST,
    computedAt: NOW,
    simulated: false,
    unobserved: ["resource/cache"],
    findings: [
      {
        address: "service/web",
        class: "changed",
        severity: "medium",
        repairable: true,
        autoRepairEligible: true,
        explanation: "The running service uses a different image from the configuration.",
        fields: [
          { attribute: "image", desired: "web:4", observed: "web:3" },
          { attribute: "db_password", desired: "hunter2-desired", observed: "hunter2-observed" },
        ],
      },
      {
        address: "resource/db",
        class: "changed",
        severity: "high",
        repairable: true,
        autoRepairEligible: false,
        explanation: "The database parameter group differs from the configuration.",
      },
      {
        address: "firewall/old",
        class: "extra",
        severity: "low",
        repairable: false,
        autoRepairEligible: false,
        explanation: "A security group exists that the configuration does not mention.",
      },
      {
        address: "dns_record/app",
        class: "missing",
        severity: "high",
        repairable: true,
        autoRepairEligible: false,
        explanation: "The DNS record is not present at the provider.",
      },
    ],
    ...over,
  };
}

export function investigation(over: Partial<Investigation> = {}): Investigation {
  return {
    id: "inv_1",
    workspaceId: "ws_1",
    environmentId: "env_prod",
    startedAt: EARLIER,
    finishedAt: NOW,
    simulated: false,
    path: [
      { hop: "dns", address: "dns_record/app", status: "healthy" },
      { hop: "load_balancer", address: "load_balancer/main", status: "healthy" },
      { hop: "firewall", address: "firewall/web-to-db", status: "failing" },
      { hop: "database", address: "resource/db", status: "unknown" },
    ],
    evidence: [
      {
        id: "ev_1",
        hop: "firewall",
        address: "firewall/web-to-db",
        check: "aws.ec2.DescribeSecurityGroups",
        outcome: "fail",
        finding: "The database security group does not allow port 5432 from the web service.",
        observedAt: NOW,
        data: {},
        simulated: false,
      },
      {
        id: "ev_2",
        hop: "load_balancer",
        address: "load_balancer/main",
        check: "aws.elbv2.DescribeTargetHealth",
        outcome: "pass",
        finding: "All load balancer targets are healthy.",
        observedAt: NOW,
        data: {},
        simulated: false,
      },
      {
        id: "ev_3",
        hop: "database",
        address: "resource/db",
        check: "aws.rds.DescribeDBInstances",
        outcome: "unknown",
        finding: "The observe role is not allowed to describe the database.",
        observedAt: NOW,
        data: {},
        simulated: false,
      },
    ],
    hypotheses: [
      {
        id: "h_low",
        code: "deploy_regression",
        title: "The latest deployment introduced a regression",
        confidence: 0.18,
        category: "deployment",
        supportingEvidence: ["ev_3"],
        contradictingEvidence: ["ev_2"],
        remediations: [],
      },
      {
        id: "h_high",
        code: "db_unreachable_security_group",
        title: "The database security group blocks the web service",
        confidence: 0.82,
        category: "configuration",
        supportingEvidence: ["ev_1", "ev_missing"],
        contradictingEvidence: [],
        remediations: [
          {
            id: "rem_1",
            title: "Allow the web service to reach the database on port 5432",
            request: {
              capability: "firewall.modify",
              scope: { workspaceId: "ws_1", environmentId: "env_prod" },
            },
            risk: "high",
            approvalRequired: true,
            reversibility: "Reversible: the added rule can be removed.",
            expectedEffect: "The web service can open connections to the database again.",
          },
        ],
      },
    ],
    recentChanges: [{ at: EARLIER, kind: "deployment", summary: "Revision r7 was deployed" }],
    ...over,
  };
}

export function estimate(over: Partial<PricedCostEstimate> = {}): PricedCostEstimate {
  return {
    kind: "estimate",
    catalogVersion: "2026-09-30.1",
    currency: "USD",
    monthlyUsd: 120,
    computedAt: NOW,
    assumptions: { egressGb: 50, requestsMillions: 5 },
    included: ["NAT gateway hours", "Public IPv4 addresses"],
    excluded: ["Data transfer between regions", "Support plan"],
    lines: [
      {
        address: "service/web",
        description: "Container service compute",
        sku: "aws.fargate.vcpu_hour",
        quantity: 730,
        unit: "hour",
        unitUsd: 0.04048,
        monthlyUsd: 29.55,
        basis: "730 h/month x 1 task x 1 vCPU",
        priceVerification: "official_api",
      },
      {
        address: "resource/cache",
        description: "Cache node",
        sku: "aws.elasticache_redis.node_hour",
        quantity: 730,
        unit: "hour",
        unitUsd: 0.068,
        monthlyUsd: 49.64,
        basis: "730 h/month x 1 node",
        priceVerification: "model_knowledge",
      },
      {
        address: "resource/db",
        description: "Database storage",
        sku: "aws.rds.storage_gb_month",
        quantity: 20,
        unit: "gb_month",
        unitUsd: 0.115,
        monthlyUsd: 2.3,
        basis: "20 GB",
        priceVerification: "derived",
      },
      {
        address: "zenith/managed",
        description: "Managed tier",
        sku: "zenith.managed.month",
        quantity: 1,
        unit: "month",
        unitUsd: 38.51,
        monthlyUsd: 38.51,
        basis: "1 managed environment",
        priceVerification: "internal_assumption",
      },
    ],
    ...over,
  };
}

/** A contract `CostEstimate` (no `priceVerification`), as the placement module returns before it adds the field. */
export function plainEstimate(): CostEstimate {
  const e = estimate();
  return { ...e, lines: e.lines.map(({ priceVerification: _omit, ...rest }) => rest) };
}

export function placementResult(over: Partial<PlacementResult> = {}): PlacementResult {
  const chosen = {
    id: "cand_aws_mumbai",
    assignments: {
      "service/web": { provider: "aws", region: "ap-south-1", nativeType: "aws:ecs_service" },
      "resource/db": { provider: "aws", region: "ap-south-1", nativeType: "aws:rds_instance" },
    },
    cost: estimate(),
    latencyMs: { india: 38 },
    crossBoundary: [],
    score: 41.25,
    scoreBreakdown: { cost: 30.5, latency: 10.75 },
    warnings: [],
  };
  const alt = {
    id: "cand_cross_cloud",
    assignments: {
      "service/web": { provider: "aws", region: "ap-south-1", nativeType: "aws:ecs_service" },
      "resource/db": { provider: "azure", region: "centralindia", nativeType: "azure:postgres_flexible" },
    },
    cost: { ...estimate({ monthlyUsd: 98.4 }), lines: estimate().lines.slice(0, 1) },
    latencyMs: { india: 61 },
    crossBoundary: [{ from: "service/web", to: "resource/db", kind: "cross_cloud" as const, egressUsdMonthly: 4.5, addedLatencyMs: 23 }],
    score: 57.9,
    scoreBreakdown: { cost: 25, latency: 22.9, cross_cloud: 10 },
    warnings: ["Traffic between the web service and the database leaves AWS and is billed as egress."],
  };
  return {
    chosen,
    alternatives: [alt],
    rejected: [{ id: "cand_us_east", reasons: ["Violates the India data residency requirement."] }],
    assumptions: ["50 GB of internet egress per month."],
    catalogVersion: "2026-09-30.1",
    deterministicSeed: "seed-7f3a",
    ...over,
  };
}
