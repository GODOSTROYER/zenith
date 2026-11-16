/**
 * Export and import orchestration, independent of where connections come from.
 * The worker (`src/lib/execution/portability.ts`) resolves vault secrets into a
 * `ServiceBinding`; tests bind real engines (PGlite, the filesystem) directly.
 *
 *   runExport   support check -> engine export through `emit` -> files hashed
 *               and stored in tenant storage -> manifest written LAST -> the
 *               artifact is read back from storage and verified
 *   runImport   artifact verified against the PLATFORM's record (a rewritten
 *               artifact fails) -> target must be empty -> engine import ->
 *               readback through a FRESH connection -> digest compared to the
 *               source's. A mismatch is reported, never papered over.
 */
import { MANIFEST_FILE, PortabilityError, DEFAULT_LIMITS, EXPORT_SCHEMA, type ArtifactStore, type DataKind, type EngineExport, type EngineLimits, type EngineReadback, type ExportManifest, type ManifestFile, type ObjectStorePort, type SqlRunner } from "./types";
import { assertArtifactName, checkedReader, manifestDigest, sha256, verifyArtifact, type VerifiedArtifact } from "./artifact";
import { portabilitySupport } from "./matrix";
import { exportPostgres, importPostgres, readbackPostgres } from "./engines/postgres";
import { exportMysql, importMysql, readbackMysql, type MysqlCli, type MysqlConnection } from "./engines/mysql";
import { exportObjects, importObjects, readbackObjects } from "./engines/objectstore";

export type ServiceBinding =
  | { kind: "postgres"; sql: SqlRunner }
  | { kind: "mysql"; conn: MysqlConnection; cli: MysqlCli }
  | { kind: "object_store"; store: ObjectStorePort };

export interface SourceIdentity { provider: string; nativeType: string; address: string; externalId?: string }

export interface ExportRequest {
  workspaceId: string;
  environmentId: string;
  operationId: string;
  now: Date;
  source: SourceIdentity;
  binding: ServiceBinding;
  store: ArtifactStore;
  limits?: EngineLimits;
}

export interface ExportOutcome extends VerifiedArtifact {
  kind: DataKind;
  engine: ExportManifest["engine"];
  engineVersion?: string;
  contentDigest: string;
  coverage: ExportManifest["coverage"];
}

const ENGINE_OF: Record<Exclude<DataKind, "volume">, ExportManifest["engine"]> = {
  postgres: "postgres-logical-v1",
  mysql: "mysql-cli-v1",
  object_store: "s3-objects-v1",
};

export function assertSupported(operation: "export" | "import", provider: string, kind: string): void {
  const support = portabilitySupport(operation, provider, kind);
  if (!support.supported) throw new PortabilityError("unsupported", support.reason);
}

export async function runExport(req: ExportRequest): Promise<ExportOutcome> {
  const kind = req.binding.kind;
  assertSupported("export", req.source.provider, kind);
  const limits = req.limits ?? DEFAULT_LIMITS;

  // A retry of the same operation finds its finished export and returns it; a different operation never reuses a location.
  const existing = await req.store.get(MANIFEST_FILE);
  if (existing) {
    const verified = await verifyArtifact(req.store);
    if (verified.manifest.scope.operationId !== req.operationId || verified.manifest.scope.workspaceId !== req.workspaceId) {
      throw new PortabilityError("artifact_invalid", "The export location already holds a different export.");
    }
    return outcomeOf(verified);
  }

  const files: ManifestFile[] = [];
  let total = 0;
  const emit = async (name: string, bytes: Buffer): Promise<void> => {
    assertArtifactName(name);
    total += bytes.length;
    if (total > limits.maxBytes * 2) throw new PortabilityError("limit_exceeded", "The export is larger than the limit; it was not completed.");
    if (files.some((f) => f.name === name)) throw new PortabilityError("artifact_invalid", "An engine wrote the same file twice.");
    await req.store.put(name, bytes);
    files.push({ name, sha256: sha256(bytes), bytes: bytes.length });
  };

  let result: EngineExport;
  switch (req.binding.kind) {
    case "postgres":
      result = await exportPostgres(req.binding.sql, emit, { limits });
      break;
    case "mysql":
      result = await exportMysql(req.binding.conn, req.binding.cli, emit, { limits });
      break;
    case "object_store":
      result = await exportObjects(req.binding.store, emit, { limits });
      break;
  }

  const manifest: ExportManifest = {
    schema: EXPORT_SCHEMA,
    kind,
    engine: ENGINE_OF[kind],
    ...(result.engineVersion ? { engineVersion: result.engineVersion } : {}),
    source: { provider: req.source.provider, nativeType: req.source.nativeType, address: req.source.address, ...(req.source.externalId ? { externalId: req.source.externalId } : {}) },
    scope: { workspaceId: req.workspaceId, environmentId: req.environmentId, operationId: req.operationId },
    createdAt: req.now.toISOString(),
    files: files.sort((a, b) => (a.name < b.name ? -1 : 1)),
    contentDigest: result.contentDigest,
    coverage: result.coverage,
    restore: result.restore,
  };
  await req.store.put(MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));

  // Read it back from where the tenant keeps it. Only a verified artifact is an export.
  const verified = await verifyArtifact(req.store);
  if (verified.manifestDigest !== manifestDigest(manifest) || verified.manifest.contentDigest !== result.contentDigest) {
    throw new PortabilityError("verification_failed", "The export read back from storage is not the export that was written.");
  }
  return outcomeOf(verified);
}

