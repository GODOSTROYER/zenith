/** Read-only provider collection. No resources are created and no credentials are persisted. */
import { createHash } from "node:crypto";
import {
  EC2Client, DescribeInstanceTypesCommand, DescribeInstanceTypeOfferingsCommand,
} from "@aws-sdk/client-ec2";
import type { ComputeProvider, ComputeSnapshotKind, RawComputeSnapshot } from "./types";
import { hasCredentialQuery } from "./source-url";
import { assertComputeScopeRegions, isAwsInventoryRegion, requireComputeCollectionScope } from "./scope";

const AWS_PRICE_HOST = "pricing.us-east-1.amazonaws.com";
const GCP_COMPUTE_HOST = "compute.googleapis.com";
const GCP_BILLING_HOST = "cloudbilling.googleapis.com";
const AZURE_ARM_HOST = "management.azure.com";
const AZURE_PRICE_HOST = "prices.azure.com";
const COMPUTE_SERVICE = "6F81-5844-456A";
const MAX_RESPONSE_BYTES = 450 * 1024 * 1024;
const MAX_PAGES = 2000;
const REQUEST_TIMEOUT_MS = 60_000;

export interface ComputeCollectionRequest {
  provider: ComputeProvider;
  /** Requested output regions. GCP/Azure inventory APIs still return global inputs. */
  regions?: string[];
  /** AWS SDK credential chain is used only when this is explicitly enabled. */
  awsInventory?: boolean;
  gcpProject?: string;
  azureSubscription?: string;
}

export interface ComputeCollectionDeps {
  /** Existing network opt-in and approved scope-manifest path; the CLI opens neither gate itself. */
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now: () => string;
  /** Ephemeral tokens supplied by an operator; never included in a source URL. */
  gcpAccessToken?: string;
  azureAccessToken?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable AWS SDK seam for offline pagination and failure tests. */
  awsInventoryPage?: (region: string, kind: "types" | "offerings", token?: string) => Promise<unknown>;
}

export class ComputeCollectionError extends Error {
  constructor(message: string) { super(message); this.name = "ComputeCollectionError"; }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ComputeCollectionError("Provider response must be a JSON object.");
  return value as Record<string, unknown>;
}

function stringToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ComputeCollectionError("Provider returned an invalid pagination token.");
  return value;
}

function checkedUrl(value: string, host: string, prefix: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ComputeCollectionError("Provider returned an invalid continuation URL."); }
  if (url.protocol !== "https:" || url.hostname !== host || url.port || url.username || url.password || url.hash || !url.pathname.startsWith(prefix)) {
    throw new ComputeCollectionError("Provider continuation URL left its allowed endpoint.");
  }
  if (hasCredentialQuery(url)) {
    throw new ComputeCollectionError("Credential-bearing URLs cannot be captured as catalog evidence.");
  }
  return url;
}

async function responseBytes(response: Response): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new ComputeCollectionError("Provider response exceeds the bounded snapshot size.");
  if (!response.body) throw new ComputeCollectionError("Provider returned an empty response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ComputeCollectionError("Provider response exceeds the bounded snapshot size.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

async function fetchSnapshot(url: URL, kind: ComputeSnapshotKind, deps: ComputeCollectionDeps, region?: string, token?: string): Promise<RawComputeSnapshot> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      response = await deps.fetch(url.toString(), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch { throw new ComputeCollectionError(`${url.hostname} could not be reached within the collection timeout.`); }
    if (response.status !== 429 && response.status !== 503) break;
    if (attempt === 3) break;
    const after = Number(response.headers.get("retry-after"));
    const delay = Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt, 30_000);
    await response.body?.cancel();
    await (deps.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))))(delay);
  }
  if (!response?.ok) throw new ComputeCollectionError(`${url.hostname} answered HTTP ${response?.status ?? "unknown"}; the previous catalog has not been replaced.`);
  const bytes = await responseBytes(response);
  let data: unknown;
  try { data = JSON.parse(bytes.toString("utf8")); }
  catch { throw new ComputeCollectionError(`${url.hostname} did not return valid JSON.`); }
  record(data);
  return { kind, url: url.toString(), retrievedAt: deps.now(), sha256: createHash("sha256").update(bytes).digest("hex"), ...(region ? { region } : {}), data };
}

