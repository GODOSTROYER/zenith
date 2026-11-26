/** Staged, checksummed raw archives keep all-region AWS collection out of one heap. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { iterateComputeSnapshots, type ComputeCollectionDeps, type ComputeCollectionRequest } from "./collect";
import { normalizeComputeSnapshots } from "./normalize";
import { parseComputeCatalog, parseRawComputeSnapshots, readBoundedBytes, readBoundedJson } from "./store";
import type { ComputeCatalog, NormalizeComputeOptions, RawComputeSnapshot } from "./types";

export const MAX_RAW_COMPUTE_SNAPSHOT_BYTES = 480 * 1024 * 1024;
export const MAX_COMPUTE_JOIN_BYTES = 512 * 1024 * 1024;
const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  collectedAt: z.string().datetime({ offset: true }),
  request: z.object({
    provider: z.enum(["aws", "gcp", "azure"]),
    regions: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)).min(1).max(1000).optional(),
    awsInventory: z.boolean().optional(),
    gcpProject: z.string().regex(/^[a-z0-9][a-z0-9-]{1,127}$/).optional(),
    azureSubscription: z.string().regex(/^[a-f0-9-]{1,64}$/i).optional(),
  }).strict(),
  files: z.array(z.object({
    file: z.string().regex(/^snapshot-\d{5}\.json$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["aws_ec2_prices", "aws_instance_types", "aws_instance_offerings", "gcp_machine_types", "gcp_skus", "azure_resource_skus", "azure_retail_prices"]),
    region: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/).optional(),
  }).strict()).min(1).max(10_000),
}).strict();
type Manifest = z.infer<typeof ManifestSchema>;
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function writePrivateFile(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function requireNewDirectory(path: string): Promise<void> {
  try { await stat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("The archive output already exists. Use a new versioned directory.");
}

/** Failed collection removes staging files and never replaces a complete archive. */
export async function fetchComputeArchive(request: ComputeCollectionRequest, deps: ComputeCollectionDeps, directory: string): Promise<Manifest> {
  const destination = resolve(directory);
  await requireNewDirectory(destination);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const files: Manifest["files"] = [];
    for await (const snapshot of iterateComputeSnapshots(request, deps)) {
      parseRawComputeSnapshots({ schemaVersion: 1, snapshots: [snapshot] });
      if (files.length >= 10_000) throw new Error("Collection exceeds the archive page bound.");
      const file = `snapshot-${String(files.length).padStart(5, "0")}.json`;
      const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, snapshots: [snapshot] })}\n`);
      if (bytes.length > MAX_RAW_COMPUTE_SNAPSHOT_BYTES) throw new Error("Raw snapshot exceeds the archive size bound.");
      await writePrivateFile(join(staging, file), bytes);
      files.push({ file, sha256: hash(bytes), kind: snapshot.kind, ...(snapshot.region ? { region: snapshot.region } : {}) });
    }
    const manifest = ManifestSchema.parse({ schemaVersion: 1, collectedAt: deps.now(), request, files });
    await writePrivateFile(join(staging, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    await requireNewDirectory(destination);
    await rename(staging, destination);
    return manifest;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** Merge only compatible scopes. Duplicate native offers fail validation rather than picking a price. */
export function mergeComputeCatalogs(catalogs: readonly ComputeCatalog[], options: NormalizeComputeOptions): ComputeCatalog {
  if (!catalogs.length) throw new Error("At least one complete snapshot collection is required.");
  const sources = [...new Map(catalogs.flatMap(c => c.sources).map(s => [JSON.stringify(s), s])).values()];
  const offers = catalogs.flatMap(c => c.offers).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const providers = [...new Set(catalogs.flatMap(c => c.coverage.map(scope => scope.provider)))].sort();
  return parseComputeCatalog({
    schemaVersion: 1, version: options.version, generatedAt: options.generatedAt, sources, offers,
    coverage: providers.map(provider => {
      const scopes = catalogs.flatMap(c => c.coverage).filter(scope => scope.provider === provider);
      const entries = offers.filter(offer => offer.provider === provider);
      return {
        provider, regions: [...new Set(scopes.flatMap(scope => scope.regions))].sort(),
        offerCount: entries.length, pricedOfferCount: entries.filter(offer => offer.price !== null).length,
        scope: "imported_snapshots", warnings: [...new Set(scopes.flatMap(scope => scope.warnings))].sort(),
      };
    }),
    warnings: [...new Set(catalogs.flatMap(c => c.warnings))].sort(),
  });
}

function restrictRegions(catalog: ComputeCatalog, requested?: readonly string[]): ComputeCatalog {
  if (!requested) return catalog;
  const regions = new Set(requested);
  const offers = catalog.offers.filter(offer => regions.has(offer.region));
  return parseComputeCatalog({
    ...catalog, offers,
    coverage: catalog.coverage.map(scope => {
      const entries = offers.filter(offer => offer.provider === scope.provider);
      return {
        ...scope, regions: scope.regions.filter(region => regions.has(region)),
        offerCount: entries.length, pricedOfferCount: entries.filter(offer => offer.price !== null).length,
        warnings: [...scope.warnings, "Output is restricted to requested regions; global inventory or price inputs may contain other regions."],
      };
    }),
  });
}

/** Verify file hashes, then normalize one AWS region at a time; other clouds join their pages together. */
export async function importComputeArchive(directory: string, options: NormalizeComputeOptions): Promise<ComputeCatalog> {
  const root = resolve(directory);
  const manifest = ManifestSchema.parse(await readBoundedJson(join(root, "manifest.json"), 4 * 1024 * 1024));
  const seen = new Set<string>();
  const groups = new Map<string, Manifest["files"]>();
  for (const file of manifest.files) {
    if (seen.has(file.file)) throw new Error("Archive contains duplicate filenames.");
    seen.add(file.file);
    if (!file.kind.startsWith(`${manifest.request.provider}_`)) throw new Error("Archive provider does not match its snapshots.");
    if (manifest.request.provider === "aws" && !file.region) throw new Error("AWS archived snapshots need an explicit source region.");
    const key = manifest.request.provider === "aws" ? file.region! : manifest.request.provider;
    const entries = groups.get(key) ?? [];
    entries.push(file);
    groups.set(key, entries);
  }
  const catalogs: ComputeCatalog[] = [];
  for (const entries of groups.values()) {
    let groupBytes = 0;
    for (const entry of entries) {
      const metadata = await lstat(join(root, entry.file));
      if (!metadata.isFile()) throw new Error("Archived snapshots must be regular files, not symbolic links.");
      groupBytes += metadata.size;
      if (groupBytes > MAX_COMPUTE_JOIN_BYTES) throw new Error("Snapshot join group exceeds the 512 MiB in-memory import limit. Use a smaller complete collection or a streaming index importer.");
    }
    const snapshots: RawComputeSnapshot[] = [];
    for (const entry of entries) {
      const bytes = await readBoundedBytes(join(root, entry.file), MAX_RAW_COMPUTE_SNAPSHOT_BYTES);
      if (hash(bytes) !== entry.sha256) throw new Error("Archived snapshot checksum mismatch; recollect before importing.");
      let input: unknown;
      try { input = JSON.parse(bytes.toString("utf8")) as unknown; }
      catch { throw new Error("Archived snapshot is not valid JSON."); }
      const parsed = parseRawComputeSnapshots(input);
      if (parsed.length !== 1 || parsed[0]!.kind !== entry.kind || parsed[0]!.region !== entry.region) throw new Error("Archived snapshot does not match its manifest entry.");
      snapshots.push(parsed[0]!);
    }
    catalogs.push(normalizeComputeSnapshots(snapshots, options));
  }
  return restrictRegions(mergeComputeCatalogs(catalogs, options), manifest.request.regions);
}
