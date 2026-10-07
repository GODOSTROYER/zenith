/**
 * Plan catalog (PROD-MAN-06). EVERY plan here is PROVISIONAL.
 *
 * Pricing, terms and payment accounts are an undecided commercial matter (DEC-BUSINESS, PROD-MAN-07). These
 * placeholders exist so metering, quotas, plan assignment, invoicing and suspension can be built and tested end to end.
 * The numbers are not offers, not a price list and not advice; nothing may present them as such. A plan id always ends in
 * `_provisional` and every view of a plan carries `provisional: true` and `PLAN_NOTICE`, so replacing them with decided
 * plans is a catalog change that no caller can miss.
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
  managed_resource_hours: "resource-hour",
  build_minutes: "minute",
  storage_gb_month: "GB",
  operations_executed: "operation",
  egress_gb_estimated: "GB (estimate)",
};

/** True for a meter whose value is modeled (COST estimate) rather than read from a durable record of what happened. */
export const ESTIMATED_METERS: ReadonlySet<Meter> = new Set<Meter>(["egress_gb_estimated"]);

export const PLAN_NOTICE = "Provisional placeholder plan. Pricing, terms and payment accounts are not decided (DEC-BUSINESS); these figures are not an offer.";

export interface MeterAllowance {
  /** quantity included in the base fee for one period */
  included: number;
  /** US cents per unit beyond `included` (fractions of a cent allowed; the line total is rounded once) */
  rateCents: number;
  /** current-period usage at or above this refuses NEW work (never reads or export); undefined = no hard cap */
  hardCap?: number;
}

export interface PlanDefinition {
  id: string;
  name: string;
  provisional: true;
  decision: "DEC-BUSINESS";
  /** base fee per period, US cents */
  baseCents: number;
  /** queued + running operations at once (in addition to the platform's own OPS-02 quota) */
  maxActiveOperations: number;
  meters: Readonly<Record<BillableMeter, MeterAllowance>>;
}

const freeze = (plan: PlanDefinition): PlanDefinition => Object.freeze({ ...plan, meters: Object.freeze({ ...plan.meters }) });

export const PLANS: Readonly<Record<string, PlanDefinition>> = Object.freeze({
  free_provisional: freeze({
    id: "free_provisional", name: "Free (provisional)", provisional: true, decision: "DEC-BUSINESS", baseCents: 0, maxActiveOperations: 3,
    meters: {
      managed_resource_hours: { included: 750, rateCents: 0, hardCap: 1500 },
      build_minutes: { included: 100, rateCents: 0, hardCap: 300 },
      storage_gb_month: { included: 5, rateCents: 0, hardCap: 20 },
    },
  }),
  team_provisional: freeze({
    id: "team_provisional", name: "Team (provisional)", provisional: true, decision: "DEC-BUSINESS", baseCents: 2900, maxActiveOperations: 15,
    meters: {
      managed_resource_hours: { included: 5000, rateCents: 0.5 },
      build_minutes: { included: 1000, rateCents: 1 },
      storage_gb_month: { included: 50, rateCents: 10 },
    },
  }),
  scale_provisional: freeze({
    id: "scale_provisional", name: "Scale (provisional)", provisional: true, decision: "DEC-BUSINESS", baseCents: 19900, maxActiveOperations: 60,
    meters: {
      managed_resource_hours: { included: 40000, rateCents: 0.4 },
      build_minutes: { included: 10000, rateCents: 0.8 },
      storage_gb_month: { included: 500, rateCents: 8 },
    },
  }),
});

/** What a workspace with no assignment is held to in managed mode. It is never billed: no account, no invoice. */
export const DEFAULT_PLAN_ID = "free_provisional";

export const isPlanId = (value: unknown): value is string => typeof value === "string" && Object.hasOwn(PLANS, value);

export function getPlan(id: string): PlanDefinition {
  if (!isPlanId(id)) throw new RangeError(`unknown plan ${String(id).slice(0, 64)}`);
  return PLANS[id];
}

export interface PlanView extends PlanDefinition { notice: string }
export const planView = (plan: PlanDefinition): PlanView => ({ ...plan, notice: PLAN_NOTICE });
export const listPlanViews = (): PlanView[] => Object.values(PLANS).map(planView);
