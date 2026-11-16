/**
 * Repository analysis contract: the shapes that carry a repository from bytes
 * to a proposed architecture (steps 1-2 of the AWS acceptance journey,
 * "inspect source; determine requirements").
 *
 *   RepoSnapshot   bounded, text-only, path-safe view of a repository
 *   AppRequirements  what the code needs, every claim with confidence+evidence
 *   ArchitectureProposal  a V1 Manifest plus the reasoning behind it
 *
 * Invariants (see the module docs in `analyze.ts` / `snapshot.ts`):
 *  - repository content is hostile DATA: nothing is executed, installed,
 *    imported or evaluated; nothing here builds a shell string from it;
 *  - environment variable VALUES are never carried into any output type —
 *    only names, classifications and, for non-secret config, a literal default
 *    that is visible in source code;
 *  - "unknown" is a legitimate answer and is listed in `unknowns`.
 */
import type { Manifest, ServiceKind } from "@/lib/domain/types";

/* ------------------------------ confidence ------------------------------- */

export type Confidence = "high" | "medium" | "low";

/** Where a claim was seen. `rule` is a stable identifier, never repository text. */
export interface Evidence {
  path: string;
  line?: number;
  rule: string;
}

export interface Inference<T> {
  value: T;
  confidence: Confidence;
  evidence: Evidence[];
}

/* -------------------------------- snapshot ------------------------------- */

export interface SnapshotSource {
  kind: "tarball" | "github" | "fixture";
  ref?: string;
  commit?: string;
  /** Repository location when one is known, e.g. `https://github.com/owner/name`. */
  repo?: string;
}

export interface RepoFile {
  path: string;
  content: string;
}

export type SkipReason =
  | "traversal"
  | "absolute_path"
  | "bad_path"
  | "path_too_long"
  | "too_deep"
  | "symlink"
  | "hardlink"
  | "special_entry"
  | "oversize"
  | "binary"
  | "duplicate"
  | "irrelevant"
  | "sensitive"
  | "limit_kept_files"
  | "limit_kept_bytes"
  | "limit_entries";

export interface SkippedSummary {
  reason: SkipReason;
  count: number;
  /** A few sanitised, length-capped paths. Attacker-chosen strings: display only. */
  examples: string[];
}

export interface RepoSnapshot {
  files: RepoFile[];
  /** True when a limit stopped the read early — the analysis is then partial. */
  truncated: boolean;
  source: SnapshotSource;
  /** What the builder refused or dropped, by reason. */
  skipped?: SkippedSummary[];
}

export interface SnapshotLimits {
  /** Compressed archive size ceiling. */
  maxCompressedBytes: number;
  /** Decompression ceiling, whatever the archive claims. */
  maxUncompressedBytes: number;
  /** Tar entries examined (files, directories and links alike). */
  maxEntries: number;
  /** Per analysed file. */
  maxFileBytes: number;
  /** Files kept in the snapshot. */
  maxKeptFiles: number;
  /** Total bytes of kept text. */
  maxKeptBytes: number;
  maxPathLength: number;
  maxDepth: number;
}

const MIB = 1_048_576;

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxCompressedBytes: 50 * MIB,
  maxUncompressedBytes: 200 * MIB,
  maxEntries: 20_000,
  maxFileBytes: MIB,
  maxKeptFiles: 5_000,
  maxKeptBytes: 32 * MIB,
  maxPathLength: 240,
  maxDepth: 24,
};

/** A caller-visible input problem (too large, not a tar, bad GitHub coordinates). */
export class AnalysisInputError extends Error {
  readonly code:
    | "compressed_too_large"
    | "uncompressed_too_large"
    | "not_gzip"
    | "empty_archive"
    | "bad_archive"
    | "invalid_coordinates"
    | "fetch_failed"
    | "redirect_refused";
  constructor(code: AnalysisInputError["code"], message: string) {
    super(message);
    this.name = "AnalysisInputError";
    this.code = code;
  }
}

/* ------------------------------ requirements ----------------------------- */

export type Language = "node" | "python" | "go" | "ruby" | "java" | "rust" | "php";

export interface RuntimeRequirement {
  language: Language;
  /** As written in the repository (`>=20`, `3.11`, `17`); not normalised. */
  version?: string;
  root: string;
}

export interface FrameworkRequirement {
  name: string;
  root: string;
  role: "web" | "static" | "worker";
}

