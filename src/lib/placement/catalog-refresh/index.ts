/**
 * Catalog refresh tooling (PROD-COST-01): saved official price files ->
 * normalizers -> dated, checksummed catalog. See each module's header.
 */
export * from "@/lib/placement/catalog-refresh/types";
export * from "@/lib/placement/catalog-refresh/snapshots";
export { buildTiered, resolveCandidates } from "@/lib/placement/catalog-refresh/common";
export { normalizeAws, awsRefreshableSkus, AWS_RULES } from "@/lib/placement/catalog-refresh/normalize-aws";
export { normalizeGcp, gcpRefreshableSkus, GCP_RULES } from "@/lib/placement/catalog-refresh/normalize-gcp";
export { normalizeAzure, azureRefreshableSkus, AZURE_RULES } from "@/lib/placement/catalog-refresh/normalize-azure";
export { normalizeOci, ociRefreshableSkus, OCI_RULES } from "@/lib/placement/catalog-refresh/normalize-oci";
export { applyRefresh, formatRefreshReport, DEFAULT_MAX_CHANGE_RATIO, type RefreshOptions, type RefreshReport, type PriceChange } from "@/lib/placement/catalog-refresh/merge";
export { refreshFromSnapshots, catalogAgeDays, type RefreshOutput } from "@/lib/placement/catalog-refresh/refresh";
