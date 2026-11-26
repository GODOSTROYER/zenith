import { createHash } from "node:crypto";
import type { ComputeArchitecture, ComputeOffer, RawComputeSnapshot, SourceEvidence } from "./types";

export type ObjectValue = Record<string, unknown>;
export interface ProviderNormalization { offers: ComputeOffer[]; warnings: string[] }
export const USD_SCALE = 1_000_000_000_000n;

export function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}
export function rows(value: unknown): ObjectValue[] { return Array.isArray(value) ? value.map(object) : []; }
export function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
export function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
export function numberValue(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
export function architecture(value: unknown): ComputeArchitecture {
  if (value === "x86_64" || value === "X86_64" || value === "x64") return "x86_64";
  if (value === "arm64" || value === "ARM64" || value === "Arm64") return "arm64";
  return "unknown";
}

/** Exact fixed decimal arithmetic. Unsupported sub-picodollar precision is not rounded into zero. */
export function decimalUnits(value: unknown): bigint | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) return undefined;
  let s = String(value);
  if (/e/i.test(s)) {
    const match = s.match(/^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
    if (!match) return undefined;
    const exponent = Number(match[3]);
    if (Math.abs(exponent) > 24) return undefined;
    const digits = match[1]! + (match[2] ?? "");
    const point = match[1]!.length + exponent;
    s = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const m = s.match(/^(\d{1,18})(?:\.(\d{1,12}))?$/);
  if (!m) return undefined;
  return BigInt(m[1]!) * USD_SCALE + BigInt((m[2] ?? "").padEnd(12, "0"));
}
export function decimalText(units: bigint): string {
  const fraction = (units % USD_SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  return `${units / USD_SCALE}${fraction ? `.${fraction}` : ""}`;
}
export function googleMoney(value: unknown): bigint | undefined {
  const money = object(value);
  if (money.currencyCode !== "USD") return undefined;
  const units = money.units ?? "0";
  const nanos = money.nanos ?? 0;
  if (!/^\d{1,12}$/.test(String(units)) || !Number.isInteger(nanos) || Number(nanos) < 0 || Number(nanos) > 999_999_999) return undefined;
  return BigInt(String(units)) * USD_SCALE + BigInt(Number(nanos)) * 1000n;
}
export function source(snapshot: RawComputeSnapshot): SourceEvidence {
  return {
    kind: snapshot.kind,
    url: snapshot.url,
    retrievedAt: snapshot.retrievedAt,
    sha256: snapshot.sha256 ?? createHash("sha256").update(JSON.stringify(snapshot.data)).digest("hex"),
  };
}
export function offerId(provider: string, region: string, instanceType: string, zone?: string): string {
  return [provider, region, zone ?? "regional", instanceType, "linux", "shared", "on_demand"].join(":");
}
export function effectiveTime(value: unknown, asOf: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time > Date.parse(asOf)) return undefined;
  return new Date(time).toISOString();
}
export function isFutureOrInvalid(value: unknown, asOf: string): boolean {
  return value !== undefined && value !== null && value !== "" && effectiveTime(value, asOf) === undefined;
}

/** Select the newest effective version of a meter, then refuse conflicting parallel meters. */
export interface PriceCandidate {
  /** Null is an observed but unsupported meter version; an older valid price must not replace it. */
  amount: bigint | null;
  source: SourceEvidence;
  nativeSku: string;
  effectiveAt?: string;
}
export function resolvePrice(candidates: PriceCandidate[]): { price: ComputeOffer["price"]; warning?: string } {
  if (!candidates.length) return { price: null, warning: "No supported public Linux shared On-Demand hourly price was found." };
  const byMeter = new Map<string, PriceCandidate[]>();
  for (const candidate of candidates) {
    const group = byMeter.get(candidate.nativeSku) ?? [];
    group.push(candidate);
    byMeter.set(candidate.nativeSku, group);
  }
  const current = [...byMeter.values()].flatMap(group => {
    const newest = group.map(c => c.effectiveAt ?? "").sort().at(-1)!;
    return group.filter(c => (c.effectiveAt ?? "") === newest);
  });
  if (current.some(c => c.amount === null)) return { price: null, warning: "The current eligible meter has an unsupported price, currency, unit, or tier; no historical price was substituted." };
  if (new Set(current.map(c => c.amount!.toString())).size !== 1) return { price: null, warning: "Conflicting eligible price meters; no minimum price was guessed." };
  const selected = [...current].sort((a, b) => a.nativeSku.localeCompare(b.nativeSku) || Date.parse(b.source.retrievedAt) - Date.parse(a.source.retrievedAt) || a.source.url.localeCompare(b.source.url))[0]!;
  if (selected.amount === null) return { price: null };
  return { price: { hourlyUsd: decimalText(selected.amount), source: selected.source, nativeSku: selected.nativeSku, ...(selected.effectiveAt ? { effectiveAt: selected.effectiveAt } : {}) } };
}

export function uniqueOffers(offers: ComputeOffer[]): ComputeOffer[] {
  const result = new Map<string, ComputeOffer>();
  for (const offer of offers) {
    const old = result.get(offer.id);
    if (!old) { result.set(offer.id, offer); continue; }
    if (old.vcpus !== offer.vcpus || old.memoryMiB !== offer.memoryMiB || old.architecture !== offer.architecture || old.cpuMode !== offer.cpuMode) {
      throw new Error(`Conflicting hardware snapshots for ${offer.id}. Import one consistent snapshot revision.`);
    }
    if (old.price?.hourlyUsd !== offer.price?.hourlyUsd) {
      old.price = null;
      old.warnings.push("Conflicting prices across inventory records; this offer is unpriced.");
    } else if (old.price && offer.price && Date.parse(offer.price.source.retrievedAt) > Date.parse(old.price.source.retrievedAt)) {
      old.price = offer.price;
    }
    if (old.offeringState !== offer.offeringState) {
      old.offeringState = "catalog_only";
      old.warnings.push("Inventory records disagree on offering restrictions; only catalog presence is established.");
    }
    if (Date.parse(offer.specSource.retrievedAt) > Date.parse(old.specSource.retrievedAt)) old.specSource = offer.specSource;
    old.warnings = [...new Set([...old.warnings, ...offer.warnings])].sort();
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}
