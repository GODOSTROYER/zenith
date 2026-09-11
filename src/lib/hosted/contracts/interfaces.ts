/**
 * Interfaces between the hosted modules. Implementations live in their owning
 * module; consumers depend on these types only.
 *
 *   BuildRunner      — src/lib/hosted/build
 *   ArtifactStore    — src/lib/hosted/artifacts
 *   AppDataStore     — src/lib/hosted/data
 *   HostedRuntime    — src/lib/hosted/runtime
 *   BackupTarget     — src/lib/hosted/backup
 *   SessionAuthority — src/lib/hosted/access
 *
 * Import from `@/lib/hosted/contracts`.
 */
import type {
  AppRole,
  Artifact,
  ArtifactProvenance,
  BuildRunnerId,
  CandidateProbeResult,
  HostedApp,
  LimitEnforcement,
  RecipeSpec,
  Release,
  RuntimeId,
  Subject,
} from "./types";
import type { ValidatedSource } from "./source-v1";
import type {
  CreateRequestBody,
  EquipmentRequest,
  ListRequestsQuery,
  ListRequestsResult,
  UpdateRequestBody,
} from "./tracker-v1";

/* --------------------------------- build ---------------------------------- */

export interface Availability {
  available: boolean;
  /** why not, in one sentence — present whenever `available` is false */
  reason?: string;
  fix?: string;
}

export interface BuildLogLine {
  ts: string;
  stream: "info" | "stdout" | "stderr";
  line: string;
}

export interface BuildRequest {
  jobId: string;
  appId: string;
  source: ValidatedSource;
  recipe: RecipeSpec;
  limits: { timeoutMs: number; maxLogBytes: number; memoryMb: number };
}

export interface BuildResult {
  ok: boolean;
  /** absolute path of the built output tree (index.html + assets/), present when ok */
  outputDir?: string;
  logs: BuildLogLine[];
  durationMs: number;
  runner: BuildRunnerId;
  /** the runner's honest description of where the build ran */
  boundary: string;
  error?: string;
}

export interface BuildRunner {
  id: BuildRunnerId;
  label: string;
  /** one sentence a screen can show: what this runner does and does not isolate */
  boundary: string;
  availability(): Promise<Availability>;
  run(req: BuildRequest, signal: AbortSignal): Promise<BuildResult>;
}

/* ------------------------------- artifacts -------------------------------- */

export interface ArtifactFile {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

export interface ArtifactStore {
  /**
   * Store a built output tree. Content-addressed: the same bytes yield the same
   * digest and a second put is a verified no-op; different bytes under an
   * existing digest is impossible by construction. Never overwrites.
   */
  put(outputDir: string, provenance: ArtifactProvenance): Promise<Artifact>;
  get(digest: string): Promise<Artifact | null>;
  list(digest: string): Promise<ArtifactFile[]>;
  /** read one file; null when the artifact or path does not exist (never a path outside the artifact) */
  open(digest: string, path: string): Promise<{ bytes: Buffer; file: ArtifactFile } | null>;
  /** recompute the digest over stored bytes and compare with the manifest */
  verify(digest: string): Promise<{ ok: boolean; detail: string }>;
  /** remove an artifact no release references; refuses otherwise */
  remove(digest: string, referencedBy: (digest: string) => Promise<boolean>): Promise<boolean>;
}

/* ---------------------------------- data ---------------------------------- */

export interface DataContext {
  appId: string;
  subject: Subject;
  email: string;
  role: AppRole;
  /** the release that served the request, recorded on every write */
  releaseId: string;
}

/** The fixed broker's operations. Every mutation is transactional with its write id and quota. */
export interface AppDataStore {
  list(ctx: DataContext, query: ListRequestsQuery): Promise<ListRequestsResult>;
  get(ctx: DataContext, id: string): Promise<EquipmentRequest | null>;
  create(ctx: DataContext, body: CreateRequestBody): Promise<{ record: EquipmentRequest; replayed: boolean }>;
  update(
    ctx: DataContext,
    id: string,
    body: UpdateRequestBody
  ): Promise<{ record: EquipmentRequest; replayed: boolean }>;
  /** logical bytes currently stored, for the storage quota */
  storageBytes(appId: string): Promise<number>;
  /** read-only compatibility check used before activating a candidate */
  schemaVersion(appId: string): Promise<number>;
}

/* -------------------------------- runtime --------------------------------- */

export interface RuntimeAppRef {
  runtime: RuntimeId;
  /** stable per-app identifiers (local: data dir; cloudflare: d1 id, broker script) */
  ref: Record<string, unknown>;
}

export interface RuntimeCandidateRef {
  runtime: RuntimeId;
  releaseId: string;
  ref: Record<string, unknown>;
}

export interface BindingReadback {
  ok: boolean;
  /** what the runtime reports bound to the editable release and to the broker */
  release: string[];
  broker: string[];
  detail: string;
}

export interface HostedRuntime {
  id: RuntimeId;
  label: string;
  availability(): Promise<Availability>;
  enforcement: LimitEnforcement;
  /** hostname the stable URL uses for this app */
  hostname(app: HostedApp): string;
  ensureApp(app: HostedApp): Promise<RuntimeAppRef>;
  /** upload/register an immutable candidate; never replaces an existing release */
  stageCandidate(app: HostedApp, release: Release, artifact: Artifact): Promise<RuntimeCandidateRef>;
  /** health + data round trip against a disposable TEST database; production schema read-only */
  probeCandidate(app: HostedApp, candidate: RuntimeCandidateRef): Promise<CandidateProbeResult>;
  /** point the stable hostname at the release; refuses when `fence` is stale */
  activate(app: HostedApp, release: Release, fence: number): Promise<void>;
  readBindings(candidate: RuntimeCandidateRef): Promise<BindingReadback>;
  /** remove candidate resources not in `retain` (active, rollback targets) */
  cleanup(app: HostedApp, retain: Set<string>): Promise<void>;
}

/* --------------------------------- backup --------------------------------- */

export interface BackupTarget {
  id: "filesystem" | "s3";
  label: string;
  availability(): Promise<Availability>;
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  list(prefix: string): Promise<string[]>;
  /** append-only ledger line; must not overwrite */
  append(key: string, line: string): Promise<void>;
}

/* -------------------------------- identity -------------------------------- */

export interface VerifiedIdentity {
  subject: Subject;
  email: string;
  emailVerified: boolean;
  /** identity provider session id when known */
  sessionId?: string;
}

/**
 * Authoritative identity check for grant-sensitive control endpoints. The
 * implementation asks the identity provider (a live round trip), so a token
 * whose session was terminated is refused. Unavailable → `policy_unavailable`,
 * never a pass.
 */
export interface SessionAuthority {
  verify(input: { accessToken?: string }): Promise<VerifiedIdentity>;
}
