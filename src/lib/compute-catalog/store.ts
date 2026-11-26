import { constants, type BigIntStats } from "node:fs";
import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ComputeCatalog, RawComputeSnapshot } from "./types";
import { hasCredentialQuery } from "./source-url";

/** Operator-owned local snapshots follow the existing reviewed catalog workflow. */
export const MAX_COMPUTE_CATALOG_BYTES = 64 * 1024 * 1024;
const TimestampSchema = z.string().datetime({ offset: true });
const SnapshotKindSchema = z.enum([
  "aws_ec2_prices", "aws_instance_types", "aws_instance_offerings",
  "gcp_machine_types", "gcp_skus", "azure_resource_skus", "azure_retail_prices",
]);
const ProviderSchema = z.enum(["aws", "gcp", "azure"]);
const IdentifierSchema = z.string().min(1).max(256).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Control characters are not allowed.");
const WarningSchema = z.string().min(1).max(2000);

function safeSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash &&
      !hasCredentialQuery(url);
  } catch { return false; }
}

const SourceSchema = z.object({
  kind: SnapshotKindSchema,
  url: z.string().max(4096).refine(safeSourceUrl, "Source must be HTTPS and must not contain credentials, access tokens, or fragments."),
  retrievedAt: TimestampSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const OfferSchema = z.object({
  id: IdentifierSchema,
  provider: ProviderSchema,
  region: IdentifierSchema,
  zone: IdentifierSchema.optional(),
  instanceType: IdentifierSchema,
  vcpus: z.number().finite().positive().max(1_000_000),
  memoryMiB: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  architecture: z.enum(["x86_64", "arm64", "unknown"]),
  cpuMode: z.enum(["sustained", "burstable", "shared", "unknown"]),
  operatingSystem: z.literal("linux"),
  tenancy: z.literal("shared"),
  purchaseModel: z.literal("on_demand"),
  price: z.object({
    hourlyUsd: z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,12})?$/, "Price must be a nonnegative decimal USD string with at most 12 decimal places."),
    source: SourceSchema,
    nativeSku: IdentifierSchema.optional(),
    effectiveAt: TimestampSchema.optional(),
  }).strict().nullable(),
  specSource: SourceSchema,
  offeringState: z.enum(["offered", "catalog_only"]),
  warnings: z.array(WarningSchema).max(200),
}).strict();

const CatalogSchema = z.object({
  schemaVersion: z.literal(1),
  version: IdentifierSchema,
  generatedAt: TimestampSchema,
  sources: z.array(SourceSchema).min(1).max(10_000),
  coverage: z.array(z.object({
    provider: ProviderSchema,
    regions: z.array(IdentifierSchema).max(1000),
    offerCount: z.number().int().nonnegative(),
    pricedOfferCount: z.number().int().nonnegative(),
    scope: z.literal("imported_snapshots"),
    warnings: z.array(WarningSchema).max(500),
  }).strict()).min(1).max(3),
  offers: z.array(OfferSchema).max(100_000),
  warnings: z.array(WarningSchema).max(1000),
}).strict();

export class ComputeCatalogValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid compute catalog: ${issues.slice(0, 5).join("; ")}`);
    this.name = "ComputeCatalogValidationError";
  }
}

export class ComputeCatalogUnavailableError extends Error {
  constructor() {
    super("No compute catalog is configured. Import provider snapshots with compute:catalog before requesting recommendations.");
    this.name = "ComputeCatalogUnavailableError";
  }
}

function sourceKey(source: z.infer<typeof SourceSchema>): string {
  return JSON.stringify([source.kind, source.url, source.retrievedAt, source.sha256 ?? null]);
}

/** Validate a snapshot before either publication or use by an authenticated route. */
export function parseComputeCatalog(input: unknown): ComputeCatalog {
  const result = CatalogSchema.safeParse(input);
  if (!result.success) throw new ComputeCatalogValidationError(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const catalog = result.data;
  const issues: string[] = [];
  const generatedAt = Date.parse(catalog.generatedAt);
  const sourceKeys = new Set(catalog.sources.map(sourceKey));
  const ids = new Set<string>();
  const nativeOffers = new Set<string>();
  const providers = new Set<string>();
  for (const source of catalog.sources) {
    if (Date.parse(source.retrievedAt) > generatedAt) issues.push(`Source ${source.kind} was retrieved after the catalog was generated.`);
  }
  for (const offer of catalog.offers) {
    const nativeKey = JSON.stringify([offer.provider, offer.region, offer.zone ?? null, offer.instanceType]);
    if (ids.has(offer.id) || nativeOffers.has(nativeKey)) issues.push(`Duplicate offer ${offer.id}.`);
    ids.add(offer.id);
    nativeOffers.add(nativeKey);
    for (const source of [offer.specSource, ...(offer.price ? [offer.price.source] : [])]) {
      if (!sourceKeys.has(sourceKey(source))) issues.push(`Offer ${offer.id} references a source absent from the catalog.`);
      if (!source.kind.startsWith(`${offer.provider}_`)) issues.push(`Offer ${offer.id} references a different provider's source.`);
    }
    if (offer.price?.effectiveAt && Date.parse(offer.price.effectiveAt) > generatedAt) issues.push(`Offer ${offer.id} has a future effective price.`);
  }
  for (const coverage of catalog.coverage) {
    if (providers.has(coverage.provider)) issues.push(`Duplicate coverage for ${coverage.provider}.`);
    providers.add(coverage.provider);
    const offers = catalog.offers.filter((o) => o.provider === coverage.provider);
    if (coverage.offerCount !== offers.length || coverage.pricedOfferCount !== offers.filter((o) => o.price !== null).length) issues.push(`Coverage counts do not match ${coverage.provider} offers.`);
    const regions = new Set(coverage.regions);
    if (regions.size !== coverage.regions.length || offers.some((o) => !regions.has(o.region))) issues.push(`Coverage regions do not match ${coverage.provider} offers.`);
    if (!catalog.sources.some((s) => s.kind.startsWith(`${coverage.provider}_`))) issues.push(`Coverage for ${coverage.provider} has no source.`);
  }
  for (const offer of catalog.offers) if (!providers.has(offer.provider)) issues.push(`Offer ${offer.id} has no provider coverage.`);
  if (issues.length) throw new ComputeCatalogValidationError(issues);
  return catalog;
}

