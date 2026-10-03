/**
 * One object that wires every fake into `createExecutionActivities`, the way the
 * worker wires the real ports. Tests reach into the pieces to script behaviour
 * and to assert on what the activities asked for.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExecutionActivities, type ExecutionWorkerActivities } from "@/lib/execution/activities";
import { randomBytes } from "node:crypto";
import { createPlanEngineAuthority, type PlanAdmission } from "@/lib/tofu/engine";
import { planArtifactCipherFromEnv } from "@/lib/platform/plan-artifacts";
import type { Sealed } from "@/lib/secrets";
import type { ApprovedPlan, ProducedPlan } from "@/lib/tofu/engine";
import type { BrokerPort, CostPort, ExecutionDeps, ExecutionLimits, PlanArtifactsPort, TofuPort } from "@/lib/execution/ports";
import type { LeaseRef, ReconcileActivities } from "@/lib/workflows/types";
import { FakeBroker, FakeCredentialBroker } from "./broker";
import { genericDrivers, type DriverScript } from "./drivers";
import { ENV, OP } from "./fixtures";
import { FakeProduct } from "./product";
import { FakeBuild, FakeMigrations, FakeProber, FakeSourceBundle, FakeWorkloads } from "./release";
import { FakeConnections, FakeEvents, FakeEvidence, FakeLeases, FakeOps, FakeResources } from "./store";
import { FakeTofu } from "./tofu";
import type { Sql } from "@/lib/controlplane/types";
import * as artifactRepo from "@/lib/controlplane/db/repos/plan-artifacts";
import * as operationRepo from "@/lib/controlplane/db/repos/operations";

export const FINGERPRINT_KEY = "test-fingerprint-key-0123456789abcdef";
export const NOW = "2026-09-30T12:00:00.000Z";

export interface WorldOptions {
  script?: DriverScript;
  overrides?: Record<string, DriverScript>;
  missingDrivers?: string[];
  limits?: Partial<ExecutionLimits>;
  cost?: CostPort;
  /** Temporal's cancellation signal for the activity */
  signal?: AbortSignal;
  /** omit the build/workload/migration/bundle ports (a worker without them) */
  withoutRelease?: boolean;
  /** seed the operation (default: an approved deployment.deploy) */
  op?: Parameters<FakeOps["seed"]>[0];
}

export interface World {
  ops: FakeOps;
  leases: FakeLeases;
  events: FakeEvents;
  evidence: FakeEvidence;
  resources: FakeResources;
  connections: FakeConnections;
  product: FakeProduct;
  broker: FakeBroker;
  credentials: FakeCredentialBroker;
  tofu: FakeTofu;
  /** Real tool with explicitly isolated fake-store custody. Never PostgreSQL durability evidence. */
  isolatedRealTofu: TofuPort;
  prober: FakeProber;
  sourceBundle: FakeSourceBundle;
  build: FakeBuild;
  workloads: FakeWorkloads;
  migrations: FakeMigrations;
  drivers: ReturnType<typeof genericDrivers>;
  heartbeats: unknown[];
  logs: { level: string; message: string; data?: Record<string, unknown> }[];
  planDir: string;
  deps: ExecutionDeps;
  activities: Omit<ExecutionWorkerActivities, "reconcileObserve"> & {
    reconcileObserve: ReconcileActivities["reconcileObserve"];
  };
  /** acquire the environment lease for the seeded operation, through the real activity */
  lease(): Promise<LeaseRef>;
  /** everything the activities persisted, as one string, for canary scans */
  stored(): string;
  dispose(): void;
}

