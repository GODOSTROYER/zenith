/**
 * Plan catalog (PROD-MAN-06, decided by DEC-BUSINESS).
 *
 * Launch packages approved by the owner on 2026-10-13: Explore, Builder, Team and Enterprise. The price is modelled
 * explicitly (`pricing`) instead of as a base fee plus per-meter rates:
 *
 *   free           Explore. Never produces a charge.
 *   usage_minimum  Builder and Team. Monthly total = max(minimum, ZCU-hours x rate), in exact integer cents (see invoice.ts).
 *   contract       Enterprise. Billed by contract outside Zenith; the catalog never prices it.
 *
 * ZCU: 1 ZCU-hour = one resource managed by Zenith for one hour. That is exactly the existing `managed_resource_hours`
 * meter. Build minutes and storage are INCLUDED in the plan and never billed separately; they stay bounded by fair-use hard
 * caps that refuse NEW work at the cap and never produce a charge.
 *
 * Live charging stays OFF: billing is disabled by default and the Stripe provider refuses live keys (test mode only) until a
 * payment account and a terms review exist. See PLAN_NOTICE.
 */
export const BILLABLE_METERS = ["managed_resource_hours", "build_minutes", "storage_gb_month"] as const;
export type BillableMeter = (typeof BILLABLE_METERS)[number];

/** Recorded and shown, never charged: an estimate is not a measurement. */
export const INFORMATIONAL_METERS = ["operations_executed", "egress_gb_estimated"] as const;
export type InformationalMeter = (typeof INFORMATIONAL_METERS)[number];

export type Meter = BillableMeter | InformationalMeter;
export const METERS: readonly Meter[] = [...BILLABLE_METERS, ...INFORMATIONAL_METERS];
export const isMeter = (value: unknown): value is Meter => typeof value === "string" && (METERS as readonly string[]).includes(value);
export const isBillableMeter = (value: unknown): value is BillableMeter => typeof value === "string" && (BILLABLE_METERS as readonly string[]).includes(value);

export const METER_UNITS: Readonly<Record<Meter, string>> = {
  managed_resource_hours: "ZCU-hour",
  build_minutes: "minute",
  storage_gb_month: "GB",
  operations_executed: "operation",
  egress_gb_estimated: "GB (estimate)",
};

/** The meter that is the ZCU: one resource managed by Zenith for one hour. */
export const ZCU_METER: BillableMeter = "managed_resource_hours";
export const ZCU_DEFINITION = "1 ZCU-hour = one resource managed by Zenith for one hour.";

/** True for a meter whose value is modeled (COST estimate) rather than read from a durable record of what happened. */
export const ESTIMATED_METERS: ReadonlySet<Meter> = new Set<Meter>(["egress_gb_estimated"]);

export const PRICING_DECISION = Object.freeze({ decision: "DEC-BUSINESS", approvedBy: "Arnav Bule", approvedAt: "2026-10-13" } as const);

export const PLAN_NOTICE = "Launch pricing was approved on 2026-10-13. Charging is not live: Zenith only talks to the payment provider in test mode until the payment account and terms review are complete.";

export interface MeterAllowance {
  /** quantity included in the plan for one period (ZCU meter: the usage the monthly minimum covers; 0 where there is none) */
  included: number;
  /** US cents per unit beyond `included`; non-zero only for the ZCU meter on a usage_minimum plan (display only: `pricing` is authoritative) */
  rateCents: number;
  /** current-period usage at or above this refuses NEW work (never reads or export); undefined = no hard cap. Fair-use limit, never a charge. */
  hardCap?: number;
}

export type PlanPricing =
  | { kind: "free" }
  /** `zcuRateMillicents` is thousandths of a US cent per ZCU-hour: 1500 = 1.5 cents = $0.015. */
  | { kind: "usage_minimum"; minimumCents: number; zcuRateMillicents: number }
  | { kind: "contract" };

export type DeploymentOption = "planning" | "customer_cloud" | "zenith_hosted" | "contract";
export type SupportLevel = "docs" | "email" | "priority_email" | "contract";

export interface PlanEntitlements {
  /** deploy, day-two, remediation and runner work. Planning, previews, estimates and reads are never gated. */
  deploy: boolean;
  approvals: "preview" | "full";
  /** organizational policies and team approval workflows (workspace policy edits) */
  orgPolicies: boolean;
  deploymentOptions: readonly DeploymentOption[];
  support: SupportLevel;
}

/** The comparison table, one display string per row, worded as the owner decision words it. */
export interface PackageDisplay {
  bestFor: string;
  monthlyPrice: string;
  includedUsage: string;
  additionalUsage: string;
  planningAndEstimates: string;
  deployment: string;
  approvalsAndAudit: string;
  orgPolicies: string;
  deploymentOptions: string;
  support: string;
}

