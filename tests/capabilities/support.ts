/**
 * Shared harness for the capability broker tests.
 *
 * `makeHarness()` builds a broker over one of two stores, selected by `kind`:
 *   - "memory": `MemoryBrokerStore` with a controllable clock
 *   - "pglite": `PlatformBrokerStore` over a real PGlite platform store (the
 *     same SQL the production Postgres store runs). One PGlite per test file;
 *     every harness gets its own id prefix, so tests never see each other's rows.
 *   - "postgres": the same adapter over real PostgreSQL, when
 *     `ZENITH_TEST_PLATFORM_PG_URL` is set.
 *
 * Everything else is shared and real: the committed OPA policy bundle, the
 * broker logic, the credential broker's signer (with a generated Ed25519 key).
 * The product-store ports (scope chain, roles) are a small explicit `World` so
 * a test states exactly who is a member of what.
 */
import { afterAll } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import type { Principal, Scope } from "@/lib/controlplane/types";
import { openPlatformDb, repos, type PlatformDbHandle } from "@/lib/controlplane/db";
import { CAPABILITIES, type CapabilityName } from "@/lib/capabilities/catalog";
import { CredentialGrantSigner } from "@/lib/capabilities/credential-signer";
import { MemoryBrokerStore } from "@/lib/capabilities/memory-store";
import { PlatformBrokerStore } from "@/lib/capabilities/platform-store";
import { createBroker, type Broker } from "@/lib/capabilities/platform";
import type { BrokerDeps, BrokerStore, Clock, ResolvedAccess, ResolvedScope, RoleResolver, ScopeResolver } from "@/lib/capabilities/ports";
import type { BrowserSessionProof } from "@/lib/capabilities/types";
import { generateSigningJwk, serializePrivateJwk } from "@/lib/credentials";
import { loadPolicyEngine, type PolicyDecision, type PolicyEngine, type PolicyInput } from "@/lib/policy";

/** Real PostgreSQL lane: runs only when `ZENITH_TEST_PLATFORM_PG_URL` is set (the same variable tests/controlplane uses). */
export const PG_URL = process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim() || undefined;

export type StoreKind = "memory" | "pglite" | "postgres";
export const STORE_KINDS: StoreKind[] = ["memory", "pglite", ...(PG_URL ? (["postgres"] as const) : [])];

/* ---------------------------------- clock ---------------------------------- */

