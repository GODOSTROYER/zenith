/**
 * Catalog refresh contracts (PROD-COST-01).
 *
 * A refresh turns SAVED official provider price files into a new, dated catalog
 * version. The pipeline is: saved file (bytes + SHA-256 in a manifest) ->
 * provider normalizer -> `PriceObservation[]` -> `applyRefresh` (merge with the
 * previous catalog, flag large changes, validate) -> new `PriceCatalog` that
 * records which files it came from. Nothing in this folder except `fetch.ts`
 * can touch a network, and `fetch.ts` is gated and never imported by tests.
 */
import type { PriceEntry, PriceTier } from "@/lib/placement/types";

export const REFRESH_PROVIDERS = ["aws", "gcp", "azure", "oci"] as const;
export type RefreshProvider = (typeof REFRESH_PROVIDERS)[number];

export const SNAPSHOT_FORMATS = ["aws_price_list", "gcp_billing_catalog", "azure_retail_prices", "oci_price_list"] as const;
export type SnapshotFormat = (typeof SNAPSHOT_FORMATS)[number];

/** One saved official price file, as listed in `manifest.json` next to it. */
export interface SnapshotEntry {
  provider: RefreshProvider;
  format: SnapshotFormat;
  /** the provider service the file prices, e.g. `AmazonVPC`, `Compute Engine`, `Virtual Network` */
  service: string;
  /** provider region the file is for; absent for global files (OCI) */
  region?: string;
  /** the official endpoint or file the bytes came from */
  url: string;
  /** YYYY-MM-DD the bytes were retrieved */
  retrievedAt: string;
  sha256: string;
  bytes: number;
  /** path relative to the manifest */
  file: string;
}

export interface SnapshotManifest {
  schema: 1;
  snapshots: SnapshotEntry[];
}

export interface PriceObservation {
  provider: RefreshProvider;
  region: string;
  sku: string;
  unit: PriceEntry["unit"];
  usd: number;
  tiers?: PriceTier[];
  /** what exactly was read, shown in the catalog entry note */
  note: string;
  /** SHA-256 of the saved file this came from */
  snapshotSha256: string;
}

export interface Skipped {
  sku: string;
  region: string;
  reason: string;
}

export interface NormalizeResult {
  observations: PriceObservation[];
  /** targets the rules looked for but would not guess: no match, ambiguous, or out of range */
  skipped: Skipped[];
}

export interface NormalizeContext {
  /** regions to emit for providers whose price file is global (OCI) */
  regions: readonly string[];
}

export type Normalizer = (text: string, snapshot: SnapshotEntry, ctx: NormalizeContext) => NormalizeResult;

export class RefreshError extends Error {
  constructor(
    readonly code: "integrity" | "format" | "version" | "validation" | "gate",
    message: string,
  ) {
    super(message);
    this.name = "RefreshError";
  }
}
