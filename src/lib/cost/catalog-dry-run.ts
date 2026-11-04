import type { PriceCatalog } from "@/lib/placement/types";
import { loadSnapshotDirectory } from "@/lib/placement/catalog-refresh/snapshots";
import { refreshFromSnapshots } from "@/lib/placement/catalog-refresh/refresh";
import { formatRefreshReport } from "@/lib/placement/catalog-refresh/merge";

/** Checks saved official files and returns a candidate for review. Never downloads or writes. */
export function dryRunCatalogRefresh(base: PriceCatalog, directory: string, version: string) {
  const result = refreshFromSnapshots({ base, snapshots: loadSnapshotDirectory(directory), version });
  return { ...result, dryRun: true as const, adoptionRequired: true as const, summary: formatRefreshReport(result.report) };
}
