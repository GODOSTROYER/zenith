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
 * **Package P1a implements only what the boot path needs to start**: `jobs`
 * (the runner's queue, claims, leases and phase data) and `outbox` (every
 * effect that leaves the process). `hosted.schema_migrations` is read by
 * `migrations.ts`, which is not part of `Repos` because no caller has ever
 * wanted it. Everything else is a named stub — see `stubs.ts` for why the gaps
 * are filled rather than omitted, and `README.md` for the helper API a
 * repository package writes against.
 *
 * **Adding a repository is two lines.** Write `pg/repos/<table>.ts` exporting
 * `createPg<Table>Repo(sql)`, then replace its `stub<…>(…)` line below with a
 * call to it. Nothing else in this directory changes.
 */
import type {
  AppsRepo,
  ArtifactsRepo,
  BackupsRepo,
  DeliveriesRepo,
  EventsRepo,
  ExchangesRepo,
  GrantsRepo,
  InvitesRepo,
  QuotasRepo,
  ReleasesRepo,
  Repos,
  RevocationsRepo,
  SessionsRepo,
  UsageRepo,
} from "../../repos";
import type { Sql, TransactionSql } from "../client";
import { createPgJobsRepo } from "./jobs";
import { createPgOutboxRepo } from "./outbox";
import { stub } from "./stubs";

/** Every table of the control authority, bound to one connection or transaction. */
export function bindPgRepos(sql: Sql | TransactionSql): Repos {
  return {
    // Implemented in this package.
    jobs: createPgJobsRepo(sql),
    outbox: createPgOutboxRepo(sql),

    // Awaiting their packages. Each method throws naming itself and its file.
    apps: stub<AppsRepo>("apps", [
      "get",
      "getBySlug",
      "insert",
      "listAll",
      "listByWorkspace",
      "setActiveRelease",
      "update",
    ]),
    grants: stub<GrantsRepo>("grants", [
      "activeFor",
      "countActiveOwners",
      "get",
      "insert",
      "listByApp",
      "listBySubject",
      "markNeedsReapproval",
      "revoke",
      "setRole",
    ]),
    invites: stub<InvitesRepo>("invites", [
      "accept",
      "get",
      "getByTokenHash",
      "insert",
      "listByApp",
      "setState",
      "supersede",
    ]),
    deliveries: stub<DeliveriesRepo>("deliveries", [
      "claim",
      "claimPending",
      "clearSealedPayload",
      "get",
      "insert",
      "listByInvite",
      "reclaimStale",
      "settle",
      "settlePending",
    ]),
    sessions: stub<SessionsRepo>("sessions", [
      "appIdsForSubject",
      "get",
      "insert",
      "listByApp",
      "purgeExpired",
      "terminate",
      "terminateByApp",
      "terminateByGrant",
      "terminateBySubject",
    ]),
    exchanges: stub<ExchangesRepo>("exchanges", [
      "consume",
      "get",
      "insert",
      "linkSession",
      "purgeExpired",
    ]),
    artifacts: stub<ArtifactsRepo>("artifacts", ["get", "insert", "list", "markVerified"]),
    releases: stub<ReleasesRepo>("releases", [
      "get",
      "insert",
      "listByApp",
      "markSuperseded",
      "nextNumber",
      "setProbe",
      "setRuntimeRef",
      "setStatus",
    ]),
    quotas: stub<QuotasRepo>("quotas", ["get", "increment", "listByApp", "resetDay"]),
    usage: stub<UsageRepo>("usage", ["append", "listSince", "sumSince"]),
    revocations: stub<RevocationsRepo>("revocations", ["append", "listAfter", "maxSeq"]),
    backups: stub<BackupsRepo>("backups", ["insert", "latest", "list"]),
    events: stub<EventsRepo>("events", ["append", "count", "listSince"]),
  };
}
