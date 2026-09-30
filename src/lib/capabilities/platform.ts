/**
 * The `Broker` facade and `platformBroker()`, the one way application code
 * (the REST routes, later MCP v3 and the workflow activities) obtains a broker.
 *
 * WHICH STORE. `platformBroker()` never guesses:
 *  - `ZENITH_PLATFORM_BROKER_MEMORY=1` → a process-wide `MemoryBrokerStore`.
 *    For tests and local development ONLY: state is per-process and lost on
 *    restart, and two instances share nothing. Never set it in production.
 *  - otherwise, if the orchestrator has called `registerPlatformBrokerStore()`
 *    with the platform control store adapter, that store is used.
 *  - otherwise it throws `platform_store_unavailable`. It NEVER falls back to
 *    memory silently: an authorization ledger that quietly lives in RAM is
 *    worse than one that refuses to start.
 *
 * The other ports default to the product store (`productScopeResolver`,
 * `productRoleResolver`), the jose signer over `ZENITH_CONTROL_SIGNING_JWK`
 * (replaceable through `registerPlatformBrokerPorts`), the system clock and the
 * committed OPA bundle.
 */
import { loadPolicyEngine } from "@/lib/policy";
import type { Principal } from "@/lib/controlplane/types";
import { approve, reject, revokeApproval } from "./approvals";
import { getEnvironmentAutonomy, setEnvironmentAutonomy } from "./autonomy";
import { authorizeRead, check, propose } from "./broker";
import { BrokerError } from "./errors";
import { beginExecution, completeExecution, markUncertain } from "./execution";
import { JoseGrantSigner } from "./grant-signer";
import { MemoryBrokerStore } from "./memory-store";
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

export function platformBroker(): Broker {
  const s = state();
  if (s.override) return s.override;

  let store: BrokerStore | undefined;
  if (isMemoryStoreEnabled()) store = s.memoryStore ??= new MemoryBrokerStore();
  else store = s.registeredStore;
  if (!store) {
    throw new BrokerError(
      "platform_store_unavailable",
      "The platform control store is not connected to the capability broker in this deployment, so capability requests are refused.",
      `An operator must connect the platform store (registerPlatformBrokerStore). For local development only, set ${MEMORY_STORE_ENV}=1.`
    );
  }
  if (s.cached && s.cached.key === store) return s.cached.broker;

  const signer = s.ports.signer ?? new JoseGrantSigner();
  const broker = createBroker({
    store,
    scopes: s.ports.scopes ?? productScopeResolver(),
    roles: s.ports.roles ?? productRoleResolver(),
    signer,
    clock: systemClock,
    policy: () => loadPolicyEngine(),
  });
  s.cached = { key: store, broker };
  return broker;
}

export type { BrowserSessionProof };