export const PACKAGE_ROWS: readonly { key: keyof PackageDisplay; label: string }[] = Object.freeze([
  { key: "bestFor", label: "Best for" },
  { key: "monthlyPrice", label: "Monthly price" },
  { key: "includedUsage", label: "Included management usage" },
  { key: "additionalUsage", label: "Additional management usage" },
  { key: "planningAndEstimates", label: "Architecture planning and cost estimates" },
  { key: "deployment", label: "Application deployment and ongoing management" },
  { key: "approvalsAndAudit", label: "Deployment approvals and audit records" },
  { key: "orgPolicies", label: "Organizational policies and team approval workflows" },
  { key: "deploymentOptions", label: "Deployment options" },
  { key: "support", label: "Support" },
]);

export interface PlanDefinition {
  id: string;
  /** Capacity tier selected by this billing assignment. */
  managedTier: import("@/lib/providers/zenith/types").PlanTier;
  name: string;
  /** false for every launch package: the prices are decided (see PRICING_DECISION) */
  provisional: boolean;
  decision: "DEC-BUSINESS";
  pricing: PlanPricing;
  /**
   * Queued + running operations at once (in addition to the platform's own OPS-02 quota). Fair-use limit (3 / 15 / 60),
   * adjustable. null = no catalog limit (Enterprise: set by contract).
   */
  maxActiveOperations: number | null;
  meters: Readonly<Record<BillableMeter, MeterAllowance>>;
  entitlements: PlanEntitlements;
  display: PackageDisplay;
}

function deepFreeze(plan: PlanDefinition): PlanDefinition {
  const meters = Object.freeze(Object.fromEntries(Object.entries(plan.meters).map(([k, v]) => [k, Object.freeze({ ...v })]))) as PlanDefinition["meters"];
  return Object.freeze({
    ...plan, meters, pricing: Object.freeze({ ...plan.pricing }),
    entitlements: Object.freeze({ ...plan.entitlements, deploymentOptions: Object.freeze([...plan.entitlements.deploymentOptions]) }),
    display: Object.freeze({ ...plan.display }),
  });
}

const ZCU_RATE_MILLICENTS = 1500;
const ZCU_RATE_CENTS = ZCU_RATE_MILLICENTS / 1000;
/** ZCU-hours the monthly minimum covers: minimum / rate (29.00 / 0.015 = 1933.33...). Display only. */
const coveredZcuHours = (minimumCents: number): number => Math.round(((minimumCents * 1000) / ZCU_RATE_MILLICENTS) * 100) / 100;

