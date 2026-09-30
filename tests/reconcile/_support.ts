/**
 * Shared harness for the reconciliation tests: a fake "cloud" (the world the
 * fake driver reads), a fake clock, a fake capability broker that records what
 * it was asked and persists operations into the in-memory ledger the way the
 * real broker would, and the in-memory backend wired into ports.
 *
 * Everything here is a fake and says so: the driver is not an AWS driver, the
 * session is a canary object, the broker is a script. What the tests prove is
 * the CONTROLLER's behaviour against those ports, not any provider's.
 */
import type { ResourceDriver } from "@/lib/drivers/types";
import { expandManifest, type Observation, type ObservedValue, type Presence, type ResourceGraph, type ResourceNode, type RuntimeState } from "@/lib/resources";
import {
  MemoryReconcileBackend,
  type ObserveSessionRequest,
  type ReconcilePassPorts,
  type RepairBroker,
  type RepairProposal,
  type RepairProposalResult,
  type SchedulableEnvironment,
  type StartRepairRequest,
} from "@/lib/reconcile";
import { PROD, webDb } from "../resources/_fixtures";

export const T0 = "2026-10-01T12:00:00.000Z";

export class Clock {
  private t: number;
  constructor(start = T0) {
    this.t = Date.parse(start);
  }
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** The session object handed to drivers. Its contents must never appear in anything persisted. */
export const SESSION_CANARY = "session-canary-7f3a9c-DO-NOT-PERSIST";

export const ENV: SchedulableEnvironment = {
  workspaceId: "ws-1",
  projectId: "proj-1",
  environmentId: "env-prod",
  class: "production",
  provider: "aws",
  region: "us-east-1",
  connection: { id: "conn-1", status: "verified" },
  autonomyLevel: 3,
};

export const graph = (): ResourceGraph => expandManifest(webDb(), PROD);

/** A tiny graph with `n` managed, non-stateful log groups: cheap fleet members. */
export function tinyGraph(environmentId: string, n = 2): ResourceGraph {
  const base = expandManifest(webDb(), { ...PROD, id: environmentId });
  const nodes = base.nodes.filter((x) => x.kind === "log_group").slice(0, 1);
  const extra: ResourceNode[] = Array.from({ length: Math.max(0, n - nodes.length) }, (_, i) => ({ ...nodes[0], address: `log_group/extra-${i}`, specDigest: `${i}`.padStart(64, "0") }));
  return { ...base, nodes: [...nodes, ...extra] };
}

export const known = (value: unknown, observedAt = T0): ObservedValue => ({ state: "known", value, observedAt });

export interface Cloud {
  presence: Presence;
  /** what the provider reports (becomes known attributes) */
  attrs?: Record<string, unknown>;
  /** what the driver says the desired spec maps to; defaults to `attrs` (in sync) */
  expected?: Record<string, unknown>;
  throws?: unknown;
  /** never settles unless aborted */
  hang?: boolean;
  delayMs?: number;
  simulated?: boolean;
  error?: string;
  /** answer for a different address */
  wrongAddress?: boolean;
  runtime?: Partial<RuntimeState> | "throw";
}

/** What the fake provider holds, and a record of how the driver was used. */
export class World {
  readonly cloud = new Map<string, Cloud>();
  readonly observed: { address: string; session: unknown; signal: AbortSignal; tags: Record<string, string> }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  readonly noDriver = new Set<string>();
  /** a mutating call from the driver would land here; the controller must never cause one */
  readonly operationCalls: string[] = [];

  /** Every node of the graph is present and in sync, unless overridden. */
  allPresent(g: ResourceGraph, attrs: Record<string, unknown> = { size: "small" }): this {
    for (const n of g.nodes) if (n.ownership !== "external") this.cloud.set(n.address, { presence: "present", attrs });
    return this;
  }
  set(address: string, c: Cloud): this {
    this.cloud.set(address, c);
    return this;
  }
  patch(address: string, c: Partial<Cloud>): this {
    this.cloud.set(address, { ...(this.cloud.get(address) ?? { presence: "present" }), ...c });
    return this;
  }

