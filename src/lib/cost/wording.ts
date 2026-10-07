/**
 * The words Zenith uses about money (PROD-COST-01/02).
 *
 * Three different things are never mixed up:
 * - an ESTIMATE is modeled from list prices and stated usage assumptions;
 * - a FORECAST projects spend already observed at the cloud provider;
 * - ACTUAL SPEND is what the provider's billing data reported for a closed or
 *   still-open period (and is provisional until the period closes).
 *
 * None of them is a spending cap. Zenith does not stop, throttle or delete
 * anything because a number crossed a budget, and it cannot promise what a
 * provider will bill. A budget in Zenith is a planning limit on an ESTIMATE:
 * plans are checked against it before they are deployed.
 */

export const COST_KINDS = ["estimate", "forecast", "actual_spend"] as const;
export type CostKindName = (typeof COST_KINDS)[number];

export const COST_KIND_LABEL: Readonly<Record<CostKindName, string>> = {
  estimate: "Estimate",
  forecast: "Forecast",
  actual_spend: "Actual spend",
};

export const ESTIMATE_NOTICE =
  "This is an estimate modeled from list prices and stated usage assumptions. It is not an invoice, a quote or a limit on what your cloud provider will bill.";

export const BUDGET_NOTICE =
  "A budget is a planning limit on estimated list-price cost. Zenith checks plans against it before you deploy; it does not stop or cap what your cloud provider bills.";

export const FORECAST_NOTICE =
  "This forecast projects spend already reported by the cloud provider. Provider billing data lags and is revised, so the projection can be wrong and is not a limit.";

export const ACTUAL_SPEND_NOTICE =
  "This is spend reported by the cloud provider's billing data. It is provisional until the billing period closes and may exclude charges not yet processed.";

/** Phrases that claim a hard limit. */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:hard|strict|firm|enforced)\s+(?:spend(?:ing)?|billing|budget|cost)?\s*(?:cap|limit|ceiling)\b/i,
  /\b(?:spend(?:ing)?|billing|budget|cost)\s+(?:cap|ceiling)\b/i,
  /\bcapped\s+at\b/i,
  /\bwill\s+(?:never|not)\s+(?:spend|cost|bill|charge)\s+(?:more|over|above|beyond)\b/i,
  /\bguarantee[sd]?\b[^.]{0,40}\b(?:cost|price|bill|spend)\b/i,
  /\bwon'?t\s+(?:exceed|go\s+over)\b/i,
  /\bcannot\s+exceed\b/i,
];

const NEGATION = /\b(?:not|never|no|none|nothing|isn'?t|aren'?t|doesn'?t|can'?t|without|neither|nor)\b/i;

/**
 * Sentences that present an estimate, forecast or budget as a hard billing cap.
 * A sentence that denies it ("is not a spending cap") is fine. The claim phrase
 * itself is removed before the denial check, so a negation that is part of the
 * claim phrase cannot rescue the sentence. Pure; used by the wording guard test
 * over UI and API copy, and available to callers that assemble user-facing text.
 */
export function findCapClaims(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  const hits: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence;
    let claimed = false;
    for (const pattern of CLAIM_PATTERNS) {
      if (pattern.test(rest)) {
        claimed = true;
        rest = rest.replace(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'), ' ');
      }
    }
    if (claimed && !NEGATION.test(rest)) hits.push(sentence.trim());
  }
  return hits;
}

/** The standard disclosure that travels with a recommendation or estimate response. */
export interface CostDisclosure {
  kind: "estimate";
  isBillingCap: false;
  notice: string;
  budgetNotice: string;
}

export function costDisclosure(): CostDisclosure {
  return { kind: "estimate", isBillingCap: false, notice: ESTIMATE_NOTICE, budgetNotice: BUDGET_NOTICE };
}