/** Starts at the real time (PGlite stamps rows with the real clock) and only moves when told. */
export class FakeClock implements Clock {
  private ms = Date.now();
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/* ---------------------------------- world ---------------------------------- */

type Role = "viewer" | "editor" | "admin";

export interface World {
  workspaces: Set<string>;
  projects: Map<string, { workspaceId: string }>;
  environments: Map<string, { projectId: string; class: "sandbox" | "staging" | "production"; provider: string; region: string }>;
  resources: Map<string, { environmentId: string; facts: NonNullable<ResolvedScope["resource"]> }>;
  members: Map<string, Role>;
  integrations: Map<string, { subject: string; scopes: string[]; projectIds?: string[]; environmentIds?: string[] }>;
}

const memberKey = (workspaceId: string, userId: string): string => `${workspaceId}|${userId}`;

class WorldScopes implements ScopeResolver {
  constructor(private readonly w: World) {}
  async resolve(scope: Scope): Promise<ResolvedScope | null> {
    const w = this.w;
    if (!w.workspaces.has(scope.workspaceId)) return null;
    const project = scope.projectId ? w.projects.get(scope.projectId) : undefined;
    if (scope.projectId && (!project || project.workspaceId !== scope.workspaceId)) return null;
    const env = scope.environmentId ? w.environments.get(scope.environmentId) : undefined;
    if (scope.environmentId) {
      if (!env) return null;
      const owner = w.projects.get(env.projectId);
      if (!owner || owner.workspaceId !== scope.workspaceId) return null;
      if (scope.projectId && env.projectId !== scope.projectId) return null;
    }
    const projectId = scope.projectId ?? env?.projectId;
    const out: ResolvedScope = { scope: { workspaceId: scope.workspaceId, ...(projectId ? { projectId } : {}), ...(scope.environmentId ? { environmentId: scope.environmentId } : {}) } };
    if (env && scope.environmentId) out.environment = { id: scope.environmentId, class: env.class, provider: env.provider, region: env.region };
    if (scope.resourceId) {
      const resource = w.resources.get(scope.resourceId);
      if (!resource || !scope.environmentId || resource.environmentId !== scope.environmentId) return null;
      out.scope.resourceId = scope.resourceId;
      out.resource = resource.facts;
    }
    return out;
  }
}

class WorldRoles implements RoleResolver {
  constructor(private readonly w: World) {}
  async resolve(principal: Principal, workspaceId: string): Promise<ResolvedAccess> {
    const w = this.w;
    const human = principal.kind === "user" ? principal.id : principal.onBehalfOf;
    const role = (id?: string): ResolvedAccess["role"] => (id ? (w.members.get(memberKey(workspaceId, id)) ?? "none") : "none");
    switch (principal.kind) {
      case "user":
        return { role: role(principal.id) };
      case "navigator":
        return { role: human ? role(human) : w.workspaces.has(workspaceId) ? "editor" : "none" };
      case "integration": {
        const grant = w.integrations.get(memberKey(workspaceId, principal.integrationId ?? principal.id));
        if (!grant || grant.subject !== human) return { role: "none" };
        const r = role(human);
        if (r === "none") return { role: "none" };
        return { role: r, integrationScopes: grant.scopes, ...(grant.projectIds ? { allowedProjectIds: grant.projectIds } : {}), ...(grant.environmentIds ? { allowedEnvironmentIds: grant.environmentIds } : {}) };
      }
      default:
        return { role: "none" };
    }
  }
}

/* -------------------------------- policy engines ---------------------------- */

/** A policy engine that answers with `decide(input)`; `version` is what decisions record as the bundle version. */
export function scriptedEngine(version: string, decide: (input: PolicyInput) => PolicyDecision): PolicyEngine {
  return {
    version,
    async evaluate(input: PolicyInput) {
      return { decision: decide(input), policyVersion: version, inputDigest: digest(input), evaluatedAt: input.context.now };
    },
  };
}

export const requireApproval = (count: number, minRole: "editor" | "admin" = "editor", separationOfDuties = false): PolicyDecision => ({
  outcome: "require_approval",
  reasons: [{ code: "scripted_require_approval", message: "scripted", rule: "test" }],
  approval: { count, minRole, separationOfDuties },
});

export const allowDecision = (constraints?: Record<string, string | number | boolean>): PolicyDecision => ({
  outcome: "allow",
  reasons: [{ code: "scripted_allow", message: "scripted", rule: "test" }],
  ...(constraints ? { constraints } : {}),
});

/* ---------------------------------- harness --------------------------------- */

export interface Ids {
  wsA: string;
  wsB: string;
  projA: string;
  projB: string;
  envAProd: string;
  envAStg: string;
  envASbx: string;
  envBProd: string;
  resAWebProd: string;
  resADbProd: string;
  resAWebSbx: string;
  resBWeb: string;
  intRW: string;
  intRO: string;
  intScoped: string;
}

export interface Harness {
  kind: StoreKind;
  deps: BrokerDeps;
  broker: Broker;
  store: BrokerStore;
  clock: FakeClock;
  world: World;
  ids: Ids;
  /** swap the policy engine mid-test (a new bundle version, a failing engine) */
  setEngine(engine: PolicyEngine | (() => Promise<PolicyEngine>)): void;
  /** make every approval on the operation expired */
  expireApprovals(operationId: string): Promise<void>;
  /** make the operation itself expired */
  expireOperation(operationId: string): Promise<void>;
  /** take an environment lease; returns the scope and its fence token */
  acquireLease(environmentId: string): Promise<{ scope: string; fenceToken: number }>;
  /** release it, so its fence is stale */
  loseLease(scope: string): Promise<void>;
  /** the database handle, when `kind` is "pglite" or "postgres" */
  db?: PlatformDbHandle;
  signerEnv: Record<string, string>;
  publicJwk: () => Promise<Record<string, unknown>>;
}

const shared = new Map<"pglite" | "postgres", Promise<PlatformDbHandle>>();

/**
 * One database handle per engine per test file. Call `closeSharedPgliteAfterAll()`
 * once at the top level of the file. Tests isolate themselves with fresh ids,
 * so the real-Postgres lane never drops or cleans anything.
 */
export function sharedDatabase(kind: "pglite" | "postgres"): Promise<PlatformDbHandle> {
  let db = shared.get(kind);
  if (!db) {
    db = kind === "pglite" ? openPlatformDb({ kind: "pglite" }) : openPlatformDb({ kind: "postgres", url: PG_URL as string, migrate: true, max: 5 });
    shared.set(kind, db);
  }
  return db;
}

export function closeSharedPgliteAfterAll(): void {
  afterAll(async () => {
    const open = [...shared.values()];
    shared.clear();
    for (const db of open) await (await db).close();
  });
}

let counter = 0;
let signingKey: Promise<{ env: Record<string, string>; publicJwk: Record<string, unknown> }> | undefined;
function controlKey() {
  signingKey ??= generateSigningJwk("EdDSA").then((key) => ({ env: { ZENITH_CONTROL_SIGNING_JWK: serializePrivateJwk(key) }, publicJwk: key.publicJwk as unknown as Record<string, unknown> }));
  return signingKey;
}

export async function makeHarness(options: { kind?: StoreKind; engine?: PolicyEngine } = {}): Promise<Harness> {
  const kind = options.kind ?? "memory";
  const p = `t${++counter}x${Math.random().toString(36).slice(2, 7)}`;
  const ids: Ids = {
    wsA: `${p}_wsA`,
    wsB: `${p}_wsB`,
    projA: `${p}_projA`,
    projB: `${p}_projB`,
    envAProd: `${p}_envAProd`,
    envAStg: `${p}_envAStg`,
    envASbx: `${p}_envASbx`,
    envBProd: `${p}_envBProd`,
    resAWebProd: `${p}_resAWebProd`,
    resADbProd: `${p}_resADbProd`,
    resAWebSbx: `${p}_resAWebSbx`,
    resBWeb: `${p}_resBWeb`,
    intRW: `${p}_intRW`,
    intRO: `${p}_intRO`,
    intScoped: `${p}_intScoped`,
  };
  const managedService = { address: "service/web", kind: "container_service", stateful: false, ownership: "managed" as const, publiclyExposed: false };
  const world: World = {
    workspaces: new Set([ids.wsA, ids.wsB]),
    projects: new Map([
      [ids.projA, { workspaceId: ids.wsA }],
      [ids.projB, { workspaceId: ids.wsB }],
    ]),
    environments: new Map([
      [ids.envAProd, { projectId: ids.projA, class: "production", provider: "aws", region: "us-east-1" }],
      [ids.envAStg, { projectId: ids.projA, class: "staging", provider: "aws", region: "us-east-1" }],
      [ids.envASbx, { projectId: ids.projA, class: "sandbox", provider: "sandbox", region: "local" }],
      [ids.envBProd, { projectId: ids.projB, class: "production", provider: "aws", region: "us-east-1" }],
    ]),
    resources: new Map([
      [ids.resAWebProd, { environmentId: ids.envAProd, facts: managedService }],
      [ids.resADbProd, { environmentId: ids.envAProd, facts: { address: "resource/db", kind: "postgres", stateful: true, ownership: "managed", publiclyExposed: false } }],
      [ids.resAWebSbx, { environmentId: ids.envASbx, facts: managedService }],
      [ids.resBWeb, { environmentId: ids.envBProd, facts: managedService }],
    ]),
    members: new Map<string, Role>([
      [memberKey(ids.wsA, "alice"), "admin"],
      [memberKey(ids.wsA, "bob"), "editor"],
      [memberKey(ids.wsA, "carol"), "viewer"],
      [memberKey(ids.wsA, "dave"), "editor"],
      [memberKey(ids.wsA, "erin"), "admin"],
      [memberKey(ids.wsB, "mallory"), "admin"],
    ]),
    integrations: new Map([
      [memberKey(ids.wsA, ids.intRW), { subject: "bob", scopes: ["read", "plan", "logs", "write"] }],
      [memberKey(ids.wsA, ids.intRO), { subject: "bob", scopes: ["read"] }],
      [memberKey(ids.wsA, ids.intScoped), { subject: "bob", scopes: ["read", "write"], projectIds: [ids.projA], environmentIds: [ids.envASbx] }],
    ]),
  };

  const clock = new FakeClock();
  let db: PlatformDbHandle | undefined;
  let store: BrokerStore;
  if (kind === "pglite" || kind === "postgres") {
    db = await sharedDatabase(kind);
    store = new PlatformBrokerStore(db);
  } else {
    store = new MemoryBrokerStore(clock);
  }

  const key = await controlKey();
  let engineSource: () => Promise<PolicyEngine> = options.engine ? async () => options.engine as PolicyEngine : () => loadPolicyEngine();
  const deps: BrokerDeps = {
    store,
    scopes: new WorldScopes(world),
    roles: new WorldRoles(world),
    signer: new CredentialGrantSigner(key.env),
    clock,
    policy: () => engineSource(),
  };

  return {
    kind,
    deps,
    broker: createBroker(deps),
    store,
    clock,
    world,
    ids,
    db,
    signerEnv: key.env,
    publicJwk: async () => key.publicJwk,
    setEngine(engine) {
      engineSource = typeof engine === "function" ? engine : async () => engine;
    },
    async acquireLease(environmentId) {
      const scope = `env:${environmentId}`;
      if (db) {
        const lease = await repos.leases.acquire(db, { scope, holder: "test-worker", ttlMs: 60_000, workspaceId: ids.wsA });
        if (!lease) throw new Error("lease unavailable");
        return { scope, fenceToken: lease.fenceToken };
      }
      return { scope, fenceToken: (store as MemoryBrokerStore).acquireLease(scope) };
    },
    async loseLease(scope) {
      if (db) {
        const current = await repos.leases.current(db, scope);
        if (current) await repos.leases.release(db, current);
      } else (store as MemoryBrokerStore).releaseLease(scope);
    },
    async expireApprovals(operationId) {
      if (db) await db.query("update platform.approvals set expires_at = clock_timestamp() - interval '1 second' where operation_id = $1", [operationId]);
      else clock.advance(61 * 60 * 1000);
    },
    async expireOperation(operationId) {
      if (db) {
        await db.query("update platform.operations set expires_at = clock_timestamp() - interval '1 second' where id = $1", [operationId]);
        await db.query("update platform.approvals set expires_at = least(expires_at, clock_timestamp() - interval '1 second') where operation_id = $1", [operationId]);
      } else clock.advance(25 * 60 * 60 * 1000);
    },
  };
}

/* --------------------------------- builders --------------------------------- */

export const user = (id: string): Principal => ({ kind: "user", id, name: id });
export const integrationOf = (h: Harness, which: "intRW" | "intRO" | "intScoped", onBehalfOf = "bob"): Principal => ({
  kind: "integration",
  id: h.ids[which],
  name: `integration ${which}`,
  integrationId: h.ids[which],
  onBehalfOf,
});
export const navigator = (onBehalfOf?: string): Principal => ({ kind: "navigator", id: "navigator", name: "Navigator", ...(onBehalfOf ? { onBehalfOf } : {}) });
export const systemPrincipal = (): Principal => ({ kind: "system", id: "reconciler", name: "Reconciler" });
export const sessionFor = (subject: string): BrowserSessionProof => ({ method: "browser_session", subject, verifiedAtMs: Date.now() });

export type Where = "prod" | "stg" | "sbx";

/** A request for `capability` at the scope level the catalog demands, in workspace A. */
export function requestFor(h: Harness, capability: CapabilityName, where: Where = "prod", extra: Record<string, unknown> = {}): Record<string, unknown> {
  const def = CAPABILITIES[capability];
  const env = where === "prod" ? h.ids.envAProd : where === "stg" ? h.ids.envAStg : h.ids.envASbx;
  const resource = where === "prod" ? h.ids.resAWebProd : where === "sbx" ? h.ids.resAWebSbx : undefined;
  const scope: Record<string, string> = { workspaceId: h.ids.wsA };
  if (def.scopeLevel !== "workspace") scope.projectId = h.ids.projA;
  if (def.scopeLevel === "environment" || def.scopeLevel === "resource") scope.environmentId = env;
  if (def.scopeLevel === "resource") {
    if (!resource) throw new Error(`no resource in ${where}`);
    scope.resourceId = resource;
  }
  return { capability, scope, ...extra };
}

/** Propose and expect a persisted operation; returns its view and the digest an approver would review. */
export async function proposeOk(h: Harness, request: Record<string, unknown>, principal: Principal, ctx?: Parameters<Broker["propose"]>[2]) {
  const result = await h.broker.propose(request, principal, ctx);
  return { ...result, digest: result.operation.proposalDigest, id: result.operation.id };
}

/** Approve with the operation's current digest as `who`. */
export function approveAs(h: Harness, operation: { id: string; proposalDigest: string }, who: string, workspaceId = h.ids.wsA) {
  return h.broker.approve({ workspaceId, operationId: operation.id, proposalDigest: operation.proposalDigest, approver: user(who), session: sessionFor(who) });
}

/** A real code/message assertion helper for `BrokerError`s. */
export async function expectBrokerError(promise: Promise<unknown>, code: string): Promise<{ code: string; message: string; status: number; fix?: string; details?: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; message: string; status?: number; fix?: string; details?: Record<string, unknown> };
    if (e.code !== code) throw new Error(`expected BrokerError ${code}, got ${e.code ?? "a non-broker error"}: ${e.message}`);
    return e as { code: string; message: string; status: number; fix?: string; details?: Record<string, unknown> };
  }
  throw new Error(`expected BrokerError ${code}, but the call succeeded`);
}
