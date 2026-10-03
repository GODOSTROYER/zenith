/**
 * Execution composition root. Defaults use the merged stores/engine/drivers;
 * explicit ports support contract tests without pretending to reach a cloud.
 * The secret-derived fingerprint key is mandatory even when tofu is injected.
 */
import { createPlanArtifactRuntime } from "./plan-artifacts";
import { hkdfSync } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { createExecutionActivities, createPlatformPorts, createProductPort, createSafeProber, defaultCostPort, type ExecutionDeps } from "@/lib/execution";
import { createObservabilityFabric, sourcesForEnvironment } from "@/lib/observability";
import { planWorkspace, applyVerifiedPlan } from "@/lib/tofu";
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
import { composeReconcilePorts } from "./reconcile";
import { createAzureSourceStorageResolver } from "@/lib/providers/azure/release/source-binding";
import { createSourceBundles, type SourceBundleDeps } from "./source-bundle";
import { createDefaultMachinePort } from "@/lib/machines/composition";
import { createAzureSourceStorage, type AzureBuildOptions } from "./release-azure";

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
  if (!injectedArtifacts && (opts.db as Sql & {kind?: string}).kind !== "postgres") throw new Error("Production execution requires PostgreSQL durable plan custody.");
  if (injectedArtifacts && process.env.NODE_ENV !== "test") throw new Error("Artifact overrides are available only in the test environment.");
  if (injectedArtifacts && injectedArtifacts.kind !== "isolated-test") throw new Error("Artifact overrides require an explicit isolated test adapter.");
  if (opts.ports?.tofu && injectedArtifacts?.kind !== "isolated-test") throw new Error("Engine overrides require an explicit isolated test adapter.");
  if (injectedArtifacts?.kind === "isolated-test" && !opts.ports?.tofu) throw new Error("An isolated artifact adapter requires an explicit isolated engine.");
  const custodyRuntime = injectedArtifacts ? undefined : createPlanArtifactRuntime(opts.db);
  const planArtifacts = injectedArtifacts ?? custodyRuntime!.planArtifacts;
  registerAllDrivers();
  const credentials = opts.ports?.credentials ?? platformCredentialBroker(opts.db);
  const platformPorts = createPlatformPorts(opts.db);
  const azureStorage = opts.sourceBundles?.azureStorage ?? createAzureSourceStorageResolver(opts.db);
  const sourceBundles = opts.ports?.sourceBundle ? undefined : createSourceBundles({ ...opts.sourceBundles, azureStorage, resources: opts.ports?.resources ?? platformPorts.resources });
  const azure: AzureBuildOptions = {
    readSource: sourceBundles?.readAzureSource ?? ((ctx, source) => createAzureSourceStorage({
      resolveStorage: azureStorage,
      maxBytes: opts.sourceBundles?.limits?.maxArchiveBytes, timeoutMs: opts.sourceBundles?.timeoutMs,
    }).readSource(ctx, source)),
  };
  const deps: ExecutionDeps = {
    ...platformPorts, planArtifacts,
    drivers: platformDriverLookup,
    product: createProductPort(), broker: createExecutionBroker(opts.db), credentials,
    tofu: custodyRuntime?.tofu ?? { planWorkspace, applyVerifiedPlan }, cost: defaultCostPort(),
    observability: ({ session, ...input }) => createObservabilityFabric(sourcesForEnvironment({ ...input, sessions: session.provider === "aws" ? { aws: session } : session.provider === "kubernetes" ? { kubernetes: session } : {} })),
    prober: createSafeProber(), ...createReleasePorts({ db: opts.db, azure }),
    sourceBundle: opts.ports?.sourceBundle ?? sourceBundles!.port,
    machines: opts.ports?.machines ?? createDefaultMachinePort(opts.db, opts.secretKey ?? process.env.ZENITH_SECRET_KEY!),
    ...opts.ports,
    fingerprintKey, workerId: opts.workerIdentity, planDir: opts.planDir,
  };
  const activities = createExecutionActivities(deps);
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
    reconcileObserve: createHeldReconcileActivity(createRuntime(deps), { ports: reconcilePorts, loadEnvironment: (ws, env) => loadPlatformEnvironment(opts.db, ws, env), loadGraph: (env) => loadGraphFromStore(opts.db, env) }),
  });
}