  readonly driver: ResourceDriver = {
    id: "fake.driver@1",
    provider: "aws",
    kind: "container_service",
    nativeType: "fake:any",
    capabilities: { compile: false, observe: true, runtime: true, verify: false, discover: false, operations: [], evidence: { observe: "contract" } },
    expectedAttributes: (node) => {
      const c = this.cloud.get(node.address);
      return c?.expected ?? c?.attrs ?? {};
    },
    observe: async (ctx, node) => {
      this.observed.push({ address: node.address, session: ctx.session, signal: ctx.signal, tags: ctx.tags });
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      try {
        const c = this.cloud.get(node.address) ?? { presence: "unknown" as Presence };
        if (c.delayMs) await new Promise((r) => setTimeout(r, c.delayMs));
        if (c.hang) await new Promise<never>((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }));
        if (c.throws !== undefined) throw c.throws;
        const obs: Observation = {
          address: c.wrongAddress ? "service/somebody-else" : node.address,
          presence: c.presence,
          attributes: Object.fromEntries(Object.entries(c.attrs ?? {}).map(([k, v]) => [k, known(v, ctx.now().toISOString())])),
          observedAt: ctx.now().toISOString(),
          source: "fake.driver@1",
          simulated: c.simulated ?? false,
          ...(c.error ? { error: c.error } : {}),
        };
        return obs;
      } finally {
        this.inFlight--;
      }
    },
    runtime: async (ctx, node) => {
      const c = this.cloud.get(node.address);
      if (c?.runtime === "throw") throw new Error("runtime read failed");
      return { address: node.address, health: "healthy", counts: { running: 1 }, signals: [], observedAt: ctx.now().toISOString(), source: "fake.driver@1", simulated: false, ...(c?.runtime ?? {}) } as RuntimeState;
    },
    operations: {
      "drift.repair": async () => {
        this.operationCalls.push("drift.repair");
        return { ok: true, summary: "should never be called by the controller", simulated: true };
      },
    },
  };

  driverFor = (node: ResourceNode): ResourceDriver | undefined => (this.noDriver.has(node.address) ? undefined : this.driver);
}

export type BrokerScript = RepairProposalResult["outcome"] | "throw" | ((p: RepairProposal, n: number) => RepairProposalResult | "throw");

/** Scripted capability broker. Persists an operation per proposal, like the real one persists the decision. */
export class FakeBroker implements RepairBroker {
  readonly proposals: RepairProposal[] = [];
  script: BrokerScript = "allow";
  private n = 0;
  constructor(private readonly backend: MemoryReconcileBackend) {}

  async propose(p: RepairProposal): Promise<RepairProposalResult> {
    this.proposals.push(p);
    const step = typeof this.script === "function" ? this.script(p, this.proposals.length) : this.script;
    if (step === "throw") throw new Error("broker unavailable (Bearer abcdefghijklmnop)");
    const outcome = typeof step === "string" ? step : step.outcome;
    const operationId = typeof step === "object" && "operationId" in step && step.operationId ? step.operationId : `op-${++this.n}`;
    this.backend.operations.push({
      operationId,
      workspaceId: p.request.scope.workspaceId,
      environmentId: p.request.scope.environmentId ?? "",
      resourceId: p.request.scope.resourceId,
      status: outcome === "allow" ? "approved" : outcome === "deny" ? "denied" : "awaiting_approval",
      createdAt: this.backend.now().toISOString(),
      byReconciler: true,
    });
    if (outcome === "deny") return { outcome: "deny", operationId, reason: "policy denied" };
    return { outcome, operationId };
  }
}

export interface Harness {
  clock: Clock;
  backend: MemoryReconcileBackend;
  world: World;
  broker: FakeBroker;
  started: StartRepairRequest[];
  sessions: ObserveSessionRequest[];
  ports: ReconcilePassPorts;
  /** make startRepair fail the next `n` calls */
  failStart(n: number): void;
}

export function harness(opts: { env?: SchedulableEnvironment; graph?: ResourceGraph; world?: (w: World, g: ResourceGraph) => void; status?: "active" | "planned" } = {}): Harness {
  const clock = new Clock();
  const backend = new MemoryReconcileBackend({ now: clock.now });
  const world = new World();
  const g = opts.graph ?? graph();
  const env = opts.env ?? ENV;
  backend.addEnvironment(env, g, opts.status ?? "active");
  if (opts.world) opts.world(world, g);
  else world.allPresent(g);
  const broker = new FakeBroker(backend);
  const started: StartRepairRequest[] = [];
  const sessions: ObserveSessionRequest[] = [];
  let failures = 0;
  const ports = backend.passPorts({
    broker,
    driverFor: world.driverFor,
    startRepair: async (r) => {
      if (failures > 0) {
        failures--;
        throw new Error("temporal unavailable");
      }
      started.push(r);
    },
    withObserveSession: async (request, fn) => {
      sessions.push(request);
      return fn({ token: SESSION_CANARY });
    },
  });
  return { clock, backend, world, broker, started, sessions, ports, failStart: (n) => void (failures = n) };
}

/** Everything the controller persisted, as one string, for canary searches. */
export function persistedText(b: MemoryReconcileBackend): string {
  return JSON.stringify({ o: b.observations, r: [...b.runtime.entries()], p: [...b.reports.entries()], e: b.events, s: [...b.schedules.entries()], f: [...b.findingSince.entries()], ops: b.operations });
}