// Fair-use limits (hard caps, concurrency). The owner set the monthly build-minute and storage caps on 2026-10-14
// (Explore 300 min / 20 GB, Builder 2,000 min / 100 GB, Team 10,000 min / 500 GB, Enterprise by contract); concurrency
// (3 / 15 / 60) is unchanged. They refuse new work at the cap; they never charge.
export const PLANS: Readonly<Record<string, PlanDefinition>> = Object.freeze({
  explore: deepFreeze({
    id: "explore", managedTier: "free", name: "Explore", provisional: false, decision: "DEC-BUSINESS", pricing: { kind: "free" }, maxActiveOperations: 3,
    meters: {
      managed_resource_hours: { included: 0, rateCents: 0 },
      build_minutes: { included: 0, rateCents: 0, hardCap: 300 },
      storage_gb_month: { included: 0, rateCents: 0, hardCap: 20 },
    },
    entitlements: { deploy: false, approvals: "preview", orgPolicies: false, deploymentOptions: ["planning"], support: "docs" },
    display: {
      bestFor: "Exploring Zenith", monthlyPrice: "Free", includedUsage: "Limited evaluation", additionalUsage: "None",
      planningAndEstimates: "Limited", deployment: "Not available", approvalsAndAudit: "Preview only", orgPolicies: "Not available",
      deploymentOptions: "Planning and previews", support: "Documentation",
    },
  }),
  builder: deepFreeze({
    id: "builder", managedTier: "starter", name: "Builder", provisional: false, decision: "DEC-BUSINESS",
    pricing: { kind: "usage_minimum", minimumCents: 2900, zcuRateMillicents: ZCU_RATE_MILLICENTS }, maxActiveOperations: 15,
    meters: {
      managed_resource_hours: { included: coveredZcuHours(2900), rateCents: ZCU_RATE_CENTS },
      build_minutes: { included: 2000, rateCents: 0, hardCap: 2000 },
      storage_gb_month: { included: 100, rateCents: 0, hardCap: 100 },
    },
    entitlements: { deploy: true, approvals: "full", orgPolicies: false, deploymentOptions: ["customer_cloud", "zenith_hosted"], support: "email" },
    display: {
      bestFor: "Individuals and small teams", monthlyPrice: "$29/month minimum", includedUsage: "$29/month", additionalUsage: "$0.015 per ZCU-hour",
      planningAndEstimates: "Included", deployment: "Included", approvalsAndAudit: "Included", orgPolicies: "Not available",
      deploymentOptions: "Your cloud or Zenith-hosted", support: "Email support",
    },
  }),
  team: deepFreeze({
    id: "team", managedTier: "pro", name: "Team", provisional: false, decision: "DEC-BUSINESS",
    pricing: { kind: "usage_minimum", minimumCents: 19900, zcuRateMillicents: ZCU_RATE_MILLICENTS }, maxActiveOperations: 60,
    meters: {
      managed_resource_hours: { included: coveredZcuHours(19900), rateCents: ZCU_RATE_CENTS },
      build_minutes: { included: 10000, rateCents: 0, hardCap: 10000 },
      storage_gb_month: { included: 500, rateCents: 0, hardCap: 500 },
    },
    entitlements: { deploy: true, approvals: "full", orgPolicies: true, deploymentOptions: ["customer_cloud", "zenith_hosted"], support: "priority_email" },
    display: {
      bestFor: "Teams managing multiple environments", monthlyPrice: "$199/month minimum", includedUsage: "$199/month", additionalUsage: "$0.015 per ZCU-hour",
      planningAndEstimates: "Included", deployment: "Included", approvalsAndAudit: "Included", orgPolicies: "Included",
      deploymentOptions: "Your cloud or Zenith-hosted", support: "Priority email support",
    },
  }),
  enterprise: deepFreeze({
    id: "enterprise", managedTier: "pro", name: "Enterprise", provisional: false, decision: "DEC-BUSINESS", pricing: { kind: "contract" }, maxActiveOperations: null,
    meters: {
      managed_resource_hours: { included: 0, rateCents: 0 },
      build_minutes: { included: 0, rateCents: 0 },
      storage_gb_month: { included: 0, rateCents: 0 },
    },
    entitlements: { deploy: true, approvals: "full", orgPolicies: true, deploymentOptions: ["contract"], support: "contract" },
    display: {
      bestFor: "Organizations with custom requirements", monthlyPrice: "Custom pricing", includedUsage: "Custom commitment", additionalUsage: "Negotiated rate",
      planningAndEstimates: "Included", deployment: "Included", approvalsAndAudit: "Included", orgPolicies: "Custom configuration",
      deploymentOptions: "Agreed deployment model", support: "Contracted support",
    },
  }),
});

/** Plan ids an earlier catalog wrote into stored rows. Resolved on READ only; never accepted for a new assignment. */
export const LEGACY_PLAN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  free_provisional: "explore",
  team_provisional: "builder",
  scale_provisional: "team",
});

/** What a workspace with no assignment is held to in managed mode. It is never billed: no account, no invoice. */
export const DEFAULT_PLAN_ID = "explore";

/** A CURRENT plan id: the only kind a new assignment may carry. */
export const isPlanId = (value: unknown): value is string => typeof value === "string" && Object.hasOwn(PLANS, value);

/** A stored plan id: a current id or a legacy alias. Use this wherever a stored assignment is read. */
export const isKnownPlanId = (value: unknown): value is string => isPlanId(value) || (typeof value === "string" && Object.hasOwn(LEGACY_PLAN_ALIASES, value));

export const resolvePlanId = (id: string): string => (Object.hasOwn(LEGACY_PLAN_ALIASES, id) ? LEGACY_PLAN_ALIASES[id] : id);

export function getPlan(id: string): PlanDefinition {
  if (!isKnownPlanId(id)) throw new RangeError(`unknown plan ${String(id).slice(0, 64)}`);
  return PLANS[resolvePlanId(id)];
}

/** The cheapest catalog plan that has a feature, for refusal messages ("Builder includes it"). */
export function firstPlanWith(feature: "deploy" | "orgPolicies"): PlanDefinition | undefined {
  return Object.values(PLANS).find((p) => p.entitlements[feature]);
}

export interface PlanView extends PlanDefinition {
  notice: string;
  pricingDecision: typeof PRICING_DECISION;
  zcu: { meter: BillableMeter; unit: string; definition: string };
}
export const planView = (plan: PlanDefinition): PlanView => ({ ...plan, notice: PLAN_NOTICE, pricingDecision: PRICING_DECISION, zcu: { meter: ZCU_METER, unit: "ZCU-hour", definition: ZCU_DEFINITION } });
export const listPlanViews = (): PlanView[] => Object.values(PLANS).map(planView);
