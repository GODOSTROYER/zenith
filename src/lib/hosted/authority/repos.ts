/**
 * The repository set: one object holding one repository per table, all bound
 * to the same connection — in two shapes.
 *
 * `SyncRepos` is what a repository file actually implements: plain methods over
 * `DatabaseSync` statements, the same code they have always been. `Repos` is
 * the shape every caller sees — the same methods with the same arguments, each
 * returning a Promise. The asynchronous surface is what lets a Postgres
 * authority exist later without a single call site changing: `await` is the
 * only thing a caller has to say either way.
 *
 * The mapping is mechanical (`Async<T>`), so a new repository method is
 * promised the moment it is written and nothing has to be listed twice.
 *
 * Every repository takes a `DatabaseSync` rather than reaching for the global
 * authority, which is what lets any combination of them run inside one
 * `tx()` — the grant revoke, the session terminations, the ledger append and
 * the outbox row are one transaction because they are one connection.
 */
import type { DatabaseSync } from "node:sqlite";
import { createAppsRepo, type AppsRepo as SyncAppsRepo } from "./repos/apps";
import { createArtifactsRepo, type ArtifactsRepo as SyncArtifactsRepo } from "./repos/artifacts";
import { createBackupsRepo, type BackupsRepo as SyncBackupsRepo } from "./repos/backups";
import { createDeliveriesRepo, type DeliveriesRepo as SyncDeliveriesRepo } from "./repos/deliveries";
import { createEventsRepo, type EventsRepo as SyncEventsRepo } from "./repos/events";
import { createExchangesRepo, type ExchangesRepo as SyncExchangesRepo } from "./repos/exchanges";
import { createGrantsRepo, type GrantsRepo as SyncGrantsRepo } from "./repos/grants";
import { createInvitesRepo, type InvitesRepo as SyncInvitesRepo } from "./repos/invites";
import { createJobsRepo, type JobsRepo as SyncJobsRepo } from "./repos/jobs";
import { createOutboxRepo, type OutboxRepo as SyncOutboxRepo } from "./repos/outbox";
import { createQuotasRepo, type QuotasRepo as SyncQuotasRepo } from "./repos/quotas";
import { createReleasesRepo, type ReleasesRepo as SyncReleasesRepo } from "./repos/releases";
import { createRevocationsRepo, type RevocationsRepo as SyncRevocationsRepo } from "./repos/revocations";
import { createSessionsRepo, type SessionsRepo as SyncSessionsRepo } from "./repos/sessions";
import { createUsageRepo, type UsageRepo as SyncUsageRepo } from "./repos/usage";

/**
 * The same interface with every method promised. Non-method properties (there
 * are none today) pass through unchanged, and a method that already returns a
 * Promise is not double-wrapped.
 */
export type Async<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K];
};

/** Every table of the control authority, bound to one connection, synchronously. */
export interface SyncRepos {
  apps: SyncAppsRepo;
  grants: SyncGrantsRepo;
  invites: SyncInvitesRepo;
  deliveries: SyncDeliveriesRepo;
  sessions: SyncSessionsRepo;
  exchanges: SyncExchangesRepo;
  jobs: SyncJobsRepo;
  outbox: SyncOutboxRepo;
  artifacts: SyncArtifactsRepo;
  releases: SyncReleasesRepo;
  quotas: SyncQuotasRepo;
  usage: SyncUsageRepo;
  revocations: SyncRevocationsRepo;
  backups: SyncBackupsRepo;
  events: SyncEventsRepo;
}

/**
 * Every table of the control authority as callers use it: one repository per
 * table, every method a Promise.
 *
 * Outside `tx()` one call is one autocommitted statement. Inside `tx()` use the
 * repositories handed to the callback — they run on the transaction that is
 * already open.
 */
export type Repos = { [K in keyof SyncRepos]: Async<SyncRepos[K]> };

export type AppsRepo = Repos["apps"];
export type GrantsRepo = Repos["grants"];
export type InvitesRepo = Repos["invites"];
export type DeliveriesRepo = Repos["deliveries"];
export type SessionsRepo = Repos["sessions"];
export type ExchangesRepo = Repos["exchanges"];
export type JobsRepo = Repos["jobs"];
export type OutboxRepo = Repos["outbox"];
export type ArtifactsRepo = Repos["artifacts"];
export type ReleasesRepo = Repos["releases"];
export type QuotasRepo = Repos["quotas"];
export type UsageRepo = Repos["usage"];
export type RevocationsRepo = Repos["revocations"];
export type BackupsRepo = Repos["backups"];
export type EventsRepo = Repos["events"];

/**
 * Build the synchronous repository set for one connection.
 *
 * The authority wraps this; restore and migration tooling, which owns its own
 * connection and its own `transact()`, uses it directly.
 */
export function createRepos(db: DatabaseSync): SyncRepos {
  return {
    apps: createAppsRepo(db),
    grants: createGrantsRepo(db),
    invites: createInvitesRepo(db),
    deliveries: createDeliveriesRepo(db),
    sessions: createSessionsRepo(db),
    exchanges: createExchangesRepo(db),
    jobs: createJobsRepo(db),
    outbox: createOutboxRepo(db),
    artifacts: createArtifactsRepo(db),
    releases: createReleasesRepo(db),
    quotas: createQuotasRepo(db),
    usage: createUsageRepo(db),
    revocations: createRevocationsRepo(db),
    backups: createBackupsRepo(db),
    events: createEventsRepo(db),
  };
}

/**
 * How one repository call reaches the database. The authority passes the rule
 * it wants: "queue behind whatever else is using the connection" for a call
 * outside a transaction, "run now, on the transaction that is open" inside one.
 */
export type RepoRunner = <T>(call: () => T) => Promise<T>;

/** Promise every method of one repository, keeping `this` bound to it. */
function promised<T extends object>(repo: T, run: RepoRunner): Async<T> {
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(repo) as (keyof T & string)[]) {
    const value = repo[key];
    out[key] =
      typeof value === "function"
        ? (...args: unknown[]) => run(() => (value as (...a: unknown[]) => unknown).apply(repo, args))
        : value;
  }
  return out as Async<T>;
}

/** Wrap a synchronous repository set so every call returns a Promise. */
export function promiseRepos(sync: SyncRepos, run: RepoRunner): Repos {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(sync) as (keyof SyncRepos)[]) out[key] = promised(sync[key], run);
  return out as Repos;
}
