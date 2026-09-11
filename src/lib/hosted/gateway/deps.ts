/**
 * The gateway's one seam.
 *
 * The gateway sits on top of four sibling modules — access, quota and events,
 * artifacts and data. Production code calls those modules directly through this
 * object, which is initialised from the real imports; a test replaces individual
 * members with doubles so the admission pipeline can be exercised in isolation.
 *
 * Two rules keep this honest:
 *
 *  1. The defaults are the real functions. `setGatewayDepsForTests` is the only
 *     way anything else gets in, and nothing in `src/` calls it.
 *  2. Replacing a dependency never replaces a *decision*. Every refusal in
 *     `handle.ts` is decided there; the doubles only supply data.
 */
import {
  appSessionCookie,
  clearAppSessionCookie,
  redeemExchange,
  resolveAppSession,
  terminateAppSession,
} from "@/lib/hosted/access";
import { FsArtifactStore, StorageArtifactStore } from "@/lib/hosted/artifacts";
import { hostedConfig, hostedStoreKind } from "@/lib/hosted/config";
import type { ArtifactStore } from "@/lib/hosted/contracts";
import { openAppData } from "@/lib/hosted/data";
import { recordEvent } from "@/lib/hosted/events";
import { admitRequest, readJsonBody } from "@/lib/hosted/quota";

/** Everything the gateway reaches for outside its own directory. */
export interface GatewayDeps {
  resolveAppSession: typeof resolveAppSession;
  redeemExchange: typeof redeemExchange;
  appSessionCookie: typeof appSessionCookie;
  clearAppSessionCookie: typeof clearAppSessionCookie;
  terminateAppSession: typeof terminateAppSession;
  admitRequest: typeof admitRequest;
  readJsonBody: typeof readJsonBody;
  recordEvent: typeof recordEvent;
  /** The store the active release's artifact is read from. */
  artifactStore: () => ArtifactStore;
  openAppData: typeof openAppData;
}

/**
 * One store per artifact root (or bucket), so a request does not build a new
 * one — and so a test that points `ZENITH_ARTIFACT_DIR` somewhere else gets its
 * own rather than silently reusing the previous root. Caching matters for both
 * kinds: each holds the manifest cache the read path depends on.
 */
const stores = new Map<string, ArtifactStore>();

/**
 * The store this install publishes to. A hosted install (`ZENITH_HOSTED_STORE=
 * postgres`) keeps its artifacts in the object-storage bucket, where every node
 * serving the gateway can read them; anything else — local development and the
 * whole test suite — keeps them on disk.
 */
function defaultArtifactStore(): ArtifactStore {
  const config = hostedConfig();
  const storage = hostedStoreKind() === "postgres";
  const key = storage ? `storage:${config.ZENITH_ARTIFACT_BUCKET}` : `fs:${config.artifactDir}`;
  const existing = stores.get(key);
  if (existing) return existing;
  const created = storage
    ? new StorageArtifactStore({ bucket: config.ZENITH_ARTIFACT_BUCKET })
    : new FsArtifactStore(config.artifactDir);
  stores.set(key, created);
  return created;
}

const REAL: GatewayDeps = {
  resolveAppSession,
  redeemExchange,
  appSessionCookie,
  clearAppSessionCookie,
  terminateAppSession,
  admitRequest,
  readJsonBody,
  recordEvent,
  artifactStore: defaultArtifactStore,
  openAppData,
};

let current: GatewayDeps = { ...REAL };

/** The dependencies this process is running with. Production: the real ones. */
export const gatewayDeps = (): GatewayDeps => current;

/**
 * Tests only. Replaces the named members and returns a function that puts the
 * previous set back, so a test can scope an override to one case.
 */
export function setGatewayDepsForTests(patch: Partial<GatewayDeps>): () => void {
  const previous = current;
  current = { ...current, ...patch };
  return () => {
    current = previous;
  };
}

/** Tests only. Back to the real modules. */
export function resetGatewayDeps(): void {
  current = { ...REAL };
  stores.clear();
}