async function* collectAws(request: ComputeCollectionRequest, deps: ComputeCollectionDeps, scope: ReturnType<typeof requireComputeCollectionScope>): AsyncGenerator<RawComputeSnapshot> {
  const indexUrl = checkedUrl(`https://${AWS_PRICE_HOST}/offers/v1.0/aws/AmazonEC2/current/region_index.json`, AWS_PRICE_HOST, "/offers/v1.0/aws/AmazonEC2/");
  const index = record((await fetchSnapshot(indexUrl, "aws_ec2_prices", deps)).data);
  const regions = record(index.regions);
  const requested = request.regions ?? Object.keys(regions).sort();
  // Preflight the entire discovered region set before the first regional SDK call.
  if (request.awsInventory) assertComputeScopeRegions(scope, "aws", requested.filter(isAwsInventoryRegion));
  for (const region of requested) {
    const entry = record(regions[region]);
    if (typeof entry.currentVersionUrl !== "string") throw new ComputeCollectionError(`AWS has no public EC2 price file for ${region}.`);
    const url = checkedUrl(new URL(entry.currentVersionUrl, indexUrl).toString(), AWS_PRICE_HOST, "/offers/v1.0/aws/AmazonEC2/");
    yield await fetchSnapshot(url, "aws_ec2_prices", deps, region);
    // The price index can contain Local/Wavelength Zone locations. They are not
    // EC2 region endpoints and must remain separate price-only evidence.
    if (!request.awsInventory || !isAwsInventoryRegion(region)) continue;
    const client = deps.awsInventoryPage ? undefined : new EC2Client({ region, maxAttempts: 3 });
    try {
      for (const kind of ["types", "offerings"] as const) {
        let next: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; page < MAX_PAGES; page++) {
          let data: unknown;
          try {
            data = deps.awsInventoryPage
              ? await deps.awsInventoryPage(region, kind, next)
              : kind === "types"
                ? await client!.send(new DescribeInstanceTypesCommand({ MaxResults: 100, NextToken: next }), { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
                : await client!.send(new DescribeInstanceTypeOfferingsCommand({ LocationType: "availability-zone-id", MaxResults: 1000, NextToken: next }), { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
          } catch { throw new ComputeCollectionError(`AWS ${kind} inventory failed in ${region}; verify read permissions and enabled regions.`); }
          const raw = record(data);
          if (!Array.isArray(raw[kind === "types" ? "InstanceTypes" : "InstanceTypeOfferings"])) throw new ComputeCollectionError(`AWS returned invalid ${kind} inventory.`);
          // SDK transport metadata has no role in the persisted resource evidence.
          const { $metadata: _metadata, ...payload } = raw;
          const bytes = JSON.stringify(payload);
          yield {
            kind: kind === "types" ? "aws_instance_types" : "aws_instance_offerings",
            url: `https://ec2.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}/?Action=${kind === "types" ? "DescribeInstanceTypes" : "DescribeInstanceTypeOfferings"}${next ? `&NextToken=${encodeURIComponent(next)}` : ""}`,
            region, retrievedAt: deps.now(), sha256: createHash("sha256").update(bytes).digest("hex"), data: payload,
          };
          next = stringToken(raw.NextToken);
          if (!next) break;
          if (seen.has(next) || page === MAX_PAGES - 1) throw new ComputeCollectionError("AWS inventory pagination did not complete.");
          seen.add(next);
        }
      }
    } finally { client?.destroy(); }
  }
}

async function* collectGcp(request: ComputeCollectionRequest, deps: ComputeCollectionDeps): AsyncGenerator<RawComputeSnapshot> {
  if (!request.gcpProject || !deps.gcpAccessToken?.trim()) throw new ComputeCollectionError("GCP collection requires an explicit project and access token with Compute inventory and Billing Catalog read access.");
  for (const kind of ["gcp_machine_types", "gcp_skus"] as const) {
    const host = kind === "gcp_machine_types" ? GCP_COMPUTE_HOST : GCP_BILLING_HOST;
    const prefix = kind === "gcp_machine_types" ? `/compute/v1/projects/${encodeURIComponent(request.gcpProject)}/aggregated/machineTypes` : `/v1/services/${COMPUTE_SERVICE}/skus`;
    const url = checkedUrl(`https://${host}${prefix}`, host, prefix);
    if (kind === "gcp_machine_types") { url.searchParams.set("maxResults", "500"); url.searchParams.set("returnPartialSuccess", "true"); }
    else { url.searchParams.set("pageSize", "5000"); url.searchParams.set("currencyCode", "USD"); }
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const snapshot = await fetchSnapshot(url, kind, deps, undefined, deps.gcpAccessToken);
      const raw = record(snapshot.data);
      if (raw.error || (Array.isArray(raw.unreachables) && raw.unreachables.length) || (raw.warning && record(raw.warning).code !== "NO_RESULTS_ON_PAGE")) throw new ComputeCollectionError("GCP returned incomplete inventory; no catalog was published.");
      if (kind === "gcp_machine_types") {
        const items = record(raw.items ?? {});
        for (const scope of Object.values(items)) {
          const scoped = record(scope);
          if (scoped.warning && record(scoped.warning).code !== "NO_RESULTS_ON_PAGE") throw new ComputeCollectionError("GCP reported an inventory scope warning; no catalog was published.");
        }
      } else if (!Array.isArray(raw.skus)) throw new ComputeCollectionError("GCP returned an invalid SKU page.");
      yield snapshot;
      const next = stringToken(raw.nextPageToken);
      if (!next) break;
      if (seen.has(next) || page === MAX_PAGES - 1) throw new ComputeCollectionError("GCP pagination did not complete.");
      seen.add(next);
      url.searchParams.set("pageToken", next);
    }
  }
}

async function* collectAzure(request: ComputeCollectionRequest, deps: ComputeCollectionDeps): AsyncGenerator<RawComputeSnapshot> {
  if (!request.azureSubscription || !deps.azureAccessToken?.trim()) throw new ComputeCollectionError("Azure collection requires an explicit subscription and access token with Resource SKUs read access.");
  for (const kind of ["azure_resource_skus", "azure_retail_prices"] as const) {
    const host = kind === "azure_resource_skus" ? AZURE_ARM_HOST : AZURE_PRICE_HOST;
    const prefix = kind === "azure_resource_skus" ? `/subscriptions/${encodeURIComponent(request.azureSubscription)}/providers/Microsoft.Compute/skus` : "/api/retail/prices";
    let url = checkedUrl(`https://${host}${prefix}`, host, prefix);
    url.searchParams.set("api-version", kind === "azure_resource_skus" ? "2021-07-01" : "2023-01-01-preview");
    if (kind === "azure_retail_prices") {
      url.searchParams.set("currencyCode", "USD");
      const regionFilter = request.regions?.length ? ` and (${request.regions.map((region) => `armRegionName eq '${region}'`).join(" or ")})` : "";
      url.searchParams.set("$filter", `serviceName eq 'Virtual Machines'${regionFilter}`);
    }
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      if (seen.has(url.toString())) throw new ComputeCollectionError("Azure pagination repeated a page.");
      seen.add(url.toString());
      const snapshot = await fetchSnapshot(url, kind, deps, undefined, kind === "azure_resource_skus" ? deps.azureAccessToken : undefined);
      const raw = record(snapshot.data);
      if (!Array.isArray(raw[kind === "azure_resource_skus" ? "value" : "Items"])) throw new ComputeCollectionError("Azure returned an invalid inventory or price page.");
      yield snapshot;
      const next = stringToken(raw[kind === "azure_resource_skus" ? "nextLink" : "NextPageLink"]);
      if (!next) break;
      if (page === MAX_PAGES - 1) throw new ComputeCollectionError("Azure pagination exceeded the collection bound.");
      url = checkedUrl(next, host, prefix);
    }
  }
}

/** Stream into a staging archive. Consumers must only publish after iteration completes. */
export async function* iterateComputeSnapshots(request: ComputeCollectionRequest, deps: ComputeCollectionDeps): AsyncGenerator<RawComputeSnapshot> {
  if (deps.env.ZENITH_LIVE_CATALOG_REFRESH !== "1") throw new ComputeCollectionError("Set ZENITH_LIVE_CATALOG_REFRESH=1 to allow read-only official API collection.");
  if (request.regions && (!request.regions.length || request.regions.some((region) => !/^[a-z][a-z0-9-]{1,63}$/.test(region)) || new Set(request.regions).size !== request.regions.length)) throw new ComputeCollectionError("Regions must be unique native region identifiers.");
  if (request.gcpProject && !/^[a-z0-9][a-z0-9-]{1,127}$/.test(request.gcpProject)) throw new ComputeCollectionError("Invalid GCP project identifier.");
  if (request.azureSubscription && !/^[a-f0-9-]{1,64}$/i.test(request.azureSubscription)) throw new ComputeCollectionError("Invalid Azure subscription identifier.");
  const scope = requireComputeCollectionScope(request, deps.env, deps.now);
  switch (request.provider) {
    case "aws": yield* collectAws(request, deps, scope); break;
    case "gcp": yield* collectGcp(request, deps); break;
    case "azure": yield* collectAzure(request, deps); break;
    default: throw new ComputeCollectionError("Unsupported compute provider.");
  }
}

/** Convenience for bounded collections. Errors never return a partial result. */
export async function collectComputeSnapshots(request: ComputeCollectionRequest, deps: ComputeCollectionDeps): Promise<RawComputeSnapshot[]> {
  const snapshots: RawComputeSnapshot[] = [];
  for await (const snapshot of iterateComputeSnapshots(request, deps)) snapshots.push(snapshot);
  return snapshots;
}
