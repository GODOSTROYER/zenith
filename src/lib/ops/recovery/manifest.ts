/**
 * Backup manifest for clean-host restore (PROD-OPS-04).
 *
 * A backup is a directory: one file per captured store plus `MANIFEST.json`. The manifest names every component the
 * restore needs, whether it was captured here, covered by another component, or left to a system Zenith does not
 * own (customer OpenTofu state, a managed Temporal namespace), and for each captured file its byte length and
 * SHA-256. `digest` is the SHA-256 of the canonical manifest without the digest field itself, so an edited manifest
 * or an edited file is detected before anything is restored. Nothing secret is ever written: key facts are purpose,
 * key id and role only, and connection strings are never recorded.
 *
 * Honesty rules the types enforce: a component is `captured`, `covered` (by a named other component), `referenced`
 * (outside Zenith's custody; restore needs an explicit operator confirmation) or `skipped` (with a reason the
 * restore refuses by default). There is no status that means "probably fine".
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { canonical, digest } from "@/lib/controlplane/digest";

export const BACKUP_MANIFEST_FORMAT = "zenith.backup-manifest.v1";
export const MANIFEST_FILE = "MANIFEST.json";

export const COMPONENT_IDS = ["platform", "agent", "product", "hosted", "source", "plan_artifacts", "temporal", "artifacts", "customer_state", "keys"] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

/**
 * captured        bytes (or an index and evidence) are in this backup
 * covered         another component's file already contains it (`coveredBy`)
 * referenced      outside Zenith's custody; a restore needs the operator's explicit confirmation
 * not_applicable  the feature is not enabled on this install (the note records the evidence)
 * skipped         it applies but was not captured; a restore refuses unless the operator accepts the gap by name
 */
export type ComponentStatus = "captured" | "covered" | "referenced" | "not_applicable" | "skipped";

export interface ManifestFile {
  /** relative, forward slashes, no traversal */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export type FactValue = string | number | boolean | null;

export interface ManifestComponent {
  readonly id: ComponentId;
  readonly title: string;
  readonly status: ComponentStatus;
  /** how it was captured: pg_dump, file_tree, temporal_cli, key_registry, hosted_bundle, none */
  readonly method: string;
  /** why it is covered, referenced or skipped; empty when captured */
  readonly note: string;
  /** the component that covers this one, when `covered` */
  readonly coveredBy?: ComponentId;
  readonly files: readonly ManifestFile[];
  /** non-secret facts the restore verifies (row counts, schema versions, ids) */
  readonly facts: Readonly<Record<string, FactValue>>;
}

export interface KeyRequirement {
  readonly purpose: string;
  readonly keyId: string;
  readonly role: string;
}

export interface BackupManifest {
  readonly format: typeof BACKUP_MANIFEST_FORMAT;
  readonly backupId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly platform: {
    /** highest platform migration applied when the dump was taken */
    readonly schemaVersion: number;
    /** the recovery epoch recorded in the database at backup time */
    readonly recoveryEpoch: number;
    readonly serverVersion: string;
    /** database clock at the moment the dump snapshot was taken; what RPO is measured from */
    readonly snapshotAt: string;
  };
  readonly keys: readonly KeyRequirement[];
  readonly components: readonly ManifestComponent[];
  readonly digest: string;
}

export type DraftManifest = Omit<BackupManifest, "digest">;

export function manifestDigest(draft: DraftManifest): string {
  return digest(draft);
}

export function sealManifest(draft: DraftManifest): BackupManifest {
  return Object.freeze({ ...draft, digest: manifestDigest(draft) });
}

const REL = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const FILE_METHODS: readonly string[] = ["pg_dump", "file_tree", "hosted_bundle", "artifact_index"];
export const isSafeRelativePath = (p: string): boolean => REL.test(p);

export async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => { hash.update(chunk); bytes += chunk.length; });
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return { sha256: hash.digest("hex"), bytes };
}

