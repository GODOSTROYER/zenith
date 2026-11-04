/**
 * Extended cost dimensions (PROD-COST-01/02): the billing lines the base SKU
 * role table does not carry for every provider and region, priced ONLY when the
 * caller supplies the usage and the catalog supplies the price.
 *
 *   inter_az_gb                  data moving between availability zones of one region
 *   storage_io_million           billable storage I/O requests (databases, volumes, VMs)
 *   backup_cross_region_copy_gb  backup copied to another region
 *
 * Rules (so an estimate can be trusted):
 * - Usage is never defaulted. No supplied usage means no line and no pretence
 *   that the dimension was modeled.
 * - Supplied usage with no catalog price for that provider and region refuses the
 *   whole estimate (`MissingPriceError`), never a silent zero.
 * - SKUs follow one pattern per dimension so a catalog refresh can fill them:
 *   `<provider>.data_transfer.inter_az_gb`, `<provider>.storage.io_million`,
 *   `<provider>.backup.cross_region_copy_gb`.
 *
 * `costDimensionCoverage` reports, for a catalog, which dimensions each provider
 * is priced for. It reads the catalog only (no network) and is what the refresh
 * tool and the docs use to say what is still open.
 */
import { skuFor, placementProviders, type SkuRole } from "@/lib/placement/capabilities";
import type { ExtendedUsageAssumptions, PriceCatalog } from "@/lib/placement/types";
import { fmt, replicasOf, type CostNode, type Ledger } from "@/lib/placement/cost-model";

function isCompute(n: CostNode): boolean {
  return n.kind === "container_service" || n.kind === "compute_instance" || n.kind === "scheduled_job";
}

export const EXTENDED_ROLES = ["egress_inter_az_gb", "storage_io_million", "backup_cross_region_copy_gb"] as const;
export type ExtendedRole = (typeof EXTENDED_ROLES)[number];

const EXTENDED_SUFFIX: Record<ExtendedRole, string> = {
  egress_inter_az_gb: "data_transfer.inter_az_gb",
  storage_io_million: "storage.io_million",
  backup_cross_region_copy_gb: "backup.cross_region_copy_gb",
};

export function extendedSkuFor(provider: string, role: ExtendedRole): string {
  return `${provider}.${EXTENDED_SUFFIX[role]}`;
}

/** Every extended SKU a catalog may carry (used by catalog tests to avoid "orphan" findings). */
export function allExtendedSkus(providers: readonly string[]): string[] {
  return providers.flatMap((p) => EXTENDED_ROLES.map((r) => extendedSkuFor(p, r)));
}

export interface ExtendedChargeResult {
  interAz: boolean;
  storageIo: boolean;
  backupCopy: boolean;
}

export interface ExtendedSite {
  provider: string;
  region: string;
  nodes: readonly CostNode[];
}

/** Adds the supplied extended-usage lines to `ledger`. Deterministic: sites and nodes are processed in sorted order. */
export function chargeExtendedDimensions(ledger: Ledger, sites: readonly ExtendedSite[], usage: ExtendedUsageAssumptions): ExtendedChargeResult {
  const out: ExtendedChargeResult = { interAz: false, storageIo: false, backupCopy: false };
  const ordered = [...sites].sort((a, b) => (`${a.provider}|${a.region}` < `${b.provider}|${b.region}` ? -1 : 1));

  if ((usage.interAzGb ?? 0) > 0) {
    const hosting = ordered.filter((s) => s.nodes.some((n) => isCompute(n) && replicasOf(n) > 0));
    for (const s of hosting) {
      const share = usage.interAzGb! / hosting.length;
      ledger.chargeSku({
        description: "Inter-availability-zone transfer",
        provider: s.provider,
        region: s.region,
        sku: extendedSkuFor(s.provider, "egress_inter_az_gb"),
        quantity: share,
        basis: `${fmt(usage.interAzGb!)} GB/month supplied by the caller${hosting.length > 1 ? ` split across ${hosting.length} compute sites` : ""}; billed per GB as the catalog entry states (some providers meter each direction)`,
      });
      out.interAz = true;
    }
  }

  if ((usage.storageIoMillions ?? 0) > 0) {
    for (const s of ordered) {
      for (const n of [...s.nodes].sort((a, b) => (a.address < b.address ? -1 : 1))) {
        if (!["postgres", "mysql", "volume", "compute_instance"].includes(n.kind)) continue;
        ledger.chargeSku({
          address: n.address,
          description: "Storage I/O requests",
          provider: s.provider,
          region: s.region,
          sku: extendedSkuFor(s.provider, "storage_io_million"),
          quantity: usage.storageIoMillions!,
          basis: `${fmt(usage.storageIoMillions!)} million billable I/O requests/month supplied by the caller for this node`,
        });
        out.storageIo = true;
      }
    }
  }

  if ((usage.crossRegionBackupCopyGb ?? 0) > 0) {
    for (const s of ordered) {
      for (const n of [...s.nodes].sort((a, b) => (a.address < b.address ? -1 : 1))) {
        if (n.kind !== "postgres" && n.kind !== "mysql") continue;
        ledger.chargeSku({
          address: n.address,
          description: "Cross-region backup copy",
          provider: s.provider,
          region: s.region,
          sku: extendedSkuFor(s.provider, "backup_cross_region_copy_gb"),
          quantity: usage.crossRegionBackupCopyGb!,
          basis: `${fmt(usage.crossRegionBackupCopyGb!)} GB/month of backup copied to another region, supplied by the caller`,
        });
        out.backupCopy = true;
      }
    }
  }
  return out;
}

