/**
 * The hosted control authority: one SQLite file, one connection, one
 * transaction rule.
 *
 * `<ZENITH_DATA>/control.sqlite`, opened through `node:sqlite` with
 * `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON` and
 * `busy_timeout=5000`, every one of them read back before the process is
 * allowed to continue. Apps, grants, invitations, sessions, exchanges, jobs,
 * releases, quotas, usage, revocations, backups and events live here and
 * nowhere else — PLAN-R3 R3-02. The legacy JSON store keeps the infrastructure
 * product; nothing in this directory writes to it.
 *
 * The rule everything else is built on:
 *
 *     const { app } = await authority().tx(async (repos) => { ... });  // after COMMIT
 *     return NextResponse.json({ app });                               // only then, ACK
 *
 * `tx()` is `BEGIN IMMEDIATE … COMMIT` and resolves only once the commit
 * succeeded. Anything that must leave the process — an email, a provider call,
 * a ledger append — is an outbox row written inside that same transaction and
 * performed afterwards by `drainOutbox()`. That is what makes "acknowledged"
 * mean "durable" rather than "probably".
 *
 * **Promise everywhere.** Every repository method and `tx()` itself return
 * Promises, whichever implementation is behind them. SQLite answers without
 * yielding and Postgres will not, and no call site has to know which: `await`
 * is what a caller writes either way. The raw connection is deliberately not on
 * `Authority` — a caller holding a `DatabaseSync` is a caller that cannot move.
 *
 * This is the only barrel in the directory. Import from
 * `@/lib/hosted/authority`, never from a file inside it.
 */
export {
  authority,
  authorityOpen,
  backupAuthority,
  closeAuthority,
  installAuthority,
  openAuthority,
  type OpenAuthorityOptions,
} from "./lifecycle";

export type { Authority } from "./types";

export { sqliteConnection, type SqliteAuthority } from "./sqlite";

export {
  createPostgresAuthority,
  type PostgresAuthority,
  type PostgresAuthorityOptions,
} from "./pg";

export { createPgAuthorityClient, closePgAuthorityClient, pgIdentity, type Sql } from "./pg/client";

export {
  transact,
  transactAsync,
  TX_BACKOFF_MS,
  TX_MAX_ATTEMPTS,
  type TransactOptions,
} from "./tx";

export {
  appliedMigrations,
  migrate,
  MIGRATIONS,
  type AppliedMigration,
  type Migration,
} from "./schema";

export { createRepos, type Async, type Repos, type SyncRepos } from "./repos";

export { admitJob, hashIntent, type AdmitJobInput, type AdmittedJob } from "./jobs";

export {
  drainOutbox,
  flushOutbox,
  OUTBOX_BACKOFF_MS,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  registeredOutboxKinds,
  registerOutboxHandler,
  replayOutbox,
  type DrainOptions,
  type DrainResult,
  type OutboxHandler,
  type ReplayResult,
} from "./outbox";

export { nowIso } from "./sql";

// The repository *interfaces* are the promised ones, from `./repos`. Their
// input and output shapes are plain data and come from the file that owns the
// table.
export type {
  AppsRepo,
  ArtifactsRepo,
  BackupsRepo,
  DeliveriesRepo,
  EventsRepo,
  ExchangesRepo,
  GrantsRepo,
  InvitesRepo,
  JobsRepo,
  OutboxRepo,
  QuotasRepo,
  ReleasesRepo,
  RevocationsRepo,
  SessionsRepo,
  UsageRepo,
} from "./repos";

export type { AppPatch, NewApp } from "./repos/apps";
export type { NewArtifact } from "./repos/artifacts";
export type { NewBackupManifest } from "./repos/backups";
export { DELIVERY_TRANSPORTS } from "./repos/deliveries";
export type {
  ClaimedDelivery,
  DeliverySettlement,
  DeliveryTransport,
  NewDelivery,
  PendingSettlement,
  TargetedClaim,
} from "./repos/deliveries";
export type { EventQuery, NewHostedEvent } from "./repos/events";
export type { NewExchange } from "./repos/exchanges";
export type { NewGrant } from "./repos/grants";
export type { NewInvite } from "./repos/invites";
export type { ClaimedJob, NewJob, QueuedJob } from "./repos/jobs";
export type { EnqueueResult, NewOutboxEntry, OutboxKind, OutboxSettlement } from "./repos/outbox";
export { utcDay } from "./repos/quotas";
export type { NewRelease, ReleaseStamps } from "./repos/releases";
export type { NewRevocation } from "./repos/revocations";
export type { NewSession, TerminationReason } from "./repos/sessions";
export type { NewUsageEntry, UsageKind, UsageQuery } from "./repos/usage";
