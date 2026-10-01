/**
 * Adapter over the runner server's signed, workspace-scoped machine queue.
 * Awaiting is workspace-scoped. It never re-enqueues: silence after
 * hand-over, unreadable results and cancellation after hand-over are uncertain.
 * Agent-reported timeouts remain the agent's own definitive timeout result.
 */
import { awaitMachineRequest, enqueueMachineRequest } from "@/lib/runners/dispatch";
import type { RunnerRuntime } from "@/lib/runners/runtime";
import { isImplementedOperation, parseMachineArgs } from "./args";
import { MachineOperationError } from "./errors";
import type { MachineDispatchOutcome, MachineRequestDispatcher } from "./types";

export function createRunnerMachineDispatcher(runtime: RunnerRuntime, workspaceId?: string): MachineRequestDispatcher {
  // When unbound, only ids enqueued through this instance may be awaited.
  // A workspace-bound adapter can resume a persisted request after a restart.
  const scopes = new Map<string, string>();
  return {
    async enqueue(req, grantJws) {
      if ((workspaceId !== undefined && req.target.workspaceId !== workspaceId) || req.target.transport !== "zenithd") {
        throw new MachineOperationError("invalid_request", "the dispatcher requires a zenithd target in its workspace");
      }
      if (!isImplementedOperation(req.operation)) throw new MachineOperationError("unsupported_operation", "the operation has no machine argument schema");
      const parsed = parseMachineArgs(req.operation, req.args);
      if (!parsed.ok) throw new MachineOperationError("invalid_args", "the machine arguments are invalid", { issues: parsed.issues });
      const id = await enqueueMachineRequest({
        workspaceId: req.target.workspaceId,
        machineId: req.target.targetId,
        operationId: req.operationId,
        operation: req.operation,
        args: parsed.args,
        grant: grantJws,
        timeoutSec: req.timeoutSec,
        maxOutputBytes: req.maxOutputBytes,
      }, runtime);
      scopes.set(id, req.target.workspaceId);
      return id;
    },
    async await(id, signal): Promise<MachineDispatchOutcome> {
      if (signal.aborted) throw signal.reason ?? new Error("machine wait aborted");
      const scope = workspaceId ?? scopes.get(id);
      if (!scope) throw new MachineOperationError("invalid_request", "the dispatcher cannot await an unknown request without a workspace scope");
      const a = await awaitMachineRequest<Record<string, unknown>>(id, { workspaceId: scope, signal }, runtime);
      // A sealed payload exists for an agent-reported timeout. A reaped or
      // locally settled timeout has no payload and cannot prove the outcome.
      if (a.uncertain && !(a.status === "timed_out" && a.result !== undefined)) return { status: "uncertain" };
      if (a.status === "expired" || a.status === "cancelled") {
        return { status: "rejected", result: { error: "delivery_failed" }, error: "the request was cancelled or expired before delivery" };
      }
      const r = a.result !== null && typeof a.result === "object" && !Array.isArray(a.result) ? a.result : undefined;
      const output = r?.output as MachineDispatchOutcome["output"];
      return {
        status: a.status,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
        exitCode: a.exitCode,
        result: r?.data,
        ...(output ? { output } : {}),
        error: a.error,
      };
    },
  };
}
