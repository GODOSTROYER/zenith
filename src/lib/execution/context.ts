/**
 * Loading the context of an operation: the ledger record, the product-store
 * context it points at (workspace, project, environment, revision), and the
 * provider connection behind the environment.
 *
 * What the operation's `proposal.input` must carry (the contract with the
 * capability broker, WS-CAP): for `deployment.deploy` / `infrastructure.apply`
 * the ids `revisionId` and `deploymentId` that the workflow also receives. Day
 * two and remediation operations carry neither and execute against the
 * environment's deployed revision. Unknown keys are ignored: the input is
 * validated where it is consumed (a driver operation validates its own).
 */
import type { OperationRecord } from "@/lib/controlplane/types";
import type { ProviderConnection } from "@/lib/credentials/types";
import { ManagedSubstrateError } from "@/lib/providers/zenith/managed-port";
import { z } from "zod";
import { errorCode, StepFailedError } from "./errors";
import type { ProductContext } from "./ports";
import { scopeOf, type Runtime, type WorkScope } from "./runtime";
import { errorText } from "./text";

const OperationInput = z
  .object({
    revisionId: z.string().min(1).max(200).optional(),
    deploymentId: z.string().min(1).max(200).optional(),
  })
  .passthrough();

/** What the helpers shared by operations AND reconcile passes need; a pass has no operation row, only an id. */
export interface ExecLike {
  /** operation id, or the reconcile pass id */
  op: { id: string };
  /** workspace / environment ids every store call is scoped by */
  workspaceId: string;
  environmentId: string;
  scope: WorkScope;
  product: ProductContext;
}

export interface ExecContext extends ExecLike {
  op: OperationRecord;
  deploymentId?: string;
  approvedSourceSnapshots?: readonly import("./source-snapshot").ApprovedSourceSnapshot[];
  executableSourceDigest?: string;
}

export function parseOperationInput(op: Pick<OperationRecord, "proposal">): { revisionId?: string; deploymentId?: string; raw: Record<string, unknown> } {
  const parsed = OperationInput.safeParse(op.proposal.input ?? {});
  if (!parsed.success) return { raw: {} };
  return { revisionId: parsed.data.revisionId, deploymentId: parsed.data.deploymentId, raw: parsed.data };
}

export async function loadOperation(rt: Runtime, operationId: string): Promise<OperationRecord> {
  const op = await rt.d.ops.get(operationId);
  if (!op) throw new StepFailedError(`Operation ${operationId} was not found.`);
  return op;
}

/** Translate a product-store "not found" into a definitive failure; everything else stays retryable. */
function productFailure(err: unknown): unknown {
  const code = errorCode(err);
  if (code && code.endsWith("_not_found")) return new StepFailedError(errorText(err));
  return err;
}

export async function loadExecContext(rt: Runtime, operationId: string): Promise<ExecContext> {
  const op = await loadOperation(rt, operationId);
  if (!op.environmentId) throw new StepFailedError(`Operation ${operationId} is not scoped to an environment; it cannot be executed.`);
  const input = parseOperationInput(op);
  let product: ProductContext;
  try {
    // Repair desired values come from the deployed revision, never caller ids.
    product = await rt.d.product.loadContext({ workspaceId: op.workspaceId, environmentId: op.environmentId,
      ...(op.capability === "drift.repair" ? {} : { revisionId: input.revisionId, deploymentId: input.deploymentId }) });
  } catch (err) {
    throw productFailure(err);
  }
  return { op, workspaceId: op.workspaceId, environmentId: op.environmentId, scope: scopeOf(op), product, deploymentId: input.deploymentId };
}

/** Id prefix of the synthetic connection a Zenith-managed environment resolves to (it has no customer connection). */
export const MANAGED_CONNECTION_PREFIX = "zenith-managed:";
export const isManagedEnvironment = (ec: Pick<ExecContext, "product">): boolean => ec.product.environment.provider === "zenith";
export const isManagedConnection = (connection: Pick<ProviderConnection, "id">): boolean => connection.id.startsWith(MANAGED_CONNECTION_PREFIX);

/**
 * The connection of a Zenith-managed environment. There is no customer credential: the platform is the operator.
 * This is a NON-SECRET descriptor (the cluster URL is public configuration) that lets every step that asks for "the
 * environment's connection" proceed; `withProviderSession` recognizes it and opens the managed, tenant-pinned session
 * instead of calling the customer credential broker. It carries no credential reference and no namespace grant.
 */
function managedConnection(rt: Runtime, ec: Pick<ExecContext, "workspaceId" | "product">): ProviderConnection {
  const managed = rt.d.managed;
  if (!managed) throw new StepFailedError("This worker has no Zenith-managed substrate composed, so a managed environment cannot be operated.");
  let server: string;
  try { server = managed.substrate().cluster.server; }
  catch (err) { throw new StepFailedError(err instanceof ManagedSubstrateError ? err.message : "The Zenith-managed substrate is unavailable."); }
  return {
    id: `${MANAGED_CONNECTION_PREFIX}${ec.product.environment.id}`,
    workspaceId: ec.workspaceId,
    config: { provider: "kubernetes", mode: "kubeconfig_ref", server, namespaces: [] },
    status: "verified",
    createdBy: "zenith-managed",
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

/** The provider connection behind the environment; it must be verified. */
export async function resolveConnection(rt: Runtime, ec: Pick<ExecContext, "workspaceId" | "product">): Promise<ProviderConnection> {
  if (isManagedEnvironment(ec)) return managedConnection(rt, ec);
  const connection = await rt.d.connections.resolve({ workspaceId: ec.workspaceId, connectionId: ec.product.environment.connectionId });
  if (!connection) throw new StepFailedError("This environment has no usable provider connection (it is missing, belongs to another workspace, or was revoked).");
  if (connection.status !== "verified") throw new StepFailedError(`The provider connection is ${connection.status.replace("_", " ")}; verify it before executing against it.`);
  return connection;
}