function outcomeOf(v: VerifiedArtifact): ExportOutcome {
  return { ...v, kind: v.manifest.kind, engine: v.manifest.engine, ...(v.manifest.engineVersion ? { engineVersion: v.manifest.engineVersion } : {}), contentDigest: v.manifest.contentDigest, coverage: v.manifest.coverage };
}

/** What the platform recorded when the export was made. The artifact must match it. */
export interface RecordedExport {
  manifestDigest: string;
  contentDigest: string;
  kind: DataKind;
  engine: string;
}

export interface ImportRequest {
  recorded: RecordedExport;
  store: ArtifactStore;
  target: { provider: string; kind: DataKind };
  binding: ServiceBinding;
  /** A NEW connection to the same target. Verification never reuses the session that restored. */
  openReadback: () => Promise<{ binding: ServiceBinding; close: () => Promise<void> }>;
  limits?: EngineLimits;
}

export interface ImportOutcome {
  status: "verified" | "mismatch";
  expectedContentDigest: string;
  observedContentDigest: string;
  coverage: Record<string, number | string[]>;
  restored: Record<string, number>;
}

const majorOf = (v: string | undefined): number | undefined => {
  const m = /^(\d+)/.exec(v ?? "");
  return m ? Number(m[1]) : undefined;
};

export async function runImport(req: ImportRequest): Promise<ImportOutcome> {
  assertSupported("import", req.target.provider, req.target.kind);
  const verified = await verifyArtifact(req.store);
  if (verified.manifestDigest !== req.recorded.manifestDigest || verified.manifest.contentDigest !== req.recorded.contentDigest) {
    throw new PortabilityError("digest_mismatch", "The export in storage is not the export Zenith recorded; it was changed after it was made. Nothing was restored.");
  }
  if (verified.manifest.kind !== req.target.kind || req.binding.kind !== req.target.kind || verified.manifest.engine !== req.recorded.engine) {
    throw new PortabilityError("invalid_input", `An export of ${verified.manifest.kind} cannot be restored into a ${req.target.kind} target.`);
  }
  const read = checkedReader(req.store, verified.manifest);
  const limits = req.limits ?? DEFAULT_LIMITS;
  let restored: Record<string, number>;
  switch (req.binding.kind) {
    case "postgres": {
      const target = majorOf(String((await req.binding.sql.query("show server_version"))[0]?.server_version ?? ""));
      const source = majorOf(verified.manifest.engineVersion);
      if (target !== undefined && source !== undefined && target < source) {
        throw new PortabilityError("invalid_input", `The target runs Postgres ${target}, older than the source (${source}); restore into the same or a newer major version.`);
      }
      restored = { ...(await importPostgres(req.binding.sql, read)) };
      break;
    }
    case "mysql":
      restored = { ...(await importMysql(req.binding.conn, req.binding.cli, read, { limits })) };
      break;
    case "object_store":
      restored = { ...(await importObjects(req.binding.store, read, { limits })) };
      break;
  }

  const fresh = await req.openReadback();
  let observed: EngineReadback;
  try {
    if (fresh.binding.kind !== req.target.kind) throw new PortabilityError("verification_failed", "The readback connection does not match the target kind.");
    switch (fresh.binding.kind) {
      case "postgres":
        observed = await readbackPostgres(fresh.binding.sql, { limits });
        break;
      case "mysql":
        observed = await readbackMysql(fresh.binding.conn, fresh.binding.cli, { limits });
        break;
      case "object_store":
        observed = await readbackObjects(fresh.binding.store, { limits });
        break;
    }
  } finally {
    await fresh.close().catch(() => undefined);
  }
  return {
    status: observed.contentDigest === verified.manifest.contentDigest ? "verified" : "mismatch",
    expectedContentDigest: verified.manifest.contentDigest,
    observedContentDigest: observed.contentDigest,
    coverage: observed.coverage,
    restored,
  };
}