export async function describeFile(root: string, relative: string): Promise<ManifestFile> {
  if (!isSafeRelativePath(relative)) throw new Error("A backup file name must be a safe relative path.");
  const { sha256, bytes } = await sha256File(path.join(root, relative));
  return { path: relative, bytes, sha256 };
}

export interface ManifestProblem {
  readonly code: "manifest_unreadable" | "manifest_format" | "manifest_digest" | "file_missing" | "file_size" | "file_digest" | "file_name" | "component_incomplete" | "unknown_component";
  readonly component?: string;
  readonly file?: string;
  readonly detail: string;
}

export interface ManifestVerification {
  readonly ok: boolean;
  readonly manifest?: BackupManifest;
  readonly problems: readonly ManifestProblem[];
  readonly filesChecked: number;
}

/** Parse and structurally validate a manifest JSON text. Never throws; problems are returned. */
export function parseManifest(text: string): { manifest?: BackupManifest; problems: ManifestProblem[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { problems: [{ code: "manifest_unreadable", detail: "MANIFEST.json is not valid JSON." }] }; }
  const m = raw as Partial<BackupManifest> | null;
  if (!m || typeof m !== "object" || m.format !== BACKUP_MANIFEST_FORMAT || !Array.isArray(m.components) || typeof m.digest !== "string" || !m.platform || !Array.isArray(m.keys))
    return { problems: [{ code: "manifest_format", detail: `The manifest is not ${BACKUP_MANIFEST_FORMAT}.` }] };
  const problems: ManifestProblem[] = [];
  const { digest: claimed, ...draft } = m as BackupManifest;
  if (manifestDigest(draft as DraftManifest) !== claimed) problems.push({ code: "manifest_digest", detail: "The manifest digest does not match its content; it was edited or damaged." });
  for (const c of m.components) {
    if (!COMPONENT_IDS.includes(c.id)) problems.push({ code: "unknown_component", component: String(c.id), detail: "The manifest names a component this version does not know." });
    for (const f of c.files ?? []) if (!isSafeRelativePath(f.path)) problems.push({ code: "file_name", component: c.id, file: f.path, detail: "A file name in the manifest is not a safe relative path." });
    if (c.status === "captured" && c.files.length === 0 && FILE_METHODS.includes(c.method)) problems.push({ code: "component_incomplete", component: c.id, detail: "A captured component lists no files." });
  }
  return { manifest: m as BackupManifest, problems };
}

/** Verify a backup directory: manifest digest, every listed file's presence, size and SHA-256. Reads only. */
export async function verifyBackupDirectory(dir: string): Promise<ManifestVerification> {
  let text: string;
  try { text = await readFile(path.join(dir, MANIFEST_FILE), "utf8"); }
  catch { return { ok: false, problems: [{ code: "manifest_unreadable", detail: "MANIFEST.json is missing or unreadable." }], filesChecked: 0 }; }
  const parsed = parseManifest(text);
  const problems = [...parsed.problems];
  let checked = 0;
  if (parsed.manifest) {
    for (const component of parsed.manifest.components) {
      for (const file of component.files) {
        if (!isSafeRelativePath(file.path)) continue;
        const full = path.join(dir, file.path);
        let size: number;
        try { size = (await stat(full)).size; }
        catch { problems.push({ code: "file_missing", component: component.id, file: file.path, detail: "A file listed in the manifest is missing." }); continue; }
        checked++;
        if (size !== file.bytes) { problems.push({ code: "file_size", component: component.id, file: file.path, detail: `Size ${size} differs from the manifest (${file.bytes}).` }); continue; }
        const { sha256 } = await sha256File(full);
        if (sha256 !== file.sha256) problems.push({ code: "file_digest", component: component.id, file: file.path, detail: "The SHA-256 differs from the manifest; the file was changed or damaged." });
      }
    }
  }
  return { ok: problems.length === 0, manifest: parsed.manifest, problems, filesChecked: checked };
}

export const canonicalManifest = (m: BackupManifest): string => canonical(m);
