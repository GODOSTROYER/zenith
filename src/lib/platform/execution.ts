/**
 * Execution composition root. Defaults use the merged stores/engine/drivers;
 * explicit ports support contract tests without pretending to reach a cloud.
 * The secret-derived fingerprint key is mandatory even when tofu is injected.
 */
import { createPlanArtifactRuntime } from "./plan-artifacts";
import { hkdfSync } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { createExecutionActivities, createPlatformPorts, createPortabilityPort, createProductPort, createSafeProber, defaultCostPort, type ExecutionDeps } from "@/lib/execution";
import { createObservabilityFabric, describeSession, sourcesForEnvironment } from "@/lib/observability";
import { createHeldReconcileActivity } from "@/lib/execution/verify";
import { createRuntime } from "@/lib/execution/runtime";
import { loadPlatformEnvironment, loadGraphFromStore, registerEnvironment } from "@/lib/reconcile/platform";
import { parseOperationInput } from "@/lib/execution/context";
import { withFailureMapping } from "@/lib/workflows/activities/failures";
import type { WorkerActivities } from "@/lib/workflows/types";
import { platformCredentialBroker } from "./credentials";
import { createExecutionBroker } from "./broker";
import { registerAllDrivers } from "./drivers";
import { platformDriverLookup } from "./driver-lookup";
import { createReleasePorts } from "./release";
import { createPlatformReleaseSafety } from "./release-safety";
import { createGithubContextVerifier } from "@/lib/sources/github/inspect";
import { composeReconcilePorts } from "./reconcile";
import { createAzureSourceStorageResolver } from "@/lib/providers/azure/release/source-binding";
import type { SourceBundleDeps } from "./source-bundle";
import { createApprovedSourceRuntime } from "./approved-source-runtime";
import { createDefaultMachinePort } from "@/lib/machines/composition";
import type { AzureBuildOptions } from "./release-azure";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import { createReconcileSweepRuntime, type ReconcileSweepRuntime } from "@/lib/workflows/reconcile-schedule";
import { observeAwsBootstrapReadiness } from "@/lib/execution/aws-bootstrap-preflight";
import { isOpenedPlatformDbHandle, repos } from "@/lib/controlplane/db";
import { digest } from "@/lib/controlplane/digest";
import { getControlSigner, getControlVerificationKeys } from "@/lib/credentials/signing";

/** Fixed diagnostic failure, recorded only against the current native owning AWS scope. */
async function recordUnavailableAwsReadiness(db: Sql, operationId: string): Promise<void> {
  if (!isOpenedPlatformDbHandle(db,"postgres")) return;
  await db.tx(async tx => {
    const owners = await tx.query<{workspace_id:string}>(`select o.workspace_id from platform.operations o
      join platform.reconcile_state e on e.workspace_id=o.workspace_id and e.project_id=o.project_id and e.environment_id=o.environment_id
      where o.id=$1 and e.provider='aws'`,[operationId]);
    if (owners.length !== 1 || !isOpenedPlatformDbHandle(db,"postgres")) return;
    const summary = {stage:"aws_bootstrap_readiness",status:"unavailable",code:"read_unavailable",roleCoverage:"incomplete",
      authorization:"unverified",migration:"not_performed"};
    await repos.evidence.insert(tx,{workspaceId:owners[0].workspace_id,operationId,kind:"observation",digest:digest(summary),summary,simulated:false});
  });
}

/** Fixed production observation composition; no dependency or readiness overrides. */
export async function composeReconcileSweepRuntime(db: PlatformDbHandle): Promise<ReconcileSweepRuntime> {
  registerAllDrivers();
  const runtime = createReconcileSweepRuntime(db);
  await runtime.assertReady();
  return runtime;
}

