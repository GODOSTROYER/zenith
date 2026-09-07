/**
 * Records held by the hosted control authority (SQLite, `@/lib/hosted/authority`)
 * and the vocabulary every hosted workstream shares.
 *
 * These shapes are the wire and storage truth for hosted apps. Workspace,
 * Member and Project stay in `@/lib/domain/types` and the legacy JSON store;
 * nothing below is ever written there.
 *
 * SPINE FILE — owned by the integrator. Import from `@/lib/hosted/contracts`.
 */

/** Supabase user id (`sub` claim). Never an email: emails change, subjects do not. */
export type Subject = string;

export type AppState = "active" | "suspended" | "recovering" | "deleted";

export interface HostedApp {
  id: string;
  workspaceId: string;
  /** hostname label: lowercase, 3–40 chars, [a-z0-9-], unique across the install */
  slug: string;
  name: string;
  contractVersion: 1;
  /** tracker data schema version the app's data was created under */
  schemaVersion: 1;
  state: AppState;
  stateReason?: string;
  createdBy: Subject;
  createdAt: string;
  updatedAt: string;
  /** durable selected release; null until the first successful activation */
  activeReleaseId: string | null;
  /** monotonically increasing per app; a stale worker holding an older token cannot activate */
  activeFence: number;
  runtime: RuntimeId;
}

export type RuntimeId = "local" | "cloudflare";

/* --------------------------------- access --------------------------------- */

export type AppRole = "owner" | "editor" | "viewer";

export const APP_ROLE_RANK: Record<AppRole, number> = { viewer: 0, editor: 1, owner: 2 };

export type GrantState = "active" | "revoked" | "needs_reapproval";

export interface AppGrant {
  id: string;
  appId: string;
  subject: Subject;
  /** the verified email at grant time, lowercase; display only, never a key */
  email: string;
  role: AppRole;
  state: GrantState;
  grantedBy: Subject;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  revokedBy?: Subject;
  revokedReason?: string;
}

export type InviteState = "pending" | "accepted" | "expired" | "revoked" | "superseded";

export const INVITE_TTL_MS = 48 * 60 * 60_000;

export interface AppInvite {
  id: string;
  appId: string;
  email: string;
  role: AppRole;
  /** sha256 hex of the single-use token; the token itself is never stored in clear */
  tokenHash: string;
  state: InviteState;
  createdBy: Subject;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  acceptedBy?: Subject;
  /** the invite this one replaced (resend) */
  supersedes?: string;
}

export type DeliveryState = "pending" | "sending" | "sent" | "failed";

/**
 * One delivery attempt row per invite. `sent` means the SMTP server accepted
 * the message; delivery to a mailbox is never claimed. The token is kept
 * only as an AES-256-GCM sealed payload so a retry can rebuild the email;
 * the payload is erased when the row settles.
 */
export interface InviteDelivery {
  id: string;
  inviteId: string;
  state: DeliveryState;
  attempts: number;
  createdAt: string;
  claimedAt?: string;
  settledAt?: string;
  /** `none` = no transport configured: the owner must share the link by hand */
  transport?: "smtp" | "log" | "none";
  providerMessageId?: string;
  error?: string;
}

export interface AppSession {
  /** sha256 hex of the opaque cookie value */
  id: string;
  appId: string;
  subject: Subject;
  grantId: string;
  createdAt: string;
  expiresAt: string;
  terminatedAt?: string;
  terminatedReason?: "signed_out" | "revoked" | "expired" | "restored" | "operator";
}

export const APP_SESSION_TTL_MS = 12 * 60 * 60_000;
export const APP_SESSION_COOKIE = "__Host-zenith_app";

export interface AppExchange {
  /** sha256 hex of the single-use code */
  codeHash: string;
  appId: string;
  subject: Subject;
  grantId: string;
  /** opaque browser state echoed back on redemption */
  state: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  sessionId?: string;
}

export const EXCHANGE_TTL_MS = 60_000;

/* ---------------------------------- jobs ---------------------------------- */

export type JobKind = "publish" | "rollback" | "suspend" | "resume" | "export" | "restore";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * A durable operation. `id` is the client's UUID; `intentHash` is SHA-256 over
 * the canonical full intent (actor, workspace, app, kind, input incl. artifact /
 * schema / configuration references). Same id + same hash resumes or replays;
 * same id + different hash is `idempotency_conflict`.
 */
