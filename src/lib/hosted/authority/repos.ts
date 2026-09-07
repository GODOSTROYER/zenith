/**
 * The repository set: one object holding one repository per table, all bound
 * to the same connection.
 *
 * Every repository takes a `DatabaseSync` rather than reaching for the global
 * authority, which is what lets any combination of them run inside one
 * `tx()` — the grant revoke, the session terminations, the ledger append and
 * the outbox row are one transaction because they are one connection.
 *
 * Workstream W1 (hosted R3).
 */
import type { DatabaseSync } from "node:sqlite";
import { createAppsRepo, type AppsRepo } from "./repos/apps";
import { createArtifactsRepo, type ArtifactsRepo } from "./repos/artifacts";
import { createBackupsRepo, type BackupsRepo } from "./repos/backups";
import { createDeliveriesRepo, type DeliveriesRepo } from "./repos/deliveries";
import { createEventsRepo, type EventsRepo } from "./repos/events";
import { createExchangesRepo, type ExchangesRepo } from "./repos/exchanges";
import { createGrantsRepo, type GrantsRepo } from "./repos/grants";
import { createInvitesRepo, type InvitesRepo } from "./repos/invites";
import { createJobsRepo, type JobsRepo } from "./repos/jobs";
import { createOutboxRepo, type OutboxRepo } from "./repos/outbox";
import { createQuotasRepo, type QuotasRepo } from "./repos/quotas";
import { createReleasesRepo, type ReleasesRepo } from "./repos/releases";
import { createRevocationsRepo, type RevocationsRepo } from "./repos/revocations";
import { createSessionsRepo, type SessionsRepo } from "./repos/sessions";
import { createUsageRepo, type UsageRepo } from "./repos/usage";

/** Every table of the control authority, bound to one connection. */
export interface Repos {
  apps: AppsRepo;
  grants: GrantsRepo;
  invites: InvitesRepo;
  deliveries: DeliveriesRepo;
  sessions: SessionsRepo;
  exchanges: ExchangesRepo;
  jobs: JobsRepo;
  outbox: OutboxRepo;
  artifacts: ArtifactsRepo;
  releases: ReleasesRepo;
  quotas: QuotasRepo;
  usage: UsageRepo;
  revocations: RevocationsRepo;
  backups: BackupsRepo;
  events: EventsRepo;
}

/** Build the repository set for one connection. Called once per open. */
export function createRepos(db: DatabaseSync): Repos {
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
