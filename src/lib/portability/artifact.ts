/**
 * The export artifact: a set of files plus `manifest.json`, written LAST so a
 * partial upload has no manifest and is never mistaken for an export. The
 * manifest lists every file with its SHA-256 and length; its own digest is the
 * identity the platform records. Anyone with the files can recompute all of it.
 */
import { createHash } from "node:crypto";
import { digest } from "@/lib/controlplane/digest";
import { EXPORT_SCHEMA, MANIFEST_FILE, PortabilityError, isDataKind, type ArtifactStore, type ExportManifest, type ManifestFile } from "./types";

export const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** Relative, forward slashes, no traversal; the same rule as the hosted backup bundle. */
export const ARTIFACT_NAME = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

export function assertArtifactName(name: string): string {
  if (!ARTIFACT_NAME.test(name) || name === MANIFEST_FILE) throw new PortabilityError("artifact_invalid", "An artifact file name is not a usable relative path.");
  return name;
}

/** The identity of an export. */
export const manifestDigest = (manifest: ExportManifest): string => digest(manifest);

const HEX64 = /^[0-9a-f]{64}$/;

function parseManifest(bytes: Buffer): ExportManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PortabilityError("artifact_invalid", "The export's manifest is not readable JSON.");
  }
  const m = value as Partial<ExportManifest> | null;
  if (
    !m || typeof m !== "object" || m.schema !== EXPORT_SCHEMA || typeof m.kind !== "string" || !isDataKind(m.kind) || typeof m.engine !== "string" ||
    typeof m.contentDigest !== "string" || !HEX64.test(m.contentDigest) || !Array.isArray(m.files) || !m.source || !m.scope || typeof m.createdAt !== "string"
  ) {
    throw new PortabilityError("artifact_invalid", "The export's manifest has an unknown shape.");
  }
  const names = new Set<string>();
  for (const f of m.files as ManifestFile[]) {
    if (!f || typeof f.name !== "string" || !ARTIFACT_NAME.test(f.name) || f.name === MANIFEST_FILE || typeof f.sha256 !== "string" || !HEX64.test(f.sha256) || !Number.isInteger(f.bytes) || f.bytes < 0 || names.has(f.name)) {
      throw new PortabilityError("artifact_invalid", "The export's manifest lists a malformed or repeated file.");
    }
    names.add(f.name);
  }
  return m as ExportManifest;
}

export interface VerifiedArtifact {
  manifest: ExportManifest;
  manifestDigest: string;
  fileCount: number;
  byteSize: number;
}

/**
 * Read the artifact back from storage and check it against itself: every listed
 * file exists with the recorded length and SHA-256, and nothing unlisted sits
 * beside it. This is what "independently readable" means for the export side.
 */
export async function verifyArtifact(store: ArtifactStore): Promise<VerifiedArtifact> {
  const raw = await store.get(MANIFEST_FILE);
  if (!raw) throw new PortabilityError("artifact_invalid", "The export has no manifest; it was never completed.");
  const manifest = parseManifest(raw);
  let byteSize = raw.length;
  for (const f of manifest.files) {
    const bytes = await store.get(f.name);
    if (!bytes) throw new PortabilityError("artifact_invalid", `An export file is missing from storage: ${f.name}.`);
    if (bytes.length !== f.bytes || sha256(bytes) !== f.sha256) throw new PortabilityError("digest_mismatch", `An export file does not match its recorded digest: ${f.name}.`);
    byteSize += bytes.length;
  }
  const listed = new Set([MANIFEST_FILE, ...manifest.files.map((f) => f.name)]);
  const extra = (await store.list("")).filter((k) => !listed.has(k));
  if (extra.length > 0) throw new PortabilityError("artifact_invalid", `The export location holds files its manifest does not list (${extra.length}); it is not a clean export.`);
  return { manifest, manifestDigest: manifestDigest(manifest), fileCount: manifest.files.length, byteSize };
}

/** A reader over a verified artifact that re-checks each file's digest at the moment it is used. */
export function checkedReader(store: ArtifactStore, manifest: ExportManifest): (name: string) => Promise<Buffer> {
  const files = new Map(manifest.files.map((f) => [f.name, f]));
  return async (name) => {
    const entry = files.get(name);
    if (!entry) throw new PortabilityError("artifact_invalid", "The importer asked for a file the manifest does not list.");
    const bytes = await store.get(name);
    if (!bytes || bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new PortabilityError("digest_mismatch", `An export file does not match its recorded digest: ${name}.`);
    return bytes;
  };
}
