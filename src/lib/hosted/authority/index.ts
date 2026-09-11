/**
 * The hosted control authority: one SQLite file, one connection, one
 * transaction rule.
 *
 * `<ORRERY_DATA>/control.sqlite`, opened through `node:sqlite` with
 * `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON` and
 * `busy_timeout=5000`, every one of them read back before the process is
 * allowed to continue. Apps, grants, invitations, sessions, exchanges, jobs,
 * releases, quotas, usage, revocations, backups and events live here and
 * nowhere else — PLAN-R3 R3-02. The legacy JSON store keeps the infrastructure
 * product; nothing in this directory writes to it.
 *
 * The rule everything else is built on:
 *
 *     const { app } = authority().tx((db) => { ... });   // returns after COMMIT
 *     return NextResponse.json({ app });                  // only then, ACK
 *
 * `tx()` is `BEGIN IMMEDIATE … COMMIT`, synchronous, and returns only once the
 * commit succeeded. Anything that must leave the process — an email, a
 * provider call, a ledger append — is an outbox row written inside that same
 * transaction and performed afterwards by `drainOutbox()`. That is what makes
 * "acknowledged" mean "durable" rather than "probably".
 *
 * This is the only barrel in the directory. Import from
 * `@/lib/hosted/authority`, never from a file inside it.
 */
export {
  authority,
  authorityOpen,
  backupAuthority,
  closeAuthority,
  openAuthority,
  type Authority,
  type OpenAuthorityOptions,
} from "./lifecycle";

export { transact, TX_BACKOFF_MS, TX_MAX_ATTEMPTS, type TransactOptions } from "./tx";

export {
  appliedMigrations,
  migrate,
  MIGRATIONS,
  type AppliedMigration,
  type Migration,
} from "./schema";

export { createRepos, type Repos } from "./repos";

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

export type { AppPatch, AppsRepo, NewApp } from "./repos/apps";
export type { ArtifactsRepo, NewArtifact } from "./repos/artifacts";
export type { BackupsRepo, NewBackupManifest } from "./repos/backups";
export type {
  ClaimedDelivery,
  DeliveriesRepo,
  DeliverySettlement,
  NewDelivery,
} from "./repos/deliveries";
export type { EventQuery, EventsRepo, NewHostedEvent } from "./repos/events";
export type { ExchangesRepo, NewExchange } from "./repos/exchanges";
export type { GrantsRepo, NewGrant } from "./repos/grants";
export type { InvitesRepo, NewInvite } from "./repos/invites";
export type { ClaimedJob, JobsRepo, NewJob } from "./repos/jobs";
export type {
  EnqueueResult,
  NewOutboxEntry,
  OutboxKind,
  OutboxRepo,
  OutboxSettlement,
} from "./repos/outbox";
export { utcDay, type QuotasRepo } from "./repos/quotas";
export type { NewRelease, ReleaseStamps, ReleasesRepo } from "./repos/releases";
export type { NewRevocation, RevocationsRepo } from "./repos/revocations";
export type { NewSession, SessionsRepo, TerminationReason } from "./repos/sessions";
export type { NewUsageEntry, UsageKind, UsageQuery, UsageRepo } from "./repos/usage";