/**
 * `mysql`, `mongodb`, `rabbitmq`, `kafka` and `sqlite` are recorded as
 * requirements but Zenith's V1 manifest has no such resource kind
 * (`supportedInV1: false`).
 */
export type DatastoreKind =
  | "postgres"
  | "redis"
  | "object_store"
  | "queue"
  | "email"
  | "mysql"
  | "mongodb"
  | "rabbitmq"
  | "kafka"
  | "sqlite";

export interface DatastoreRequirement {
  kind: DatastoreKind;
  supportedInV1: boolean;
  root: string;
  /** Native flavour when it matters, e.g. `sqs`, `ses`, `smtp`, `s3`. */
  engine?: string;
  /** For queues: which side of the queue this code is on. */
  role?: "publish" | "consume" | "both";
  note?: string;
}

export interface ServiceCandidate {
  name: string;
  /** Directory the service lives in; `""` is the repository root. */
  root: string;
  kind: ServiceKind;
  startCommand?: Inference<string>;
  port?: Inference<number>;
  healthPath?: Inference<string>;
  /** Cron expression, for `kind: "cron"`. */
  schedule?: Inference<string>;
  /** A prebuilt image the repository itself names (compose `image:`). */
  image?: string;
  /** Scheduler that lives inside another service's process (e.g. node-cron). */
  inProcess?: boolean;
  /** For HTTP-triggered cron (vercel.json crons): the path it calls. */
  target?: string;
  note?: string;
}

export interface BuildPlan {
  root: string;
  strategy: "dockerfile" | "buildpack" | "static" | "unknown";
  /** Repository-relative Dockerfile path when strategy is `dockerfile`. */
  dockerfile?: string;
  language?: Language;
  installCommand?: string;
  buildCommand?: string;
  outputDir?: string;
  needsDockerfile: boolean;
  note: string;
}

export interface MigrationRequirement {
  root: string;
  tool: string;
  /** A CANDIDATE command. Analysis never runs it. */
  command: string;
  note?: string;
}

export interface HealthEndpoint {
  root: string;
  path: string;
}

export interface EnvVarRequirement {
  name: string;
  classification: "secret" | "config";
  roots: string[];
  /**
   * A literal default visible in source for a NON-secret name. Absent for
   * every secret and for any name whose value is not evident in code.
   */
  defaultValue?: string;
}

export interface InfrastructureFinding {
  kind:
    | "terraform"
    | "docker-compose"
    | "kubernetes"
    | "serverless"
    | "fly"
    | "render"
    | "vercel"
    | "dockerfile"
    | "procfile";
  path: string;
  detail?: string;
}

export interface MonorepoInfo {
  tool: string;
  packages: { name: string; root: string }[];
}

export interface RepoFinding {
  code: "committed_env" | "secret_in_example_env" | "hardcoded_credentials" | "secret_in_source";
  path: string;
  /** Human sentence. Never contains a secret value. */
  detail: string;
}

export interface AppRequirements {
  schemaVersion: 1;
  source: SnapshotSource;
  truncated: boolean;
  fileCount: number;
  runtimes: Inference<RuntimeRequirement>[];
  frameworks: Inference<FrameworkRequirement>[];
  services: Inference<ServiceCandidate>[];
  builds: Inference<BuildPlan>[];
  datastores: Inference<DatastoreRequirement>[];
  migrations: Inference<MigrationRequirement>[];
  healthEndpoints: Inference<HealthEndpoint>[];
  envVars: Inference<EnvVarRequirement>[];
  infrastructure: Inference<InfrastructureFinding>[];
  monorepo?: Inference<MonorepoInfo>;
  findings: Inference<RepoFinding>[];
  /** Things the analysis could not determine. */
  unknowns: string[];
  /** Things that will hurt if ignored. */
  risks: string[];
}

/* -------------------------------- proposal ------------------------------- */

export interface ProposalIntent {
  environmentClass: "sandbox" | "staging" | "production";
  availability?: "standard" | "high";
  provider?: string;
  regions?: string[];
}

export interface PlacementHints {
  providerPreference?: string[];
  regions?: string[];
  /** A design target for the placement solver, not a promise of an SLA. */
  availabilityTarget?: number;
  tolerateSingleFailure?: boolean;
}

export interface ArchitectureProposal {
  manifest: Manifest;
  explanations: string[];
  placementHints: PlacementHints;
  confidence: Confidence;
  /** Decisions only a human can make (DNS, secret values, unsupported stores). */
  unresolved: string[];
}
