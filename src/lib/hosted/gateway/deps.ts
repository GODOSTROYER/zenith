/**
 * The gateway's one seam.
 *
 * The gateway sits on top of four sibling workstreams — access (W5), quota and
 * events (W8), artifacts (W2) and data (W3). Production code calls those
 * modules directly through this object, which is initialised from the real
 * imports; a test replaces individual members with doubles so the admission
 * pipeline can be exercised before every sibling has landed.
 *
 * Two rules keep this honest:
 *
 *  1. The defaults are the real functions. `setGatewayDepsForTests` is the only
 *     way anything else gets in, and nothing in `src/` calls it.
 *  2. Replacing a dependency never replaces a *decision*. Every refusal in
 *     `handle.ts` is decided there; the doubles only supply data.
 *
 * Workstream W6 (hosted R3).
 */
import {
  appSessionCookie,
  clearAppSessionCookie,
  redeemExchange,
  resolveAppSession,
  terminateAppSession,
} from "@/lib/hosted/access";
import { FsArtifactStore } from "@/lib/hosted/artifacts";
import { hostedConfig } from "@/lib/hosted/config";
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
 * One store per artifact root, so a request does not build a new one — and so
 * a test that points `ZENITH_ARTIFACT_DIR` somewhere else gets its own rather
 * than silently reusing the previous root.
 */
const stores = new Map<string, ArtifactStore>();

function defaultArtifactStore(): ArtifactStore {
  const root = hostedConfig().artifactDir;
  const existing = stores.get(root);
  if (existing) return existing;
  const created = new FsArtifactStore(root);
  stores.set(root, created);
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