/* -------------------------------- coverage -------------------------------- */

export type CostDimension =
  | "internet_egress"
  | "internet_egress_volume_tiers"
  | "nat_hours"
  | "nat_data_processed"
  | "public_ipv4_hours"
  | "storage_iops"
  | "object_requests"
  | "queue_requests"
  | "backups_and_snapshots"
  | "cross_region_transfer"
  | "inter_az_transfer"
  | "storage_io_requests"
  | "cross_region_backup_copy";

const BASE_DIMENSIONS: { dimension: CostDimension; roles: readonly SkuRole[] }[] = [
  { dimension: "internet_egress", roles: ["egress_internet_gb"] },
  { dimension: "nat_hours", roles: ["nat_hour"] },
  { dimension: "nat_data_processed", roles: ["nat_gb"] },
  { dimension: "public_ipv4_hours", roles: ["ipv4_hour"] },
  { dimension: "storage_iops", roles: ["block_iops_month", "pg_iops_month"] },
  { dimension: "object_requests", roles: ["object_get_million", "object_put_million"] },
  { dimension: "queue_requests", roles: ["queue_requests_million"] },
  { dimension: "backups_and_snapshots", roles: ["pg_backup_gb_month", "block_snapshot_gb_month"] },
  { dimension: "cross_region_transfer", roles: ["egress_inter_region_gb"] },
];

export interface DimensionCoverage {
  provider: string;
  dimension: CostDimension;
  /** regions of the provider with a catalog price for every role of the dimension */
  pricedRegions: string[];
  /** regions the catalog knows for the provider but that lack a price for the dimension */
  missingRegions: string[];
  status: "priced" | "partial" | "not_priced";
}

/** Which cost dimensions each provider is priced for in `catalog`, by region. Pure. */
export function costDimensionCoverage(catalog: PriceCatalog): DimensionCoverage[] {
  const regionsByProvider = new Map<string, Set<string>>();
  const has = new Map<string, PriceCatalog["entries"][number]>();
  for (const e of catalog.entries) {
    const rs = regionsByProvider.get(e.provider) ?? new Set<string>();
    rs.add(e.region);
    regionsByProvider.set(e.provider, rs);
    has.set(`${e.provider}|${e.region}|${e.sku}`, e);
  }
  const out: DimensionCoverage[] = [];
  const providers = [...regionsByProvider.keys()].filter((p) => placementProviders().includes(p)).sort();
  const classify = (provider: string, dimension: CostDimension, skus: readonly (string | undefined)[], extraCheck?: (e: PriceCatalog["entries"][number]) => boolean): DimensionCoverage => {
    const regions = [...(regionsByProvider.get(provider) ?? [])].sort();
    const priced: string[] = [];
    const missing: string[] = [];
    for (const r of regions) {
      const ok = skus.length > 0 && skus.every((s) => s !== undefined && has.has(`${provider}|${r}|${s}`) && (extraCheck ? extraCheck(has.get(`${provider}|${r}|${s}`)!) : true));
      (ok ? priced : missing).push(r);
    }
    return { provider, dimension, pricedRegions: priced, missingRegions: missing, status: priced.length === 0 ? "not_priced" : missing.length === 0 ? "priced" : "partial" };
  };
  for (const provider of providers) {
    for (const d of BASE_DIMENSIONS) out.push(classify(provider, d.dimension, d.roles.map((r) => skuFor(provider, r)).filter((s) => s !== undefined)));
    // roles a provider legitimately lacks (e.g. no block IOPS role) must not look priced: require at least one defined role
    out.push(classify(provider, "internet_egress_volume_tiers", [skuFor(provider, "egress_internet_gb")], (e) => (e.tiers?.length ?? 0) >= 2));
    out.push(classify(provider, "inter_az_transfer", [extendedSkuFor(provider, "egress_inter_az_gb")]));
    out.push(classify(provider, "storage_io_requests", [extendedSkuFor(provider, "storage_io_million")]));
    out.push(classify(provider, "cross_region_backup_copy", [extendedSkuFor(provider, "backup_cross_region_copy_gb")]));
  }
  return out;
}
