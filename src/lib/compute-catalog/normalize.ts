import { normalizeAwsSnapshots } from "./normalize-aws";
import { normalizeAzureSnapshots } from "./normalize-azure";
import { normalizeGcpSnapshots } from "./normalize-gcp";
import { object, rows, source, text, uniqueOffers } from "./normalize-common";
import { parseComputeCatalog, parseRawComputeSnapshots } from "./store";
import type { ComputeCatalog, ComputeProvider, NormalizeComputeOptions, RawComputeSnapshot } from "./types";

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.sort();
  return url.toString();
}

/** Import complete page chains. A page containing a next token is never silently treated as complete. */
function validatePagination(snapshots: readonly RawComputeSnapshot[]): void {
  const key = (s: RawComputeSnapshot, url = s.url) => JSON.stringify([s.kind, s.region ?? null, canonicalUrl(url)]);
  const lookup = new Map<string, number>();
  snapshots.forEach((s, i) => {
    const previous = lookup.get(key(s));
    if (previous !== undefined && source(snapshots[previous]!).sha256 !== source(s).sha256) throw new Error("Conflicting snapshots for the same source URL; import one consistent collection.");
    lookup.set(key(s), i);
  });
  const next = new Map<number, number>();
  const incoming = new Set<number>();
  snapshots.forEach((snapshot, i) => {
    const data = object(snapshot.data);
    const cursor = snapshot.kind.startsWith("aws_") ? data.NextToken : snapshot.kind.startsWith("gcp_") ? data.nextPageToken : snapshot.kind === "azure_resource_skus" ? data.nextLink : data.NextPageLink;
    if (cursor === undefined || cursor === null || cursor === "") return;
    if (typeof cursor !== "string") throw new Error("Native pagination token must be a string.");
    const url = new URL(snapshot.url);
    if (snapshot.kind.startsWith("aws_")) url.searchParams.set("NextToken", cursor);
    else if (snapshot.kind.startsWith("gcp_")) url.searchParams.set("pageToken", cursor);
    const destination = lookup.get(key(snapshot, snapshot.kind.startsWith("azure_") ? cursor : url.toString()));
    if (destination === undefined) throw new Error(`Incomplete pagination for ${snapshot.kind}; import every page or a consolidated response without continuation tokens.`);
    next.set(i, destination);
    incoming.add(destination);
  });
  snapshots.forEach((snapshot, i) => {
    const url = new URL(snapshot.url);
    const continuation = [...url.searchParams].some(([key, value]) => /^(?:NextToken|pageToken|\$skiptoken|\$skip)$/i.test(key) && value !== "" && value !== "0");
    if (continuation && !incoming.has(i)) throw new Error(`Pagination for ${snapshot.kind} starts after the first page; import the complete chain.`);
    const seen = new Set<number>();
    let cursor: number | undefined = i;
    while (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error(`Pagination cycle detected for ${snapshot.kind}.`);
      seen.add(cursor);
      cursor = next.get(cursor);
    }
  });
}

function importedRegions(snapshot: RawComputeSnapshot): string[] {
  const result = snapshot.region ? [snapshot.region] : [];
  const data = object(snapshot.data);
  if (snapshot.kind === "aws_ec2_prices") {
    for (const product of Object.values(object(data.products))) {
      const region = text(object(object(product).attributes).regionCode);
      if (region) result.push(region);
    }
  } else if (snapshot.kind === "gcp_skus") {
    for (const sku of rows(data.skus)) if (Array.isArray(sku.serviceRegions)) result.push(...sku.serviceRegions.filter((r): r is string => typeof r === "string" && !!r));
  } else if (snapshot.kind === "azure_retail_prices") {
    for (const row of rows(data.Items)) { const region = text(row.armRegionName); if (region) result.push(region); }
  } else if (snapshot.kind === "azure_resource_skus") {
    for (const sku of rows(data.value)) if (Array.isArray(sku.locations)) result.push(...sku.locations.filter((r): r is string => typeof r === "string" && !!r));
  }
  return result;
}

/** Deterministic offline normalization; source metadata describes imported evidence, not live capacity. */
export function normalizeComputeSnapshots(input: readonly RawComputeSnapshot[], options: NormalizeComputeOptions): ComputeCatalog {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(options.generatedAt) || !Number.isFinite(Date.parse(options.generatedAt))) throw new Error("Catalog generation requires a full ISO timestamp.");
  const parsed = parseRawComputeSnapshots({ schemaVersion: 1, snapshots: input });
  const snapshots = parsed.map(snapshot => {
    if (snapshot.data === null || typeof snapshot.data !== "object" || Array.isArray(snapshot.data)) throw new Error(`Native ${snapshot.kind} response must be an object.`);
    if (object(snapshot.data).error) throw new Error(`Native ${snapshot.kind} response contains an API error.`);
    if (Date.parse(snapshot.retrievedAt) > Date.parse(options.generatedAt)) throw new Error("Snapshot retrieval cannot be later than catalog generation.");
    return { ...snapshot, sha256: source(snapshot).sha256 };
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.url.localeCompare(b.url) || a.retrievedAt.localeCompare(b.retrievedAt));
  validatePagination(snapshots);
  const normalized = {
    aws: normalizeAwsSnapshots(snapshots, options.generatedAt),
    gcp: normalizeGcpSnapshots(snapshots, options.generatedAt),
    azure: normalizeAzureSnapshots(snapshots, options.generatedAt),
  };
  const offers = uniqueOffers(Object.values(normalized).flatMap(p => p.offers));
  const providers = (["aws", "gcp", "azure"] as const).filter(provider => snapshots.some(s => s.kind.startsWith(`${provider}_`)));
  const sources = [...new Map(snapshots.map(s => { const evidence = source(s); return [JSON.stringify(evidence), evidence]; })).values()];
  const coverage = providers.map((provider: ComputeProvider) => {
    const providerOffers = offers.filter(offer => offer.provider === provider);
    const regions = [...new Set([
      ...providerOffers.map(offer => offer.region),
      ...snapshots.filter(snapshot => snapshot.kind.startsWith(`${provider}_`)).flatMap(importedRegions),
    ])].sort();
    return {
      provider, regions, offerCount: providerOffers.length,
      pricedOfferCount: providerOffers.filter(offer => offer.price !== null).length,
      scope: "imported_snapshots" as const,
      warnings: [...new Set([...normalized[provider].warnings, "Coverage describes only imported API scopes; it does not establish every region or instance type worldwide."])].sort(),
    };
  });
  return parseComputeCatalog({
    schemaVersion: 1, version: options.version, generatedAt: options.generatedAt, sources, coverage, offers,
    warnings: [
      "Public Linux shared-tenancy On-Demand compute prices only; disks, IPs, egress, software licenses, taxes, credits, commitments, and customer discounts are excluded.",
      "Offering evidence does not establish current capacity, quota, account eligibility, or application performance.",
      "Source URLs and retrieval times describe imported snapshots; this normalization does not perform live provider requests.",
    ],
  });
}
