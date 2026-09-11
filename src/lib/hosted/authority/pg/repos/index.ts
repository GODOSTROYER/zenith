/**
 * The Postgres repository set, bound to one connection or to one transaction.
 *
 * The same object shape `authority/repos.ts` defines — one repository per
 * table, every method a Promise — so no caller can tell which implementation it
 * was handed. `bindPgRepos(sql)` is called twice per authority: once with the
 * process client, for the autocommitted repositories on `authority().repos`,
 * and once per transaction with that transaction's own tag, for the `repos`
 * handed to a `tx()` callback.
 *
 * Every table has its repository here. `hosted.schema_migrations` is read by
 * `migrations.ts`, which is not part of `Repos` because no caller has ever
 * wanted it. `README.md` documents the helper API a repository is written
 * against.
 *
 * **Adding a repository is two lines.** Write `pg/repos/<table>.ts` exporting
 * `createPg<Table>Repo(sql)`, then add it to the object below. Nothing else in
 * this directory changes.
 */
import type { Repos } from "../../repos";
import type { Sql, TransactionSql } from "../client";
import { createPgAppsRepo } from "./apps";
import { createPgArtifactsRepo } from "./artifacts";
import { createPgBackupsRepo } from "./backups";
import { createPgEventsRepo } from "./events";
import { createPgDeliveriesRepo } from "./deliveries";
import { createPgExchangesRepo } from "./exchanges";
import { createPgGrantsRepo } from "./grants";
import { createPgInvitesRepo } from "./invites";
import { createPgJobsRepo } from "./jobs";
import { createPgOutboxRepo } from "./outbox";
import { createPgQuotasRepo } from "./quotas";
import { createPgReleasesRepo } from "./releases";
import { createPgSessionsRepo } from "./sessions";
import { createPgRevocationsRepo } from "./revocations";
import { createPgUsageRepo } from "./usage";

/** Every table of the control authority, bound to one connection or transaction. */
export function bindPgRepos(sql: Sql | TransactionSql): Repos {
  return {
    // Implemented in this package.
    jobs: createPgJobsRepo(sql),
    outbox: createPgOutboxRepo(sql),

    // Awaiting their packages. Each method throws naming itself and its file.
    apps: createPgAppsRepo(sql),
    grants: createPgGrantsRepo(sql),
    invites: createPgInvitesRepo(sql),
    deliveries: createPgDeliveriesRepo(sql),
    sessions: createPgSessionsRepo(sql),
    exchanges: createPgExchangesRepo(sql),
    artifacts: createPgArtifactsRepo(sql),
    releases: createPgReleasesRepo(sql),
    quotas: createPgQuotasRepo(sql),
    usage: createPgUsageRepo(sql),
    revocations: createPgRevocationsRepo(sql),
    backups: createPgBackupsRepo(sql),
    events: createPgEventsRepo(sql),
  };
}
