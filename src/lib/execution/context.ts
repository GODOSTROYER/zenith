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
import { z } from "zod";
import { errorCode, StepFailedError } from "./errors";
import type { ConsumedInput } from "./typed-inputs";
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
  /** Typed dependency inputs of a mixed-provider consumer child; absent for every other operation. */
  typedInputs?: readonly ConsumedInput[];
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
  // A mixed-provider consumer child: its inputs are the producers' recorded outputs, loaded here so planning, the dispatch re-check
  // and the semantics digest all see the same set. A declared input with no recorded output refuses (never a guess).
  const typedInputs = rt.d.typedInputs ? await rt.d.typedInputs.load(op.workspaceId, op.id) : [];
  return { op, workspaceId: op.workspaceId, environmentId: op.environmentId, scope: scopeOf(op), product, deploymentId: input.deploymentId, ...(typedInputs.length ? { typedInputs } : {}) };
}

/** The provider connection behind the environment; it must be verified. */
export async function resolveConnection(rt: Runtime, ec: Pick<ExecContext, "workspaceId" | "product">): Promise<ProviderConnection> {
  const connection = await rt.d.connections.resolve({ workspaceId: ec.workspaceId, connectionId: ec.product.environment.connectionId });
  if (!connection) throw new StepFailedError("This environment has no usable provider connection (it is missing, belongs to another workspace, or was revoked).");
  if (connection.status !== "verified") throw new StepFailedError(`The provider connection is ${connection.status.replace("_", " ")}; verify it before executing against it.`);
  return connection;
}
