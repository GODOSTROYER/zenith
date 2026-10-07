/**
 * What the mixed services need from outside the platform database: the product
 * store (environments, revisions, the deployment a child operation projects onto)
 * and the platform connections. A narrow port so the services are tested against
 * a fake world and run against the real product and connection ports in
 * production. Every method re-checks workspace ownership; a foreign id is the same
 * refusal as a missing one.
 */
import type { ProviderConnection } from "@/lib/credentials/types";
import type { ResourceGraph } from "@/lib/resources/types";
import { parseManifest } from "@/lib/resources/manifest-v2";
import { buildDesiredState } from "@/lib/execution/graph";
import type { ConnectionsPort, ProductPort } from "@/lib/execution/ports";
import type { DeployWorkflowInput } from "@/lib/workflows/types";
import type { Sql } from "@/lib/controlplane/types";
import type { DriftClass } from "@/lib/execution/mixed-orchestration/ordering-rules";
import { MixedPlanError, type ChildReceipt, type MixedParentPlan } from "./types";
import { productionWorldHooks } from "./output-source";
import { platformOrderingSignals } from "./signals";

export interface MixedWorld {
  /** The parent environment's project and expanded desired graph. */
  parentGraph(workspaceId: string, environmentId: string): Promise<{ projectId: string; graph: ResourceGraph }>;
  /** A child environment's project and the platform connection it executes through (as stored now). */
  childEnvironment(workspaceId: string, environmentId: string): Promise<{ projectId: string; connection: ProviderConnection }>;
  /** The graph that deploying `revisionId` into the child environment would apply. */
  childGraph(workspaceId: string, environmentId: string, revisionId: string): Promise<ResourceGraph>;
  /** The exact deploy workflow input for an adopted child operation, built from the product store like the bridge does. */
  childStartInput(workspaceId: string, operation: { id: string; environmentId: string; projectId: string; input: unknown }): Promise<DeployWorkflowInput>;
  /** Current platform connections by id (undefined entries resolve to null). */
  connections(workspaceId: string, ids: readonly string[]): Promise<ReadonlyMap<string, ProviderConnection | null>>;
  /** Optional digest of a finished child's recorded outputs, for its receipt. Absent means the receipt carries none. */
  childOutputsDigest?(workspaceId: string, operation: { id: string; environmentId: string; input: unknown }): Promise<string | undefined>;
  /**
   * Source of the typed outputs (PROD-MIX-03) a SUCCEEDED producer child exposes for the references its consumers declared.
   * Returns candidate `TypedOutput` documents (digests, provenance and vault references, never values); the run orchestration
   * validates each against the contract, scope, provenance and the producer's recorded receipt before using it. The production
   * world wires the producer output reader (output-reader.ts) whenever it is composed with the platform store; a world without
   * it leaves a consumer with incoming references blocked with `outputs_unavailable` instead of starting on a guess.
   */
  childTypedOutputs?(
    workspaceId: string,
    producer: { partitionId: string; childOperationId: string; receiptDigest: string; receipt: ChildReceipt; plan: MixedParentPlan; /** the effect digest the run recorded for the producer */ effectDigest: string },
    references: readonly { referenceId: string; consumerChildId: string; producerAddress: string; producerOutput: string }[],
  ): Promise<readonly unknown[]>;
  /**
   * Drift (OBS-01 / reconcile) and migration (LIFE-10) observations for the ordering rules of PROD-MIX-04. Wired in the
   * production world; a world without it means none are known (the rules then see no drift).
   */
  orderingSignals?(
    workspaceId: string,
    children: readonly { partitionId: string; childEnvironmentId: string; childOperationId?: string }[],
  ): Promise<{ drift: readonly { childId: string; klass: DriftClass }[]; migrationChildIds: readonly string[]; contractMigrationChildIds?: readonly string[] }>;
}

export interface MixedWorldPorts {
  product: ProductPort;
  connections: ConnectionsPort;
  /** Direct platform lookup by id, ignoring the product-to-platform mapping (used for already-bound connections). */
  platformConnection(workspaceId: string, id: string): Promise<ProviderConnection | null>;
  /**
   * The platform store. When present the world is the production one: it reads producer outputs back through the producing
   * partition's own observation and feeds drift and migration signals to the ordering rules. Absent (contract tests with
   * fakes) leaves both hooks off unless the test sets them.
   */
  sql?: Sql;
}

const refuse = (code: ConstructorParameters<typeof MixedPlanError>[0], message: string): never => { throw new MixedPlanError(code, message); };

export function createMixedWorld(ports: MixedWorldPorts): MixedWorld {
  const load = async (workspaceId: string, environmentId: string, revisionId?: string) => {
    try {
      return await ports.product.loadContext({ workspaceId, environmentId, ...(revisionId ? { revisionId } : {}) });
    } catch {
      return refuse("not_found", "The environment or revision was not found in this workspace.");
    }
  };
  const graphOf = (ctx: Awaited<ReturnType<typeof load>>): ResourceGraph => {
    const desired = buildDesiredState(ctx);
    if (!desired.graph) return refuse("plan_refused", `The desired state cannot be expanded: ${desired.problems[0] ?? "unknown"}`);
    return desired.graph;
  };
  return {
    ...(ports.sql ? { ...productionWorldHooks(ports.sql), orderingSignals: platformOrderingSignals(ports.sql) } : {}),
    async parentGraph(workspaceId, environmentId) {
      const ctx = await load(workspaceId, environmentId);
      return { projectId: ctx.project.id, graph: graphOf(ctx) };
    },
    async childEnvironment(workspaceId, environmentId) {
      const ctx = await load(workspaceId, environmentId);
      const connection = await ports.connections.resolve({ workspaceId, connectionId: ctx.environment.connectionId });
      if (!connection) return refuse("connection_unverified", "A child environment has no usable platform connection (missing, foreign or revoked).");
      return { projectId: ctx.project.id, connection };
    },
    async childGraph(workspaceId, environmentId, revisionId) {
      return graphOf(await load(workspaceId, environmentId, revisionId));
    },
    async childStartInput(workspaceId, operation) {
      const input = operation.input && typeof operation.input === "object" && !Array.isArray(operation.input) ? (operation.input as Record<string, unknown>) : {};
      const revisionId = typeof input.revisionId === "string" ? input.revisionId : undefined;
      if (!revisionId) return refuse("child_mismatch", "A child operation must carry the revision it deploys.");
      const ctx = await load(workspaceId, operation.environmentId, revisionId);
      const manifest = ctx.revision ? parseManifest(ctx.revision.manifest) : undefined;
      if (!manifest?.ok) return refuse("child_mismatch", "The child's revision manifest is not readable.");
      const services = (manifest.manifest as unknown as { services?: { ownership?: string; source?: { type?: string } }[] }).services ?? [];
      return {
        operationId: operation.id, workspaceId, projectId: operation.projectId, environmentId: operation.environmentId, revisionId,
        deploymentId: typeof input.deploymentId === "string" ? input.deploymentId : `dep-${operation.id}`,
        connectionId: ctx.environment.connectionId, preApproved: true,
        build: services.some((service) => service.ownership === "managed" && service.source?.type === "git"),
      };
    },
    async connections(workspaceId, ids) {
      const out = new Map<string, ProviderConnection | null>();
      for (const id of new Set(ids)) out.set(id, await ports.platformConnection(workspaceId, id));
      return out;
    },
  };
}