export interface HostedJob {
  id: string;
  kind: JobKind;
  workspaceId: string;
  appId: string;
  actor: Subject;
  intentHash: string;
  status: JobStatus;
  phase: string;
  /** phase-private durable state (provider ids, paths); JSON */
  phaseData: Record<string, unknown>;
  attempts: number;
  leaseOwner?: string;
  leaseUntil?: string;
  /** increments on every lease claim; carried into provider calls and activation */
  fenceToken: number;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export type OutboxState = "pending" | "sending" | "done" | "failed";

/** A side effect committed with the state that needs it, executed after. */
export interface HostedOutboxEntry {
  id: string;
  /** stable key so a retry after a crash does not perform the effect twice */
  idempotencyKey: string;
  kind: "invite_email" | "revocation_ledger" | "provider_cleanup" | "spend_alert" | "webhook";
  payload: Record<string, unknown>;
  state: OutboxState;
  attempts: number;
  createdAt: string;
  claimedAt?: string;
  settledAt?: string;
  error?: string;
}

/* ------------------------------- artifacts -------------------------------- */

export interface RecipeSpec {
  /** the platform recipe id; the only build workflow that ever runs */
  id: "vite-react-v1";
  vite: string;
  pluginReact: string;
  react: string;
  node: string;
}

export interface ArtifactProvenance {
  /** sha256 over the canonical source tree (sorted paths + bytes) */
  sourceDigest: string;
  sourceKind: "tarball" | "directory";
  jobId: string;
  recipe: RecipeSpec;
  contractVersion: 1;
  schemaVersion: 1;
  builtBy: BuildRunnerId;
  /** the runner's own words about its isolation boundary */
  buildBoundary: string;
  builtAt: string;
}

export interface Artifact {
  /** sha256 hex over the canonical output tree; the store key */
  digest: string;
  byteSize: number;
  fileCount: number;
  provenance: ArtifactProvenance;
  createdAt: string;
  /** set by the trusted publisher after recomputing the digest over stored bytes */
  verifiedAt?: string;
}

export type BuildRunnerId = "recipe-local" | "e2b" | "docker";

/* -------------------------------- releases -------------------------------- */

export type ReleaseStatus =
  | "candidate"
  | "verified"
  | "active"
  | "superseded"
  | "failed"
  | "rolled_back";

export interface CandidateProbeResult {
  ok: boolean;
  checkedAt: string;
  /** one row per probe: index fetch, session endpoint, data round trip on the TEST db, schema compat */
  checks: { id: string; ok: boolean; detail: string }[];
  /** never customer data; the test db is disposable */
  testDatabase: string;
}

export interface Release {
  id: string;
  appId: string;
  number: number;
  artifactDigest: string;
  schemaVersion: 1;
  jobId: string;
  status: ReleaseStatus;
  runtime: RuntimeId;
  /** runtime-specific identifiers (script names, database ids, paths) */
  runtimeRef: Record<string, unknown>;
  probe?: CandidateProbeResult;
  createdAt: string;
  verifiedAt?: string;
  activatedAt?: string;
  supersededAt?: string;
  error?: string;
}

/* --------------------------------- quotas --------------------------------- */

export interface HostedLimits {
  buildsPerApp: number;
  buildsPilotWide: number;
  buildTimeoutMs: number;
  requestCpuMs: number;
  outboundSubrequests: number;
  bodyBytes: number;
  requestsPerDay: number;
  storageBytes: number;
}

export const DEFAULT_LIMITS: HostedLimits = {
  buildsPerApp: 1,
  buildsPilotWide: 2,
  buildTimeoutMs: 5 * 60_000,
  requestCpuMs: 50,
  outboundSubrequests: 5,
  bodyBytes: 1_048_576,
  requestsPerDay: 10_000,
  storageBytes: 100 * 1_048_576,
};

/** Which limits the running runtime actually enforces; the rest are displayed as provider limits. */
export type LimitEnforcement = Record<keyof HostedLimits, "enforced" | "provider" | "not_enforced">;

export interface QuotaCounter {
  appId: string;
  /** UTC day, YYYY-MM-DD */
  day: string;
  requests: number;
  denied: number;
}

export interface UsageEntry {
  id: string;
  workspaceId: string;
  appId?: string;
  kind: "build_ms" | "requests" | "storage_bytes" | "emails" | "provider_usd";
  amount: number;
  at: string;
  note?: string;
}

/* ------------------------------ recovery ---------------------------------- */

export interface RevocationLedgerEntry {
  seq: number;
  at: string;
  appId: string;
  grantId: string;
  subject: Subject;
  by: Subject;
  reason: string;
}

export interface BackupManifest {
  id: string;
  createdAt: string;
  /** sha256 of the encrypted payload */
  digest: string;
  byteSize: number;
  files: { name: string; sha256: string; bytes: number }[];
  /** last revocation ledger seq included */
  revocationSeq: number;
  keyId: string;
}

/* -------------------------------- events ---------------------------------- */

/**
 * Provisional event vocabulary. The PDF's page-36 list of eleven events was not
 * available to this revision; reconcile names before pilot reporting.
 */
export const HOSTED_EVENTS = [
  "app.created",
  "source.accepted",
  "source.rejected",
  "build.started",
  "build.succeeded",
  "build.failed",
  "release.verified",
  "release.activated",
  "release.rolled_back",
  "invite.sent",
  "invite.accepted",
  "app.opened",
  "record.created",
  "record.updated",
  "record.conflict",
  "access.denied",
  "grant.revoked",
  "export.completed",
  "restore.completed",
  "backup.completed",
  "app.suspended",
  "app.resumed",
  "session.terminated",
  "spend.threshold",
  "build.paused",
] as const;

export type HostedEventName = (typeof HOSTED_EVENTS)[number];

export type ActorClass = "founder" | "test" | "external" | "system";

export interface HostedEvent {
  id: string;
  event: HostedEventName;
  ts: string;
  workspaceId: string;
  appId?: string;
  /** HMAC of the subject under ZENITH_EVENTS_SALT; never the id or email */
  subjectHash?: string;
  releaseId?: string;
  outcome: "ok" | "error" | "denied";
  /** dedupes retries of one logical operation (write id, job id) */
  logicalId?: string;
  assisted: boolean;
  actorClass: ActorClass;
  /** small, content-free properties (counts, codes, durations) */
  props?: Record<string, string | number | boolean>;
}
