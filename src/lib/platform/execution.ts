/**
 * Execution composition root. Defaults use the merged stores/engine/drivers;
 * explicit ports support contract tests without pretending to reach a cloud.
 * The secret-derived fingerprint key is mandatory even when tofu is injected.
 */
import { hkdfSync } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { createExecutionActivities, createPlatformPorts, createProductPort, createSafeProber, defaultCostPort, type ExecutionDeps } from "@/lib/execution";
import { createObservabilityFabric, sourcesForEnvironment } from "@/lib/observability";
import { planWorkspace, applyVerifiedPlan } from "@/lib/tofu";
import { createReconcileObserveActivity } from "@/lib/reconcile/activity";
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
import { createSourceBundles, type SourceBundleDeps } from "./source-bundle";

export interface ComposeExecutionOptions {
  db: Sql;
  workerIdentity: string;
  planDir: string;
  secretKey?: string;
  /** Deliberate dependency overrides for contract tests or source acquisition. */
  ports?: Partial<Omit<ExecutionDeps, "fingerprintKey" | "workerId" | "planDir">>;
  /** Optional tenant-scoped GitHub connector and bounded download settings. */
  sourceBundles?: Omit<SourceBundleDeps, "resources">;
}

export function derivePlanFingerprintKey(secretKey = process.env.ZENITH_SECRET_KEY): string {
  if (!secretKey || !/^[a-f0-9]{64}$/i.test(secretKey)) throw new Error("Execution requires ZENITH_SECRET_KEY (64 hex characters); plan fingerprints cannot use the public default.");
  return Buffer.from(hkdfSync("sha256", Buffer.from(secretKey, "hex"), Buffer.alloc(0), "zenith.tofu.plan.fingerprint.v1", 32)).toString("hex");
}

export function composeExecutionActivities(opts: ComposeExecutionOptions): WorkerActivities {
  const fingerprintKey = derivePlanFingerprintKey(opts.secretKey);
  registerAllDrivers();
  const credentials = opts.ports?.credentials ?? platformCredentialBroker(opts.db);
  const platformPorts = createPlatformPorts(opts.db);
  const deps: ExecutionDeps = {
    ...platformPorts,
    drivers: platformDriverLookup,
    product: createProductPort(), broker: createExecutionBroker(opts.db), credentials,
    tofu: { planWorkspace, applyVerifiedPlan }, cost: defaultCostPort(),
    observability: ({ session, ...input }) => createObservabilityFabric(sourcesForEnvironment({ ...input, sessions: session.provider === "aws" ? { aws: session } : session.provider === "kubernetes" ? { kubernetes: session } : {} })),
    prober: createSafeProber(), ...createReleasePorts({ db: opts.db }),
    sourceBundle: opts.ports?.sourceBundle ?? createSourceBundles({ ...opts.sourceBundles, resources: opts.ports?.resources ?? platformPorts.resources }).port,
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
    reconcileObserve: createReconcileObserveActivity({ ports: reconcilePorts, loadEnvironment: (ws, env) => loadPlatformEnvironment(opts.db, ws, env), loadGraph: (env) => loadGraphFromStore(opts.db, env) }),
  });
}
