/**
 * Product A's system of record — the façade.
 *
 * Everything the rest of the codebase knows about persistence comes through
 * this module: `db()`, `save()`, `q.*`, `onChange()` and the append/read
 * helpers. Since the store gained an interface, that is all this file is — a
 * selector plus one delegating export per name, so the ~113 files that import
 * `@/lib/db/store` are unchanged and unaware of which implementation answers.
 *
 *   ./types.ts          the `Store` contract and its record types
 *   ./file-store.ts     JSON snapshot + JSONL logs; the default
 *   ./postgres-store.ts Supabase Postgres, with a request-scoped snapshot
 *   this file           chooses one (ZENITH_STORE) and re-exports it
 *
 * `ZENITH_STORE` is `"file"` (the default) or `"postgres"`. The Postgres store
 * owns the organisational slice — workspaces, members, invites, connections,
 * projects, environments, settings — and *delegates the rest to the file store*
 * until Phase 3. That hybrid is documented at the top of `./postgres-store.ts`
 * and in docs/ARCHITECTURE.md (ADR 1); it is real debt, stated rather than
 * hidden.
 *
 * The durability contract, the hot/cold split and the change-event semantics
 * are documented where they are implemented — see `./file-store.ts` and
 * `./postgres-store.ts`.
 */
import { env } from "@/lib/env";
import type { AuditEvent, DeploymentEvent, Manifest } from "@/lib/domain/types";
import { FileStore } from "./file-store";
import { PostgresStore } from "./postgres-store";
import type {
  AuditCountResult,
  AuditFilter,
  AuditPage,
  Database,
  Store,
  StoreChange,
  StoreKind,
} from "./types";

export type {
  AuditCountResult,
  AuditFilter,
  AuditPage,
  Database,
  Store,
  StoreChange,
  StoreKind,
};

type GStore = typeof globalThis & { __zenithStore?: Store };

function selectStore(kind: StoreKind): Store {
  return kind === "postgres" ? PostgresStore : FileStore;
}

/**
 * True when this process is answering out of Postgres. The request edge asks,
 * because a Postgres write is a network round trip that must complete before
 * the response leaves — see `flushMutation` in `server/request.ts`.
 */
export const isPostgres = (): boolean => env().ZENITH_STORE === "postgres";

/**
 * The store this process uses. Chosen once — the selection reads the
 * environment, and the implementations own process-wide state on `globalThis`,
 * so swapping one mid-process would strand an open database.
 */
function currentStore(): Store {
  const g = globalThis as GStore;
  return (g.__zenithStore ??= selectStore(env().ZENITH_STORE));
}

/* ----------------------- the historical export surface ---------------------- */

/** Load (once per process; survives Next.js HMR via globalThis). */
export const db = (): Database => currentStore().db();

/** Persist, coalesced. `projectId` is a hint for the change event. */
export const save = (projectId?: string): void => currentStore().save(projectId);

/** Write any pending save immediately. Idempotent. */
export const flush = (): void => currentStore().flush();

/** Write a *scheduled* save immediately, and say whether there was one. */
export const flushPending = (): boolean => currentStore().flushPending();

/**
 * The same, but awaitable — the only honest shape over a network store.
 *
 * The file store answers synchronously and this resolves immediately; the
 * Postgres store returns once its writes have actually landed. `route()` awaits
 * this after every mutating handler, which is what makes "commit before ACK"
 * true on both implementations.
 */
export const flushPendingAsync = async (): Promise<boolean> => {
  const store = currentStore() as Store & { flushAsync?: () => Promise<boolean> };
  return store.flushAsync ? store.flushAsync() : store.flushPending();
};

/** Reset everything (used by seed script). */
export const resetDb = (data?: Partial<Database>): Database => currentStore().reset(data);

export const appendEvent = (e: DeploymentEvent): void => currentStore().appendEvent(e);

export const readEvents = (deploymentId: string, afterSeq = -1): DeploymentEvent[] =>
  currentStore().readEvents(deploymentId, afterSeq);

export const appendAudit = (e: AuditEvent): void => currentStore().appendAudit(e);

export const readAuditPage = (filter: AuditFilter = {}): AuditPage =>
  currentStore().readAuditPage(filter);

/** Back-compatible reader: newest first, no cursor. */
export const readAudit = (filter: AuditFilter = {}): AuditEvent[] =>
  currentStore().readAudit(filter);

export const countAudit = (filter: AuditFilter = {}): AuditCountResult =>
  currentStore().countAudit(filter);

/**
 * Called after every successful write. Returns an unsubscribe function.
 *
 * In-process only — the same single-process ceiling as the store itself. It is
 * what lets `/api/projects/:id/stream` push instead of every open tab polling.
 */
export const onChange = (fn: (c: StoreChange) => void): (() => void) =>
  currentStore().onChange(fn);

/** True when a change event concerns this project (or names no project). */
export const changed = (c: StoreChange, projectId: string): boolean =>
  currentStore().changed(c, projectId);

/* ------------------------------ tiny queries ------------------------------- */

export const q = {
  workspace: (id: string) => db().workspaces.find((w) => w.id === id || w.slug === id),
  project: (id: string) => db().projects.find((p) => p.id === id || p.slug === id),
  environment: (id: string) => db().environments.find((e) => e.id === id),
  environmentsOf: (projectId: string) =>
    db().environments.filter((e) => e.projectId === projectId),
  revision: (id: string) => db().revisions.find((r) => r.id === id),
  /**
   * A revision's manifest, loaded from cold storage on demand.
   *
   * `revision.manifest` returns the same object — the property is a lazy
   * accessor. Use this accessor wherever the manifest has to survive
   * serialisation (an API response body, a structuredClone), because the
   * property is non-enumerable and `JSON.stringify` drops it.
   */
  revisionManifest: (id: string): Manifest | undefined => currentStore().revisionManifest(id),
  revisionsOf: (projectId: string) =>
    db()
      .revisions.filter((r) => r.projectId === projectId)
      .sort((a, b) => b.number - a.number),
  deployment: (id: string) => db().deployments.find((d) => d.id === id),
  deploymentsOf: (environmentId: string) =>
    db()
      .deployments.filter((d) => d.environmentId === environmentId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  connection: (id: string) => db().connections.find((c) => c.id === id),
};

/**
 * Tenancy guard for id-lookup routes. An object id is a bearer token: knowing
 * one must not be enough to read it from another workspace. Every /api route
 * that resolves an object by id checks this and 404s when it fails — 404, not
 * 403, so the id space is not enumerable either.
 */
export const inWorkspace = (workspaceId: string, projectId: string): boolean =>
  q.project(projectId)?.workspaceId === workspaceId;