/** Strict import envelope; native provider documents are validated by their adapters. */
export function parseRawComputeSnapshots(input: unknown): RawComputeSnapshot[] {
  const schema = z.object({
    schemaVersion: z.literal(1),
    snapshots: z.array(SourceSchema.extend({ region: IdentifierSchema.optional(), data: z.unknown() }).strict()).min(1).max(10_000),
  }).strict();
  const result = schema.safeParse(input);
  if (!result.success) throw new ComputeCatalogValidationError(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  if (result.data.snapshots.some((s) => s.data === undefined || s.data === null)) throw new ComputeCatalogValidationError(["Every snapshot needs a native API response in data."]);
  return result.data.snapshots;
}

/** Path is operator configuration, never a request-body or query parameter. */
export function computeCatalogPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return resolve(env.ZENITH_COMPUTE_CATALOG_PATH || resolve(env.ZENITH_DATA || ".data", "compute-catalog", "catalog.json"));
}

function fileSize(stat: BigIntStats, maxBytes: number): number {
  if (!stat.isFile() || stat.size > BigInt(maxBytes)) throw new ComputeCatalogValidationError([`Snapshot must be a regular file no larger than ${maxBytes} bytes.`]);
  return Number(stat.size);
}

/** Use one descriptor throughout a read, including when another writer renames a new version. */
async function readOpenedBytes(handle: FileHandle, stat: BigIntStats, maxBytes: number): Promise<Buffer> {
  const size = fileSize(stat, maxBytes);
  // Read at most the bound plus one byte, including if the file grows after stat.
  const buffer = Buffer.alloc(Math.min(size + 1, maxBytes + 1));
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size || offset > maxBytes) throw new ComputeCatalogValidationError(["Snapshot changed during reading or exceeded the size bound. Retry after publication completes."]);
  return buffer.subarray(0, offset);
}

export async function readBoundedBytes(path: string, maxBytes = MAX_COMPUTE_CATALOG_BYTES): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    return await readOpenedBytes(handle, await handle.stat({ bigint: true }), maxBytes);
  } finally { await handle.close(); }
}

function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new ComputeCatalogValidationError(["Snapshot is not valid JSON."]); }
}

export async function readBoundedJson(path: string, maxBytes = MAX_COMPUTE_CATALOG_BYTES): Promise<unknown> {
  return parseJson(await readBoundedBytes(path, maxBytes));
}

interface CachedCatalog { identity: string; promise: Promise<ComputeCatalog> }
const catalogCache = new Map<string, CachedCatalog>();
const MAX_CACHED_CATALOG_PATHS = 4;

function statIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function rememberCatalog(path: string, entry: CachedCatalog): void {
  catalogCache.delete(path);
  catalogCache.set(path, entry);
  while (catalogCache.size > MAX_CACHED_CATALOG_PATHS) catalogCache.delete(catalogCache.keys().next().value!);
}

function freezeCatalog<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeCatalog(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Every call opens/stats the current path, so absence or a replacement cannot
 * return an older success. Matching identities share validation in flight and
 * an immutable result; failed validations are never retained in the cache.
 */
export async function loadComputeCatalog(path = computeCatalogPath()): Promise<ComputeCatalog> {
  const key = resolve(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(key, constants.O_RDONLY);
    const stat = await handle.stat({ bigint: true });
    fileSize(stat, MAX_COMPUTE_CATALOG_BYTES);
    const identity = statIdentity(stat);
    const cached = catalogCache.get(key);
    if (cached?.identity === identity) {
      // A waiting reader does not need to keep a second descriptor open.
      await handle.close();
      handle = undefined;
      rememberCatalog(key, cached);
      return await cached.promise;
    }

    const opened = handle;
    const entry: CachedCatalog = { identity, promise: (async () => {
      const bytes = await readOpenedBytes(opened, stat, MAX_COMPUTE_CATALOG_BYTES);
      if (statIdentity(await opened.stat({ bigint: true })) !== identity) throw new ComputeCatalogValidationError(["Snapshot changed during reading. Retry after publication completes."]);
      return freezeCatalog(parseComputeCatalog(parseJson(bytes)));
    })() };
    rememberCatalog(key, entry);
    try { return await entry.promise; }
    catch (error) {
      if (catalogCache.get(key) === entry) catalogCache.delete(key);
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      catalogCache.delete(key);
      throw new ComputeCatalogUnavailableError();
    }
    throw error;
  } finally { await handle?.close(); }
}

/** Parse before writing; rename publishes one complete version to concurrent readers. */
export async function saveComputeCatalog(input: unknown, path = computeCatalogPath()): Promise<ComputeCatalog> {
  const catalog = parseComputeCatalog(input);
  const bytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  if (bytes.byteLength > MAX_COMPUTE_CATALOG_BYTES) throw new ComputeCatalogValidationError(["Normalized catalog exceeds the publication size bound."]);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporaryPath, path);
    catalogCache.delete(resolve(path));
  } finally { await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
  return catalog;
}
