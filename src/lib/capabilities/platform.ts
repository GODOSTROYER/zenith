/**
 * The `Broker` facade and `platformBroker()`, the one way application code
 * (the REST routes, later MCP v3 and the workflow activities) obtains a broker.
 *
 * WHICH STORE. `platformBroker()` never guesses:
 *  - `ZENITH_PLATFORM_BROKER_MEMORY=1` → a process-wide `MemoryBrokerStore`.
 *    For tests and local development ONLY: state is per-process and lost on
 *    restart, and two instances share nothing. Never set it in production.
 *  - otherwise, a store the orchestrator registered with
 *    `registerPlatformBrokerStore()` (tests, or a pre-opened adapter).
 *  - otherwise the PLATFORM CONTROL STORE: `PlatformBrokerStore` over
 *    `platformDb()` (Postgres from `ZENITH_PLATFORM_DB_URL`, or PGlite). In a
 *    production build a store that was not configured explicitly (no
 *    `ZENITH_PLATFORM_DB`, no URL) is refused rather than defaulting to a
 *    local PGlite directory: `platform_store_unavailable`.
 *  If the store cannot be opened the broker answers `platform_store_unavailable`;
 *  it NEVER falls back to memory silently — an authorization ledger that quietly
 *  lives in RAM is worse than one that refuses to start.
 *
 * The other ports default to the product store (`productScopeResolver`,
 * `productRoleResolver`), the credential broker's control-plane signer
 * (`CredentialGrantSigner`, key from `ZENITH_CONTROL_SIGNING_JWK`), the system
 * clock and the committed OPA bundle.
 */
import { platformDb, platformDbConfigFromEnv } from "@/lib/controlplane/db";
import { loadPolicyEngine } from "@/lib/policy";
import type { Principal } from "@/lib/controlplane/types";
import { approve, reject, revokeApproval } from "./approvals";
import { getEnvironmentAutonomy, setEnvironmentAutonomy } from "./autonomy";
import { authorizeRead, check, propose } from "./broker";
import { BrokerError } from "./errors";
import { beginExecution, completeExecution, markUncertain } from "./execution";
import { CredentialGrantSigner } from "./credential-signer";
import { MemoryBrokerStore } from "./memory-store";
import { PlatformBrokerStore } from "./platform-store";
import { cancelOperation, getOperationDetail, listOperationEvents, listOperations } from "./operations";
import { getWorkspacePolicy, setWorkspacePolicy } from "./policy-settings";
import { systemClock, type BrokerDeps, type BrokerStore, type GrantSigner, type RoleResolver, type ScopeResolver } from "./ports";
import { productRoleResolver, productScopeResolver } from "./product-adapters";
import type { BrowserSessionProof, ProposeContext } from "./types";

export const MEMORY_STORE_ENV = "ZENITH_PLATFORM_BROKER_MEMORY";

type Args<F> = F extends (deps: BrokerDeps, ...rest: infer R) => unknown ? R : never;

/** Every broker operation, bound to one set of dependencies. */
export interface Broker {
  readonly deps: BrokerDeps;
  propose(request: unknown, principal: Principal, ctx?: ProposeContext): ReturnType<typeof propose>;
  check(request: unknown, principal: Principal, ctx?: ProposeContext): ReturnType<typeof check>;
  authorizeRead(...args: Args<typeof authorizeRead>): ReturnType<typeof authorizeRead>;
  approve(...args: Args<typeof approve>): ReturnType<typeof approve>;
  reject(...args: Args<typeof reject>): ReturnType<typeof reject>;
  revokeApproval(...args: Args<typeof revokeApproval>): ReturnType<typeof revokeApproval>;
  cancelOperation(...args: Args<typeof cancelOperation>): ReturnType<typeof cancelOperation>;
  getOperationDetail(...args: Args<typeof getOperationDetail>): ReturnType<typeof getOperationDetail>;
  listOperations(...args: Args<typeof listOperations>): ReturnType<typeof listOperations>;
  listOperationEvents(...args: Args<typeof listOperationEvents>): ReturnType<typeof listOperationEvents>;
  beginExecution(...args: Args<typeof beginExecution>): ReturnType<typeof beginExecution>;
  completeExecution(...args: Args<typeof completeExecution>): ReturnType<typeof completeExecution>;
  markUncertain(...args: Args<typeof markUncertain>): ReturnType<typeof markUncertain>;
  getAutonomy(...args: Args<typeof getEnvironmentAutonomy>): ReturnType<typeof getEnvironmentAutonomy>;
  setAutonomy(...args: Args<typeof setEnvironmentAutonomy>): ReturnType<typeof setEnvironmentAutonomy>;
  getWorkspacePolicy(...args: Args<typeof getWorkspacePolicy>): ReturnType<typeof getWorkspacePolicy>;
  setWorkspacePolicy(...args: Args<typeof setWorkspacePolicy>): ReturnType<typeof setWorkspacePolicy>;
}

