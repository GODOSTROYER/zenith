/**
 * Offline refresh pipeline: verified saved snapshots -> observations -> merged,
 * validated, dated catalog. No network, clock or environment access.
 */
import type { PriceCatalog } from "@/lib/placement/types";
import { applyRefresh, type RefreshReport } from "@/lib/placement/catalog-refresh/merge";
import { normalizeAws } from "@/lib/placement/catalog-refresh/normalize-aws";
import { normalizeAzure } from "@/lib/placement/catalog-refresh/normalize-azure";
import { normalizeGcp } from "@/lib/placement/catalog-refresh/normalize-gcp";
import { normalizeOci } from "@/lib/placement/catalog-refresh/normalize-oci";
import { RefreshError, type NormalizeContext, type Normalizer, type PriceObservation, type Skipped, type SnapshotEntry, type SnapshotFormat } from "@/lib/placement/catalog-refresh/types";
import type { LoadedSnapshot } from "@/lib/placement/catalog-refresh/snapshots";
import { verifySnapshotBytes } from "@/lib/placement/catalog-refresh/snapshots";

const NORMALIZERS: Record<SnapshotFormat, Normalizer> = {
  aws_price_list: normalizeAws,
  gcp_billing_catalog: normalizeGcp,
  azure_retail_prices: normalizeAzure,
  oci_price_list: normalizeOci,
};

export interface RefreshFromSnapshotsInput {
  base: PriceCatalog;
  snapshots: readonly LoadedSnapshot[];
  version: string;
  maxChangeRatio?: number;
  allowLargeChanges?: boolean;
}

export interface RefreshOutput {
  catalog: PriceCatalog;
  report: RefreshReport;
  /** targets the rules looked for in a file but did not guess */
  skipped: Skipped[];
}

export function refreshFromSnapshots(input: RefreshFromSnapshotsInput): RefreshOutput {
  const observations: PriceObservation[] = [];
  const skipped: Skipped[] = [];
  for (const loaded of input.snapshots) {
    // Re-verify here too: callers may build LoadedSnapshot values without the directory loader.
    verifySnapshotBytes(loaded.entry, Buffer.from(loaded.text, "utf8"));
    const regions = [...new Set(input.base.entries.filter((e) => e.provider === loaded.entry.provider).map((e) => e.region))].sort();
    const ctx: NormalizeContext = { regions };
    const out = NORMALIZERS[loaded.entry.format](loaded.text, loaded.entry, ctx);
    observations.push(...out.observations);
    skipped.push(...out.skipped);
  }
  if (observations.length === 0) throw new RefreshError("validation", "No price could be read from the snapshots; refusing to publish a catalog that refreshed nothing.");
  const entries: SnapshotEntry[] = input.snapshots.map((s) => s.entry);
  const { catalog, report } = applyRefresh({
    base: input.base,
    observations,
    snapshots: entries,
    version: input.version,
    ...(input.maxChangeRatio !== undefined ? { maxChangeRatio: input.maxChangeRatio } : {}),
    ...(input.allowLargeChanges !== undefined ? { allowLargeChanges: input.allowLargeChanges } : {}),
  });
  return { catalog, report, skipped };
}

/** Days between the catalog's newest source retrieval and `now`. */
export function catalogAgeDays(catalog: PriceCatalog, now: Date): number {
  const latest = catalog.sources.map((s) => s.retrievedAt).sort().at(-1) ?? "1970-01-01";
  return Math.floor((now.getTime() - Date.parse(`${latest}T00:00:00.000Z`)) / 86_400_000);
}
