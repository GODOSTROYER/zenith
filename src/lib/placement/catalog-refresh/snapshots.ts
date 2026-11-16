/**
 * Saved-snapshot manifest and integrity checks. A snapshot file is trusted only
 * after its byte length and SHA-256 match the manifest; a mismatch refuses the
 * whole refresh (a silently edited price file must never become catalog data).
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { z } from "zod";
import { sha256Hex } from "@/lib/controlplane/digest";
import { RefreshError, REFRESH_PROVIDERS, SNAPSHOT_FORMATS, type SnapshotEntry, type SnapshotManifest } from "@/lib/placement/catalog-refresh/types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const EntrySchema = z
  .object({
    provider: z.enum(REFRESH_PROVIDERS),
    format: z.enum(SNAPSHOT_FORMATS),
    service: z.string().min(1).max(120),
    region: z.string().min(1).max(60).optional(),
    url: z.string().url().startsWith("https://"),
    retrievedAt: z.string().regex(ISO_DATE),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().positive(),
    file: z.string().min(1).max(200),
  })
  .strict();

const ManifestSchema = z.object({ schema: z.literal(1), snapshots: z.array(EntrySchema).min(1) }).strict();

const FORMAT_FOR_PROVIDER: Record<SnapshotEntry["provider"], SnapshotEntry["format"]> = {
  aws: "aws_price_list",
  gcp: "gcp_billing_catalog",
  azure: "azure_retail_prices",
  oci: "oci_price_list",
};

export function parseManifest(input: unknown): SnapshotManifest {
  const parsed = ManifestSchema.safeParse(input);
  if (!parsed.success) throw new RefreshError("format", `Invalid snapshot manifest: ${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const seen = new Set<string>();
  for (const s of parsed.data.snapshots) {
    if (FORMAT_FOR_PROVIDER[s.provider] !== s.format) throw new RefreshError("format", `Snapshot ${s.file} has format ${s.format}, which is not a ${s.provider} format.`);
    if (isAbsolute(s.file) || normalize(s.file).split(sep).includes("..")) throw new RefreshError("format", `Snapshot path ${s.file} must stay inside the snapshot directory.`);
    if (seen.has(s.file)) throw new RefreshError("format", `Snapshot ${s.file} is listed twice.`);
    seen.add(s.file);
  }
  return parsed.data;
}

/** Throws `RefreshError("integrity")` unless `bytes` is exactly the file the manifest describes. */
export function verifySnapshotBytes(entry: SnapshotEntry, bytes: Uint8Array): void {
  if (bytes.byteLength !== entry.bytes) throw new RefreshError("integrity", `Snapshot ${entry.file} is ${bytes.byteLength} bytes; the manifest says ${entry.bytes}.`);
  if (sha256Hex(bytes) !== entry.sha256) throw new RefreshError("integrity", `Snapshot ${entry.file} does not match its recorded SHA-256.`);
}

export interface LoadedSnapshot {
  entry: SnapshotEntry;
  text: string;
}

/** Reads `<dir>/manifest.json` and every file it lists, verifying each checksum. Offline: reads local files only. */
export function loadSnapshotDirectory(dir: string): LoadedSnapshot[] {
  let manifestText: string;
  try {
    manifestText = readFileSync(join(dir, "manifest.json"), "utf8");
  } catch {
    throw new RefreshError("format", `No readable manifest.json in ${dir}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(manifestText);
  } catch {
    throw new RefreshError("format", "manifest.json is not valid JSON.");
  }
  const manifest = parseManifest(json);
  return manifest.snapshots.map((entry) => {
    const bytes = readFileSync(join(dirname(join(dir, "manifest.json")), entry.file));
    verifySnapshotBytes(entry, bytes);
    return { entry, text: bytes.toString("utf8") };
  });
}
