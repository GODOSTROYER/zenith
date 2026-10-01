/** Run-scoped operation tracking. Never destroy infrastructure while its deploy
 * could still create resources. Cancellation failure is an incomplete cleanup,
 * not permission to race a running worker with a destructive sweep. */
import { isTerminalStatus, waitForOperation, type ControlPlaneClient } from "./clients/control-plane";
import type { ScenarioContext } from "./types";

const KEY = "harness.operationIds";
export function trackControlPlane(client: ControlPlaneClient, ctx: ScenarioContext): ControlPlaneClient {
  // A proxy preserves private fields by binding other methods to their owner.
  return new Proxy(client, { get(target, key) {
    if (key === "proposeCapability") return async (...args: Parameters<ControlPlaneClient["proposeCapability"]>) => {
      const result = await target.proposeCapability(...args);
      const ids = ctx.state.get(KEY) as string[] ?? [];
      if (!ids.includes(result.operation.id)) ctx.state.set(KEY, [...ids, result.operation.id]);
      ctx.evidence.operation("harness", { operationId: result.operation.id, capability: result.operation.capability, status: result.operation.status });
      return result;
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** MCP proposals don't use the REST wrapper; register the ledger id explicitly. */
export function trackOperation(ctx: ScenarioContext, id: string): void {
  const ids = ctx.state.get(KEY) as string[] ?? [];
  if (!ids.includes(id)) ctx.state.set(KEY, [...ids, id]);
}

export async function settleRunOperations(ctx: ScenarioContext): Promise<boolean> {
  const ids = ctx.state.get(KEY) as string[] ?? [];
  if (!ids.length) return true;
  if (!ctx.controlPlane) return false;
  let safe = true;
  for (const id of ids) {
    try {
      let op = (await ctx.controlPlane.getOperation(id)).operation;
      if (!isTerminalStatus(op.status)) {
        await ctx.controlPlane.cancelOperation(id, `acceptance cleanup ${ctx.runId}`);
        const result = await waitForOperation(ctx.controlPlane, id, { until: (o) => isTerminalStatus(o.status), timeoutMs: Math.min(ctx.config.deployTimeoutMs, 120_000), pollMs: 2_000, sleep: ctx.sleep, now: () => ctx.now().getTime() });
        if (!result.reached) throw new Error("Cancellation did not reach a terminal state.");
        op = result.operation;
      }
      ctx.evidence.operation("harness", { operationId: id, status: op.status, detail: "terminal before teardown" });
    } catch {
      safe = false;
      ctx.evidence.note(`Cannot establish that operation ${id} stopped; destructive cleanup is refused until its worker is quiescent.`);
    }
  }
  return safe;
}
