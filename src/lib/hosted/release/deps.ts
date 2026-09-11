/**
 * The seam every call out of this directory goes through.
 *
 * The publish pipeline is the one place where five other modules meet: the
 * runtime that stages and activates, the build runner and artifact store, the
 * grant check, the usage ledger and the event log. Calling those modules
 * directly from the pipeline would make this directory untestable in the exact
 * scenarios that matter most, because "the probe fails" and "the fence moved
 * under us" are states a real runtime will not produce on demand.
 *
 * So production code reads its collaborators from this one object, whose
 * defaults are the real modules, and a test swaps in a double for the call it
 * needs to steer. Nothing here decides policy; it only decides *who is asked*.
 *
 * The seam holds exactly what a test actually replaces. Two collaborators used
 * to sit here and never be swapped — ending an app's sessions on suspension
 * (`@/lib/hosted/access`) and recording an analytics event
 * (`@/lib/hosted/events`) — so they are imported at their one call site each,
 * in `suspend.ts` and `shared.ts`, where a reader and a code-graph tool can
 * see the edge. Add a member back the moment a test needs to steer it.
 */
import type {
  AppGrant,
  AppRole,
  ArtifactStore,
  BuildRunner,
  HostedRuntime,
  Subject,
  UsageEntry,
} from "@/lib/hosted/contracts";
import { activeGrant, requireAppRole } from "@/lib/hosted/access";
import { FsArtifactStore, StorageArtifactStore } from "@/lib/hosted/artifacts";
import { hostedStoreKind } from "@/lib/hosted/config";
import { selectedBuildRunner } from "@/lib/hosted/build";
import { openAppData } from "@/lib/hosted/data";
import { selectedHostedRuntime } from "@/lib/hosted/runtime";
import { buildsPaused, recordUsage } from "@/lib/hosted/usage";

/** Everything outside `src/lib/hosted/release` that the pipeline calls. */
export interface ReleaseDeps {
  /** The runtime `ZENITH_RUNTIME` selects. Throws `runtime_unavailable` when it cannot run. */
  runtime(): HostedRuntime;
  /** The runner `ZENITH_BUILD_RUNNER` selects, or null when this install has not chosen one. */
  buildRunner(): BuildRunner | null;
  artifactStore(): ArtifactStore;
  /** The caller's active grant at or above `min`, or `forbidden`. */
  requireAppRole(appId: string, subject: Subject, min: AppRole): Promise<AppGrant>;
  activeGrant(appId: string, subject: Subject): Promise<AppGrant | null>;
  recordUsage(entry: Omit<UsageEntry, "id" | "at"> & { at?: string }): Promise<UsageEntry>;
  buildsPaused(workspaceId: string): Promise<{ paused: boolean; reason?: string }>;
  /** The data schema an app's records are stored under; a rollback target must match it. */
  appSchemaVersion(appId: string): Promise<number>;
}

/**
 * The store this install publishes to.
 *
 * A hosted install (`ZENITH_HOSTED_STORE=postgres`) writes artifacts to the
 * object-storage bucket, so every node serving the gateway reads the same
 * bytes; anything else — local development and the whole test suite — writes
 * them under the artifact directory. The storage store is kept rather than
 * rebuilt per call, because it holds the manifest cache its read path depends
 * on; the filesystem one reads its root from config on construction, which a
 * test moves between cases.
 */
let storageStore: StorageArtifactStore | undefined;

function defaultArtifactStore(): ArtifactStore {
  if (hostedStoreKind() !== "postgres") return new FsArtifactStore();
  return (storageStore ??= new StorageArtifactStore());
}

const DEFAULTS: ReleaseDeps = {
  runtime: () => selectedHostedRuntime(),
  buildRunner: () => selectedBuildRunner(),
  artifactStore: defaultArtifactStore,
  requireAppRole: async (appId, subject, min) => requireAppRole(appId, subject, min),
  activeGrant: async (appId, subject) => activeGrant(appId, subject),
  recordUsage: async (entry) => recordUsage(entry),
  buildsPaused: async (workspaceId) => buildsPaused(workspaceId),
  appSchemaVersion: (appId) => openAppData(appId).store.schemaVersion(appId),
};

/**
 * The live collaborators. Production never writes to this object; only
 * `setReleaseDepsForTests` and `resetReleaseDeps` do.
 */
export const releaseDeps: ReleaseDeps = { ...DEFAULTS };

/**
 * Swap in doubles for the duration of a test. Returns the undo, so a test that
 * forgets `resetReleaseDeps()` still cannot leak a double into the next one:
 *
 *     const restore = setReleaseDepsForTests({ runtime: () => probeFails });
 *     try { … } finally { restore(); }
 */
export function setReleaseDepsForTests(patch: Partial<ReleaseDeps>): () => void {
  const before: ReleaseDeps = { ...releaseDeps };
  Object.assign(releaseDeps, patch);
  return () => {
    Object.assign(releaseDeps, before);
  };
}

/** Put every collaborator back to the real module. Tests call it in `afterEach`. */
export function resetReleaseDeps(): void {
  Object.assign(releaseDeps, DEFAULTS);
}