export function createWorld(opts: WorldOptions = {}): World {
  const events = new FakeEvents();
  const ops = new FakeOps(events);
  ops.seed(opts.op);
  const leases = new FakeLeases();
  const evidence = new FakeEvidence();
  const resources = new FakeResources();
  const connections = new FakeConnections();
  const product = new FakeProduct();
  const broker = new FakeBroker(ops);
  const credentials = new FakeCredentialBroker();
  const tofu = new FakeTofu();
  const prober = new FakeProber();
  const sourceBundle = new FakeSourceBundle();
  const build = new FakeBuild();
  const workloads = new FakeWorkloads();
  const migrations = new FakeMigrations();
  const drivers = genericDrivers({ script: opts.script, overrides: opts.overrides, missing: opts.missingDrivers });
  const heartbeats: unknown[] = [];
  const logs: World["logs"] = [];
  const planDir = mkdtempSync(path.join(os.tmpdir(), "zenith-act-plans-"));

  const reviewed = new Map<string,ProducedPlan>();
  const sealedReviews = new Map<string,Sealed>();
  const isolatedAdmissions = new WeakMap<ApprovedPlan,PlanAdmission>();
  const {codec,tofu:isolatedRealTofu}=createPlanEngineAuthority(planArtifactCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:randomBytes(32).toString("hex")}),original=>isolatedAdmissions.get(original),{...process.env,ZENITH_WORKER_PLAN_DIR:planDir});
  const readReview = async <T>(plan: ProducedPlan,input: {custody: PlanAdmission["custody"];lease:LeaseRef}, executable:boolean,fn:(approved:ApprovedPlan)=>Promise<T>):Promise<T> => {
    const sealed=sealedReviews.get(plan.manifest.operationId);
    if (!sealed) return fn(plan as ApprovedPlan);
    return codec.withDecoded({...plan.manifest},sealed,async (manifest,bytes)=> {
      const original:ApprovedPlan=Object.freeze({manifest});
      if (executable) isolatedAdmissions.set(original,Object.freeze({manifest,bytes,custody:input.custody,lease:input.lease,attemptId:"isolated-test",associated:manifest.operationId!==input.custody.operationId,dispatch:async()=>undefined}));
      try { return await fn(original); } finally {isolatedAdmissions.delete(original);}
    });
  };
  const deps: ExecutionDeps = {
    planArtifacts: {
      kind: "isolated-test",
      async associate(input) {
        const source=reviewed.get(input.sourceOperationId);
        if (!source || source.manifest.planDigest!==input.planDigest) throw new Error("Isolated source review missing");
        reviewed.set(input.destinationOperationId,source);
      },
      async publish(input) {
        if (!input.produced) throw new Error("Isolated producer missing");
        const m=input.produced.manifest;
        const prior=reviewed.get(m.operationId);
        if (prior && prior.manifest.planDigest !== m.planDigest) throw new Error("Isolated immutable plan conflict");
        if (!prior) {
          await ops.setPlanDigest({workspaceId:m.workspaceId,operationId:m.operationId,planDigest:m.planDigest});
          await evidence.append(input.evidence);
          if (m.executable.version !== "isolated-test") sealedReviews.set(m.operationId,codec.sealProduced(input.produced).sealed);
          reviewed.set(m.operationId,input.produced);
        }
      },
      async inspect(input,fn) {
        const plan=reviewed.get(input.custody.operationId);
        if (!plan || plan.manifest.planDigest !== input.planDigest) throw new Error("Isolated reviewed plan missing");
        return readReview(plan,input,false,fn);
      },
      async consume(input,fn) {
        const plan=reviewed.get(input.custody.operationId);
        if (!plan || plan.manifest.planDigest !== input.planDigest) throw new Error("Isolated reviewed plan missing");
        return readReview(plan,input,true,approved => fn(approved,async () => undefined));
      },
    },
    ops,
    leases,
    events,
    evidence,
    resources,
    connections,
    product,
    broker,
    credentials,
    drivers,
    tofu,
    fingerprintKey: FINGERPRINT_KEY,
    // no catalog dependence by default: "no estimate" (the default cost port is tested on its own)
    cost: opts.cost ?? { estimate: async () => null },
    prober,
    ...(opts.withoutRelease ? {} : { sourceBundle, build, workloads, migrations }),
    heartbeat: (detail) => heartbeats.push(detail),
    ...(opts.signal ? { activitySignal: () => opts.signal } : {}),
    clock: () => new Date(NOW),
    ids: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    sleep: async () => undefined,
    workerId: "test-worker",
    planDir,
    limits: { heartbeatIntervalMs: 5, probeIntervalMs: 0, ...opts.limits },
    log: (level, message, data) => logs.push({ level, message, ...(data ? { data } : {}) }),
  };
  const activities = createExecutionActivities(deps);

  return {
    ops,
    leases,
    events,
    evidence,
    resources,
    connections,
    product,
    broker,
    credentials,
    tofu,
    isolatedRealTofu,
    prober,
    sourceBundle,
    build,
    workloads,
    migrations,
    drivers,
    heartbeats,
    logs,
    planDir,
    deps,
    activities,
    lease: () => activities.acquireLease({ operationId: OP, scope: `env:${ENV}`, ttlMs: 300_000 }),
    stored: () =>
      JSON.stringify({
        events: events.events,
        evidence: evidence.rows,
        resources: [...resources.rows.values()],
        observations: resources.observations,
        runtime: [...resources.runtime.values()],
        reports: resources.reports,
        ops: [...ops.ops.values()],
        product: { steps: product.steps, statuses: product.statuses, outcomes: product.outcomes, outputs: product.outputs },
      }),
    dispose: () => rmSync(planDir, { recursive: true, force: true, maxRetries: 3 }),
  };
}

