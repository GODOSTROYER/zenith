/**
 * How good is the evidence behind a price? (ADR-0013)
 *
 * Every cost line may carry `priceVerification`, how the unit price was
 * obtained. The placement workstream adds that field to `CostLine`; it is
 * re-declared here as an additive intersection so these components type-check
 * both before and after that contract lands (same union, same optional field).
 *
 * Three classes are WEAK and always flagged on the line that uses them:
 *   model_knowledge      a remembered list price, not read from any price feed
 *   derived              arithmetic on other catalog numbers
 *   internal_assumption  a Zenith planning price, not a published rate
 * A line with no `priceVerification` is not called weak (that would be a claim);
 * it says its source was not recorded, which is what is actually known.
 *
 * Nothing here turns an estimate into a quote: callers label every total an estimate.
 */
import type { CostEstimate, CostLine } from "@/lib/placement/types";
import { humanizeToken } from "./text";

export type PriceVerification =
  | "official_api"
  | "official_page"
  | "third_party_mirror"
  | "derived"
  | "model_knowledge"
  | "internal_assumption";

export type PricedCostLine = CostLine & { priceVerification?: PriceVerification };
export type PricedCostEstimate = Omit<CostEstimate, "lines"> & { lines: PricedCostLine[] };

export interface EvidenceClass {
  label: string;
  weak: boolean;
  sentence: string;
}

export const PRICE_EVIDENCE: Record<PriceVerification, EvidenceClass> = {
  official_api: { label: "Official price feed", weak: false, sentence: "Read from the provider's own price API." },
  official_page: { label: "Official pricing page", weak: false, sentence: "Taken from the provider's official pricing page." },
  third_party_mirror: {
    label: "Third-party mirror",
    weak: false,
    sentence: "Read from a third-party mirror of the provider's price data, not from the provider directly.",
  },
  derived: { label: "Derived price", weak: true, sentence: "Calculated from other catalog prices; it is not a published rate." },
  model_knowledge: {
    label: "Remembered price",
    weak: true,
    sentence: "Not read from any price feed and may be out of date. Refresh it before relying on it.",
  },
  internal_assumption: {
    label: "Zenith assumption",
    weak: true,
    sentence: "A Zenith planning price, not a published rate.",
  },
};

/** "Remembered price" -> "remembered price" for use mid-sentence, but "Zenith assumption" stays as is. */
export function midSentence(label: string): string {
  return label.startsWith("Zenith") ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

export const NO_SOURCE: EvidenceClass = {
  label: "Source not recorded",
  weak: false,
  sentence: "The estimate did not record where this price came from, so its quality is unknown.",
};

export function evidenceFor(line: Pick<PricedCostLine, "priceVerification">): EvidenceClass {
  return line.priceVerification ? PRICE_EVIDENCE[line.priceVerification] : NO_SOURCE;
}

export const isWeakLine = (line: Pick<PricedCostLine, "priceVerification">): boolean => evidenceFor(line).weak;

export interface WeakSummary {
  total: number;
  weak: number;
  /** share of the monthly total that rests on weak prices, 0..100; undefined when the total is zero */
  weakSharePercent: number | undefined;
  classes: PriceVerification[];
}

export function summarizeWeakEvidence(estimate: Pick<PricedCostEstimate, "lines" | "monthlyUsd">): WeakSummary {
  const weakLines = estimate.lines.filter(isWeakLine);
  const weakUsd = weakLines.reduce((sum, l) => sum + (Number.isFinite(l.monthlyUsd) ? l.monthlyUsd : 0), 0);
  const classes = [...new Set(weakLines.map((l) => l.priceVerification).filter((v): v is PriceVerification => Boolean(v)))];
  return {
    total: estimate.lines.length,
    weak: weakLines.length,
    weakSharePercent: estimate.monthlyUsd > 0 ? Math.round((weakUsd / estimate.monthlyUsd) * 100) : undefined,
    classes,
  };
}

const UNIT_LABEL: Record<string, string> = {
  hour: "per hour",
  month: "per month",
  gb_month: "per GB-month",
  gb: "per GB",
  million_requests: "per million requests",
  iops_month: "per IOPS-month",
  request: "per request",
  ratio: "multiplier",
};

export const unitLabel = (unit: string): string => UNIT_LABEL[unit] ?? humanizeToken(unit).toLowerCase();

/** Unit prices are often fractions of a cent: keep significant digits, never fewer than two decimals. */
export function fmtUnitUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  const trimmed = n.toFixed(6).replace(/0+$/, "");
  const [int, frac = ""] = trimmed.split(".");
  return `$${int}.${frac.padEnd(2, "0")}`;
}
