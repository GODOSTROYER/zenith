/**
 * The method groups the Postgres store still hands to `FileStore` — the
 * HYBRID BOUNDARY at the top of `../postgres-store.ts`, made pluggable.
 *
 * Each group defaults to the file store's implementation, verbatim, so nothing
 * about today's behaviour changes. A Phase-3 agent replaces one group from its
 * own module — `setDelegate("audit", myPostgresAudit)` — instead of editing
 * `postgres-store.ts`, which is what lets four of them work at once.
 *
 * Secrets are deliberately absent: they never went through `Store` at all.
 * `src/lib/secrets/index.ts` owns its own encrypted file under `ZENITH_DATA`
 * and has no store hook to delegate, so moving them to Postgres is a change to
 * that module, not a new entry here.
 */
import type { AuditEvent, DeploymentEvent, Manifest } from "@/lib/domain/types";
import { FileStore } from "../file-store";
import type { AuditCountResult, AuditFilter, AuditPage } from "../types";

/** Cold-storage manifests, reachable by revision id. */
export interface ManifestDelegate {
  revisionManifest(id: string): Manifest | undefined;
}

/** The deployment event log. */
export interface EventsDelegate {
  appendEvent(e: DeploymentEvent): void;
  readEvents(deploymentId: string, afterSeq?: number): DeploymentEvent[];
}

/** The audit log: one append, three readers. */
export interface AuditDelegate {
  appendAudit(e: AuditEvent): void;
  readAuditPage(filter?: AuditFilter): AuditPage;
  readAudit(filter?: AuditFilter): AuditEvent[];
  countAudit(filter?: AuditFilter): AuditCountResult;
}

export interface Delegates {
  manifests: ManifestDelegate;
  events: EventsDelegate;
  audit: AuditDelegate;
}

/**
 * Mutable on purpose. Read through the object at call time (never destructured
 * into a local) so a replacement installed after import still takes effect.
 */
export const delegates: Delegates = {
  manifests: {
    revisionManifest: (id) => FileStore.revisionManifest(id),
  },
  events: {
    appendEvent: (e) => FileStore.appendEvent(e),
    readEvents: (deploymentId, afterSeq) => FileStore.readEvents(deploymentId, afterSeq),
  },
  audit: {
    appendAudit: (e) => FileStore.appendAudit(e),
    readAuditPage: (filter) => FileStore.readAuditPage(filter),
    readAudit: (filter) => FileStore.readAudit(filter),
    countAudit: (filter) => FileStore.countAudit(filter),
  },
};

/** Replace one group. Call it once, at import of the module that owns it. */
export function setDelegate<G extends keyof Delegates>(group: G, impl: Delegates[G]): void {
  delegates[group] = impl;
}