/** Isolated scripted-engine + actual SQL ledger fixture; synthetic ciphertext is not production producer proof. */
export function createSqlPlanArtifactFixture(w:World,sql:Sql,broker:Pick<BrokerPort,"approvalStatus">):PlanArtifactsPort {
  if(process.env.NODE_ENV!=="test" || w.deps.planArtifacts?.kind!=="isolated-test")throw new Error("SQL plan fixtures require the isolated test environment.");
  const isolated=w.deps.planArtifacts;
  return {
    kind:"isolated-test",
    async publish(input) {
      const produced=input.produced;
      if(!produced || produced.manifest.executable.version!=="isolated-test")throw new Error("SQL plan fixture requires its scripted producer.");
      const op=await operationRepo.get(sql,produced.manifest.workspaceId,produced.manifest.operationId);
      if(!op)throw new Error("SQL plan fixture operation is unavailable.");
      w.ops.seed(op);
      await artifactRepo.publish(sql,{manifest:produced.manifest,sealed:{iv:"A".repeat(16),authTag:"A".repeat(24),ciphertext:"synthetic-isolated-plan-ciphertext"},lease:input.lease,evidence:input.evidence});
      await isolated.publish(input);
    },
    async associate(input) {await artifactRepo.associate(sql,input);await isolated.associate(input);},
    async inspect(input,fn) {await artifactRepo.read(sql,input);return isolated.inspect(input,fn);},
    async consume(input,fn) {
      const attempt=randomBytes(16).toString("hex");
      await artifactRepo.claim(sql,input,attempt);
      let dispatched=false;
      try {
        const result=await isolated.consume(input,original=>fn(original,async()=>{
          const authority=await broker.approvalStatus(input.custody.operationId);
          if(dispatched || !authority.approved || authority.rejected || !authority.dispatchApproval)throw new artifactRepo.PlanArtifactError();
          dispatched=true;
          await artifactRepo.dispatch(sql,input,attempt,authority.dispatchApproval);
        }));
        if(!dispatched)throw new artifactRepo.PlanArtifactError();
        await artifactRepo.finish(sql,input,attempt,true);
        return result;
      } catch(error) {
        await artifactRepo.finish(sql,input,attempt,false).catch(()=>undefined);
        if(dispatched)throw new Error("Isolated original plan dispatch outcome is unconfirmed.");
        throw error;
      }
    },
  };
}