export function createBroker(deps: BrokerDeps): Broker {
  return {
    deps,
    propose: (request, principal, ctx) => propose(deps, request, principal, ctx),
    check: (request, principal, ctx) => check(deps, request, principal, ctx),
    authorizeRead: (...a) => authorizeRead(deps, ...a),
    approve: (...a) => approve(deps, ...a),
    reject: (...a) => reject(deps, ...a),
    revokeApproval: (...a) => revokeApproval(deps, ...a),
    cancelOperation: (...a) => cancelOperation(deps, ...a),
    getOperationDetail: (...a) => getOperationDetail(deps, ...a),
    listOperations: (...a) => listOperations(deps, ...a),
    listOperationEvents: (...a) => listOperationEvents(deps, ...a),
    beginExecution: (...a) => beginExecution(deps, ...a),
    completeExecution: (...a) => completeExecution(deps, ...a),
    markUncertain: (...a) => markUncertain(deps, ...a),
    getAutonomy: (...a) => getEnvironmentAutonomy(deps, ...a),
    setAutonomy: (...a) => setEnvironmentAutonomy(deps, ...a),
    getWorkspacePolicy: (...a) => getWorkspacePolicy(deps, ...a),
    setWorkspacePolicy: (...a) => setWorkspacePolicy(deps, ...a),
  };
}

/* ------------------------------- wiring state ------------------------------- */

interface PlatformState {
  memoryStore?: MemoryBrokerStore;
  registeredStore?: BrokerStore;
  ports: Partial<{ scopes: ScopeResolver; roles: RoleResolver; signer: GrantSigner }>;
  cached?: { key: object; broker: Broker };
  override?: Broker;
}

type G = typeof globalThis & { __zenithPlatformBroker?: PlatformState };

const state = (): PlatformState => {
  const g = globalThis as G;
  return (g.__zenithPlatformBroker ??= { ports: {} });
};

/** The orchestrator's plug-in point: hand the platform control store adapter to the broker. */
export function registerPlatformBrokerStore(store: BrokerStore): void {
  const s = state();
  s.registeredStore = store;
  s.cached = undefined;
}

/** Replace the default scope/role/signer ports (e.g. the credential broker's signer). */
export function registerPlatformBrokerPorts(ports: Partial<{ scopes: ScopeResolver; roles: RoleResolver; signer: GrantSigner }>): void {
  const s = state();
  s.ports = { ...s.ports, ...ports };
  s.cached = undefined;
}

/** Tests: use exactly this broker (or pass null to restore normal selection). */
export function setPlatformBrokerForTests(broker: Broker | null): void {
  const s = state();
  if (broker) s.override = broker;
  else delete s.override;
}

/** Tests: drop the memory store and every registration. */
export function resetPlatformBrokerForTests(): void {
  (globalThis as G).__zenithPlatformBroker = { ports: {} };
}

export const isMemoryStoreEnabled = (): boolean => process.env[MEMORY_STORE_ENV] === "1";

async function defaultStore(): Promise<BrokerStore> {
  let config;
  try {
    config = platformDbConfigFromEnv();
  } catch {
    throw storeUnavailable("The platform control store is misconfigured (check ZENITH_PLATFORM_DB and ZENITH_PLATFORM_DB_URL).");
  }
  if (process.env.NODE_ENV === "production" && config.source === "default") {
    throw storeUnavailable("This production build has no platform control store configured (ZENITH_PLATFORM_DB_URL), and will not default to a local PGlite directory.");
  }
  try {
    return new PlatformBrokerStore(await platformDb());
  } catch {
    // The store's own error may name hosts or paths; the operator reads the server log.
    throw storeUnavailable("The platform control store could not be opened.");
  }
}

const storeUnavailable = (message: string): BrokerError =>
  new BrokerError(
    "platform_store_unavailable",
    `${message} Capability requests are refused until it is available.`,
    `An operator must configure the platform store. For local development only, ${MEMORY_STORE_ENV}=1 uses a per-process in-memory store.`
  );

export async function platformBroker(): Promise<Broker> {
  const s = state();
  if (s.override) return s.override;

  let store: BrokerStore;
  if (isMemoryStoreEnabled()) store = s.memoryStore ??= new MemoryBrokerStore();
  else if (s.registeredStore) store = s.registeredStore;
  else store = await defaultStore();
  if (s.cached && s.cached.key === store) return s.cached.broker;

  const broker = createBroker({
    store,
    scopes: s.ports.scopes ?? productScopeResolver(),
    roles: s.ports.roles ?? productRoleResolver(),
    signer: s.ports.signer ?? new CredentialGrantSigner(),
    clock: systemClock,
    policy: () => loadPolicyEngine(),
  });
  s.cached = { key: store, broker };
  return broker;
}

export type { BrowserSessionProof };
