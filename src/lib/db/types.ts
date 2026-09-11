/**
 * The store contract: the shape `src/lib/db/store.ts` is a façade over.
 *
 * This file is types only — no `node:` imports, no env, no filesystem — so it
 * is safe for any layer to import. Exactly one implementation exists today
 * (`./file-store`, the embedded JSON snapshot + JSONL logs); the interface is
 * here so a second one (Postgres) can be added without touching the ~113 files
 * that import `@/lib/db/store`.
 *
 * ### Sync now, async later
 *
 * Every method below is **synchronous**, because the file store is synchronous
 * and this phase changes no behaviour and no call site. A Postgres store
 * cannot be: `db()`, `save()`, the audit readers and `readEvents()` would all
 * return promises against a network round trip. Making them `Promise`-typed
 * now would churn every one of those call sites for an implementation that
 * does not exist yet, so the async-ness is documented per method (`ASYNC:`
 * notes) and deferred to the phase that introduces it. When that phase lands,
 * the widening happens here first and the compiler enumerates the call sites.
 *
 * The one method that is already async-shaped in spirit is `flushPending()`,
 * which the request edge (`src/lib/server/request.ts`) awaits today.
 */
import type {
  AlertEvent,
  AlertOutboxEntry,
  AlertRule,
  AuditEvent,
  CloudConnection,
  Deployment,
  DeploymentEvent,
  Environment,
  Manifest,
  Member,
  NavigatorRun,
  Project,
  Revision,
  SecurityFinding,
  Workspace,
} from "@/lib/domain/types";

/**
 * The whole hot state, as one in-memory object. Mutated in place by callers
 * and written back wholesale by `save()`.
 *
 * ASYNC: a Postgres store cannot hand back a live mutable graph like this. The
 * migration is per-collection repositories behind the same façade, not a
 * `Promise<Database>` — but that is a later phase's problem, not this one's.
 */
export interface Database {
  workspaces: Workspace[];
  members: Member[];
  connections: CloudConnection[];
  projects: Project[];
  environments: Environment[];
  revisions: Revision[];
  deployments: Deployment[];
  findings: SecurityFinding[];
  navigatorRuns: NavigatorRun[];
  /** standing alert conditions, one per (environment, kind) */
  alertRules: AlertRule[];
  /** the durable record of every time a rule fired; outlives its rule */
  alertEvents: AlertEvent[];
  /** delivery intent, written with the event it belongs to; drained by the sender */
  alertOutbox: AlertOutboxEntry[];
  /**
   * Install-wide settings bag. NOT per-workspace despite the name: `autonomy`
   * is a single install-global level (the dial says so on screen), and
   * `alertChannels`/`invites` are flat lists that carry their own
   * `workspaceId` and must be filtered by the reader. Nothing here is safe
   * to serialize wholesale — channels hold HMAC secrets and webhook URLs,
   * invites hold email addresses — so responses build an allowlisted DTO
   * (see /api/bootstrap) rather than spreading this object.
   */
  settings: Record<string, unknown>;
}

/** Emitted after every successful write. */
export interface StoreChange {
  /**
   * Projects the coalesced saves in this window are known to have touched.
   * **Empty means "unknown, assume any"** — not "nothing changed", since the
   * event only fires after a write actually happened. Callers that know their
   * project pass it to `save(projectId)`; the rest broadcast.
   */
  projectIds: string[];
}

export interface AuditFilter {
  workspaceId?: string;
  projectId?: string;
  /** only rows recorded against this environment */
  environmentId?: string;
  /** max events to return (default 500) */
  limit?: number;
  /** "user" | "navigator" | "system" */
  actorType?: AuditEvent["actor"]["type"];
  /** exact action id, or a prefix ending in "." (e.g. "deploy.") */
  actionId?: string;
  result?: AuditEvent["result"];
  /** ISO timestamp, inclusive lower bound on `ts` */
  from?: string;
  /** ISO timestamp, inclusive upper bound on `ts` */
  to?: string;
  /** opaque page cursor from a previous `readAuditPage` */
  cursor?: string;
}

export interface AuditPage {
  events: AuditEvent[];
  /** pass back as `cursor` for the next (older) page; absent = end of log */
  nextCursor?: string;
}

/** How many audit rows matched, and whether that number is the whole truth. */
export interface AuditCountResult {
  total: number;
  /** false when the count is a floor — the scan budget cut the log short */
  exact: boolean;
}

/** Which implementation backs the store. Mirrors `ZENITH_STORE` in env.ts. */
export type StoreKind = "file" | "postgres";

/**
 * Product A's system of record. One implementation today: `FileStore`.
 *
 * The method names here are the *store's* names (`db`, `reset`); the façade in
 * `store.ts` keeps the historical export names (`db`, `resetDb`) so no
 * importer moves.
 */
export interface Store {
  /**
   * Load once per process and hand back the live object. Callers mutate it in
   * place and then call `save()`.
   *
   * ASYNC: over Postgres this becomes a read, so it (or per-collection
   * successors) would return a promise.
   */
  db(): Database;

  /**
   * Persist. Implementations may coalesce; `projectId` is a hint for the
   * change event, never a filter on what is written.
   *
   * ASYNC: stays fire-and-forget over Postgres — the write is already
   * deferred — but the coalescer's flush becomes awaitable.
   */
  save(projectId?: string): void;

  /** Write any pending save immediately. Idempotent. */
  flush(): void;

  /**
   * Write a *scheduled* save immediately, and say whether there was one. The
   * serverless request edge calls this before answering.
   */
  flushPending(): boolean;

  /** Reset everything, optionally seeding it. Used by the seed script and tests. */
  reset(data?: Partial<Database>): Database;

  /** Append one deployment event to the append-only log. */
  appendEvent(e: DeploymentEvent): void;

  /**
   * Events for one deployment with `seq > afterSeq`, oldest first.
   *
   * ASYNC: a query over Postgres.
   */
  readEvents(deploymentId: string, afterSeq?: number): DeploymentEvent[];

  /** Append one audit row to the append-only log. */
  appendAudit(e: AuditEvent): void;

  /** One page of audit rows, newest first. */
  readAuditPage(filter?: AuditFilter): AuditPage;

  /** Back-compatible reader: newest first, no cursor. */
  readAudit(filter?: AuditFilter): AuditEvent[];

  /** How many rows match, and whether the number is exact. */
  countAudit(filter?: AuditFilter): AuditCountResult;

  /**
   * A revision's manifest, loaded from cold storage on demand.
   *
   * `revision.manifest` returns the same object — implementations attach a
   * **non-enumerable** lazy accessor to every `Revision`, which is what keeps
   * manifests out of `JSON.stringify(db())`. Use this accessor wherever the
   * manifest has to survive serialisation (an API response body, a
   * structuredClone), because the property is dropped by `JSON.stringify`.
   */
  revisionManifest(id: string): Manifest | undefined;

  /** Subscribe to write notifications. Returns an unsubscribe function. */
  onChange(fn: (c: StoreChange) => void): () => void;

  /** True when a change event concerns this project (or names no project). */
  changed(c: StoreChange, projectId: string): boolean;
}
