/** Run-scoped operation tracking. Never destroy infrastructure while its deploy
 * could still create resources. Cancellation failure is an incomplete cleanup,
 * not permission to race a running worker with a destructive sweep. */
import { isTerminalStatus, type ControlPlaneClient } from "./clients/control-plane";
import { blockRunCleanup, CleanupAdmissionError, readCleanupBlock } from "./run-state";
import type { ScenarioContext } from "./types";

const KEY = "harness.operationIds";
const MUTATION_KEY = "harness.mutationSubmitted";
const identity = (ctx: ScenarioContext) => ({ runId: ctx.runId, accountId: ctx.session?.accountId ?? ctx.config.awsAccountId, region: ctx.session?.region ?? ctx.config.region });

/** Covers direct AWS, MCP and control-plane writes, including a lost response
 * before there is any operation id to register. Failure prevents dispatch. */
export async function markRunMutation(ctx: ScenarioContext): Promise<void> {
  ctx.state.set(MUTATION_KEY, true);
  await blockRunCleanup(ctx.runStateFile, identity(ctx));
}

export function trackControlPlane(client: ControlPlaneClient, ctx: ScenarioContext): ControlPlaneClient {
  // A proxy preserves private fields by binding other methods to their owner.
  return new Proxy(client, { get(target, key) {
    if (key === "proposeCapability") return async (...args: Parameters<ControlPlaneClient["proposeCapability"]>) => {
      await markRunMutation(ctx);
      const result = await target.proposeCapability(...args);
      trackOperation(ctx, result.operation.id);
      ctx.evidence.operation("harness", { operationId: result.operation.id, capability: args[0].capability, detail: "proposal response received; provider quiescence remains unverified" });
      return result;
    };
    if (key === "runAction") return async (...args: Parameters<ControlPlaneClient["runAction"]>) => {
      if (args[1].mode !== "plan") await markRunMutation(ctx);
      return target.runAction(...args);
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** MCP proposals don't use the REST wrapper; register the ledger id explicitly. */
export function trackOperation(ctx: ScenarioContext, id: string): void {
  if (!/^op_[A-Za-z0-9_-]{1,100}$/.test(id)) throw new CleanupAdmissionError();
  const ids = ctx.state.get(KEY) as string[] ?? [];
  if (!ids.includes(id)) ctx.state.set(KEY, [...ids, id]);
}

/** Observations cannot confer cleanup authority. This always refuses external
 * teardown, including an empty in-memory inventory or a missing local marker. */
export async function settleRunOperations(ctx: ScenarioContext): Promise<boolean> {
  const ids = ctx.state.get(KEY) as string[] ?? [];
  try { await readCleanupBlock(ctx.runStateFile, identity(ctx)); }
  catch {
    ctx.evidence.note("Cleanup tracking cannot be revalidated; destructive cleanup is refused.");
    return false;
  }
  try { await markRunMutation(ctx); }
  catch {
    ctx.evidence.note("The cleanup blocker could not be persisted; destructive cleanup is refused.");
    return false;
  }
  for (const id of ids) {
    try {
      if (!ctx.controlPlane) throw new CleanupAdmissionError();
      const op = (await ctx.controlPlane.getOperation(id)).operation;
      if (op.id !== id) throw new CleanupAdmissionError();
      if (!isTerminalStatus(op.status)) {
        await ctx.controlPlane.cancelOperation(id, `acceptance cleanup ${ctx.runId}`);
      }
      // Fresh reads are diagnostics, not a clearance. Temporal completion can
      // return uncertain/cancelled, and progress has no provider-resolution or
      // late-activity receipt. Never infer quiescence from either projection.
      const fresh = (await ctx.controlPlane.getOperation(id)).operation;
      if (fresh.id !== id) throw new CleanupAdmissionError();
      await ctx.workflows?.describe(id);
      await ctx.workflows?.getProgress(id);
      ctx.evidence.operation("harness", { operationId: id, detail: "operation and workflow observations do not establish provider quiescence; cleanup remains blocked" });
    } catch {
      ctx.evidence.note("Operation observation or cancellation could not be confirmed; the durable cleanup blocker remains.");
    }
  }
  ctx.evidence.note("Destructive cleanup is blocked pending authentic native resolution of submitted mutations and worker/provider quiescence. Terminal status, cancellation acknowledgement and a later success do not clear this blocker.");
  return false;
}
