/**
 * Data-service portability: the vocabulary (PROD-LIFE-11).
 *
 * Four operations over a data service, each with a deterministic owner:
 *
 *   export   copy the service's logical content into storage the TENANT owns,
 *            with a manifest whose digests anyone can recompute
 *   import   restore an export into a NEW, EMPTY target and read it back from
 *            the target itself (never from what the restore reported)
 *   adopt    take an existing, unmanaged resource under management through an
 *            explicit, human-approved ownership claim plus a drift baseline
 *   release  hand an adopted resource back (the safe "decommission" of an object
 *            Zenith did not create); deletion of adopted objects is refused
 *
 * Pure types: no fs, no env, no store.
 */

export const DATA_KINDS = ["postgres", "mysql", "object_store", "volume"] as const;
export type DataKind = (typeof DATA_KINDS)[number];

export const isDataKind = (kind: string): kind is DataKind => (DATA_KINDS as readonly string[]).includes(kind);

export type PortabilityOperation = "export" | "import" | "adopt" | "release";

/** How strongly a supported path has been exercised in this repository. */
export type SupportEvidence = "local_engine" | "contract";

export type Support =
  | { supported: true; method: string; evidence: SupportEvidence; note?: string }
  | { supported: false; reason: string };

export type ExportEngineId = "postgres-logical-v1" | "mysql-cli-v1" | "s3-objects-v1";

export const EXPORT_SCHEMA = "zenith.portability.export/v1" as const;

export interface ManifestFile {
  /** relative, forward slashes, no traversal */
  name: string;
  sha256: string;
  bytes: number;
}

export interface ExportManifest {
  schema: typeof EXPORT_SCHEMA;
  kind: DataKind;
  engine: ExportEngineId;
  /** server version string read from the source, informational and compared on import */
  engineVersion?: string;
  source: { provider: string; nativeType: string; address: string; externalId?: string };
  scope: { workspaceId: string; environmentId: string; operationId: string };
  createdAt: string;
  files: ManifestFile[];
  /**
   * Digest of the LOGICAL content, produced by the engine's own readback function
   * run against the source. Import recomputes it from the restored target.
   */
  contentDigest: string;
  /** counts and names only, never values */
  coverage: Record<string, number | string[]>;
  /** plain-language steps to restore without Zenith */
  restore: string;
}

/** The names every export carries. */
export const MANIFEST_FILE = "manifest.json";
export const RESTORE_FILE = "RESTORE.md";

/** A single SQL session. The engine issues BEGIN/COMMIT itself, so it must be one connection. */
export interface SqlRunner {
  query(text: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

/** The slice of an object store the object engine needs (S3 and compatible). */
export interface ObjectStorePort {
  /** every key under the prefix, with its size, sorted by key */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  get(key: string): Promise<{ bytes: Buffer; contentType?: string } | null>;
  put(key: string, bytes: Buffer, contentType?: string): Promise<void>;
}

/** Where an export artifact lives: storage the tenant owns. */
export interface ArtifactStore {
  /** human label that never carries credentials, e.g. `s3://bucket` */
  readonly label: string;
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  list(prefix: string): Promise<string[]>;
}

export type EmitFile = (name: string, bytes: Buffer) => Promise<void>;

export interface EngineLimits {
  /** total bytes an export may hold in memory or write */
  maxBytes: number;
  maxRows: number;
  maxObjects: number;
  maxObjectBytes: number;
}

export const DEFAULT_LIMITS: EngineLimits = {
  maxBytes: 128 * 1024 * 1024,
  maxRows: 2_000_000,
  maxObjects: 5_000,
  maxObjectBytes: 64 * 1024 * 1024,
};

/** Result of an engine export: logical digest and coverage; files go out through `emit`. */
export interface EngineExport {
  engineVersion?: string;
  contentDigest: string;
  coverage: Record<string, number | string[]>;
  restore: string;
}

/** Result of an engine readback of a live service. */
export interface EngineReadback {
  contentDigest: string;
  coverage: Record<string, number | string[]>;
}

export type RefusalCode =
  | "unsupported"
  | "unsupported_objects"
  | "limit_exceeded"
  | "target_not_empty"
  | "artifact_invalid"
  | "digest_mismatch"
  | "ownership_unproven"
  | "destination_not_owned"
  | "invalid_input"
  | "unavailable"
  | "verification_failed";

/** A refusal is a clean, pre-effect (or post-verification) failure with a stable code. Messages carry no values. */
export class PortabilityError extends Error {
  readonly code: RefusalCode;
  readonly details?: Record<string, unknown>;
  constructor(code: RefusalCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PortabilityError";
    this.code = code;
    if (details) this.details = details;
  }
}