export interface ComposeExecutionOptions {
  db: Sql;
  workerIdentity: string;
  planDir: string;
  secretKey?: string;
  /** Deliberate dependency overrides for contract tests or source acquisition. */
  ports?: Partial<Omit<ExecutionDeps, "fingerprintKey" | "workerId" | "planDir">>;
  /** Optional tenant-scoped GitHub connector, Azure storage binding and download bounds. */
  sourceBundles?: Omit<SourceBundleDeps, "resources">;
}

export function derivePlanFingerprintKey(secretKey = process.env.ZENITH_SECRET_KEY): string {
  if (!secretKey || !/^[a-f0-9]{64}$/i.test(secretKey)) throw new Error("Execution requires ZENITH_SECRET_KEY (64 hex characters); plan fingerprints cannot use the public default.");
  return Buffer.from(hkdfSync("sha256", Buffer.from(secretKey, "hex"), Buffer.alloc(0), "zenith.tofu.plan.fingerprint.v1", 32)).toString("hex");
}

export function composeExecutionActivities(opts: ComposeExecutionOptions): WorkerActivities {
  const fingerprintKey = derivePlanFingerprintKey(opts.secretKey);
  const injectedArtifacts = opts.ports?.planArtifacts;
  if (injectedArtifacts && process.env.NODE_ENV !== "test") throw new Error("Artifact overrides are available only in the test environment.");
  if (injectedArtifacts && injectedArtifacts.kind !== "isolated-test") throw new Error("Artifact overrides require an explicit isolated test adapter.");
  if (opts.ports?.tofu && injectedArtifacts?.kind !== "isolated-test") throw new Error("Engine overrides require an explicit isolated test adapter.");
  if (injectedArtifacts?.kind === "isolated-test" && !opts.ports?.tofu) throw new Error("An isolated artifact adapter requires an explicit isolated engine.");
  // Machine/source composition needs no OpenTofu authority. Capture the canonical store/environment now,
  // and resolve its paired custody once when infrastructure planning or mutation is actually requested.
  const custodyDb=opts.db;
  const custodyEnv=Object.freeze({...process.env});
  let custodyRuntime:ReturnType<typeof createPlanArtifactRuntime>|undefined;
  const custody=()=>{
    if ((custodyDb as Sql & {kind?:string}).kind!=="postgres") throw new Error("Production execution requires PostgreSQL durable plan custody.");
    return custodyRuntime??=createPlanArtifactRuntime(custodyDb,custodyEnv);
  };
  const planArtifacts:NonNullable<ExecutionDeps["planArtifacts"]>=injectedArtifacts??{
    kind:"postgres",
    associate:input=>custody().planArtifacts.associate(input),
    publish:input=>custody().planArtifacts.publish(input),
    inspect:(input,fn)=>custody().planArtifacts.inspect(input,fn),
    consume:(input,fn)=>custody().planArtifacts.consume(input,fn),
  };
  const tofu:NonNullable<ExecutionDeps["tofu"]>=opts.ports?.tofu??{
    planWorkspace:(...args)=>custody().tofu.planWorkspace(...args),
    applyVerifiedPlan:(...args)=>custody().tofu.applyVerifiedPlan(...args),
  };
  const platformPorts = createPlatformPorts(opts.db);
  const azureStorage = opts.sourceBundles?.azureStorage ?? createAzureSourceStorageResolver(opts.db);
  const sourceRuntime = createApprovedSourceRuntime(opts.db, {
    resources: opts.ports?.resources ?? platformPorts.resources,
    sourceBundles: opts.sourceBundles, azureStorage,
    sourceBundle: opts.ports?.sourceBundle, sourceSnapshots: opts.ports?.sourceSnapshots,
  });
  registerAllDrivers();
  const credentials = opts.ports?.credentials ?? platformCredentialBroker(opts.db);
  const azure: AzureBuildOptions = { readSource: sourceRuntime.readAzureSource };
  const deps: ExecutionDeps = {
    ...platformPorts, portability: createPortabilityPort(opts.db), planArtifacts,
    drivers: platformDriverLookup,
    product: createProductPort(), broker: createExecutionBroker(opts.db), credentials,
    tofu, cost: defaultCostPort(),
    observability: ({ session, ...input }) => createObservabilityFabric(sourcesForEnvironment({ ...input, sessions: session.provider === "aws" ? { aws: session } : session.provider === "kubernetes" ? { kubernetes: session } : {} }), { session: describeSession(session) }),
    prober: createSafeProber(), ...createReleasePorts({ db: opts.db, azure }),
    // PROD-LIFE-09: built artifacts are signed with, and admitted against, the pinned control-plane key.
    provenance: { signer: () => getControlSigner(), keys: () => getControlVerificationKeys() },
    // Unrestricted build egress is refused unless the operator sets this recorded exception.
    buildIsolation: { allowOpenEgress: process.env.ZENITH_BUILD_ALLOW_OPEN_EGRESS === "1" },
    // A non-root build context is built only when its source-inspection digest re-derives from the approved commit (PROD-LIFE-08/09).
    sourceContext: createGithubContextVerifier({ db: async () => opts.db }),
    // Digest-bound release runs, provenance gate, migration approval, rollout and readback (PROD-LIFE-10).
    releaseSafety: createPlatformReleaseSafety(opts.db),
    machines: opts.ports?.machines ?? createDefaultMachinePort(opts.db, opts.secretKey ?? process.env.ZENITH_SECRET_KEY!),
    ...opts.ports,
    // The captured source authority is final; the generic test-port spread cannot replace it.
    sourceBundle: sourceRuntime.sourceBundle, sourceSnapshots: sourceRuntime.sourceSnapshots,
    fingerprintKey, workerId: opts.workerIdentity, planDir: opts.planDir,
  };
  const activities = createExecutionActivities(deps);
  const readinessRuntime = createRuntime(deps);
  const reconcilePorts = composeReconcilePorts(opts.db, credentials);
  return withFailureMapping({
    ...activities,
    async validateDesiredState(input) {
      const result = await activities.validateDesiredState(input);
      if (result.problems.length === 0) {
        const op = await deps.ops.get(input.operationId);
        if (!op?.environmentId) throw new Error("Validated operation has no environment.");
        const product = await deps.product.loadContext({ workspaceId: op.workspaceId, environmentId: op.environmentId, ...parseOperationInput(op) });
        const connection = await deps.connections.resolve({ workspaceId: op.workspaceId, connectionId: product.environment.connectionId });
        await registerEnvironment(opts.db, { environment: { workspaceId: op.workspaceId, projectId: product.project.id, environmentId: op.environmentId, class: product.environment.class, provider: product.environment.provider, region: product.environment.region, ...(connection ? { connection: { id: connection.id, status: connection.status } } : {}) } });
      }
      return result;
    },
    async observeEnvironment(input) {
      const observed = await activities.observeEnvironment(input);
      // Supplemental diagnostics do not erase the original observation or
      // redefine session, approval, plan custody or workflow command contracts.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          observeAwsBootstrapReadiness(readinessRuntime,input.operationId),
          new Promise<never>((_,reject) => { timeout=setTimeout(() => reject(new Error("AWS readiness deadline exceeded.")),35_000); }),
        ]);
      } catch {
        readinessRuntime.log("warn","AWS bootstrap readiness unavailable",{operationId:input.operationId,status:"unavailable",roleCoverage:"incomplete"});
        try { await recordUnavailableAwsReadiness(opts.db,input.operationId); }
        catch { readinessRuntime.log("warn","AWS bootstrap readiness evidence unavailable",{operationId:input.operationId}); }
      } finally { if (timeout !== undefined) clearTimeout(timeout); }
      return observed;
    },
    reconcileObserve: createHeldReconcileActivity(createRuntime(deps), { ports: reconcilePorts, loadEnvironment: (ws, env) => loadPlatformEnvironment(opts.db, ws, env), loadGraph: (env) => loadGraphFromStore(opts.db, env) }),
  });
}
