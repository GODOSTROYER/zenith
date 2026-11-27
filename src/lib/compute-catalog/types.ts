/**
 * Native compute offers, separate from the existing manifest size aliases.
 * A catalog is evidence of an offer, never a promise of account eligibility,
 * available capacity, or application performance. Money stays decimal text.
 */
export type ComputeProvider = "aws" | "gcp" | "azure";
export type ComputeArchitecture = "x86_64" | "arm64" | "unknown";
export type ComputeCpuMode = "sustained" | "burstable" | "shared" | "unknown";

export type ComputeSnapshotKind =
  | "aws_ec2_prices"
  | "aws_instance_types"
  | "aws_instance_offerings"
  | "gcp_machine_types"
  | "gcp_skus"
  | "azure_resource_skus"
  | "azure_retail_prices";

export interface SourceEvidence {
  kind: ComputeSnapshotKind;
  /** Public source location without credentials or an authenticated query. */
  url: string;
  /** Full ISO-8601 timestamp. Fetch time is distinct from the effective price. */
  retrievedAt: string;
  /** SHA-256 of the imported native data, when recorded by the importer. */
  sha256?: string;
}

/** Operator-provided, native API response. Pagination must be completed by the collector. */
export interface RawComputeSnapshot extends SourceEvidence {
  region?: string;
  data: unknown;
}

export interface ComputeOffer {
  /** Stable provider/location/type key. Distinct zones remain distinct offers. */
  id: string;
  provider: ComputeProvider;
  region: string;
  zone?: string;
  instanceType: string;
  vcpus: number;
  memoryMiB: number;
  architecture: ComputeArchitecture;
  cpuMode: ComputeCpuMode;
  operatingSystem: "linux";
  tenancy: "shared";
  purchaseModel: "on_demand";
  price: {
    /** Public USD per VM-hour. No currency conversion or discounts implied. */
    hourlyUsd: string;
    source: SourceEvidence;
    nativeSku?: string;
    effectiveAt?: string;
  } | null;
  specSource: SourceEvidence;
  /** A pricing record alone does not establish a regional hardware offering. */
  offeringState: "offered" | "catalog_only";
  warnings: string[];
}

export interface ComputeCatalogCoverage {
  provider: ComputeProvider;
  /** Only regions represented in the supplied source data. */
  regions: string[];
  offerCount: number;
  pricedOfferCount: number;
  /** Counts describe imported scopes; they never establish global coverage. */
  scope: "imported_snapshots";
  warnings: string[];
}

export interface ComputeCatalog {
  schemaVersion: 1;
  version: string;
  generatedAt: string;
  sources: SourceEvidence[];
  coverage: ComputeCatalogCoverage[];
  offers: ComputeOffer[];
  warnings: string[];
}

export interface NormalizeComputeOptions {
  version: string;
  generatedAt: string;
}
