/** Shared envelope/argument checks and a cancellable wall-clock budget for cloud machine calls. */
import { isImplementedOperation, MachineRequestSchema, parseMachineArgs } from "../args";
import { MachineOperationError } from "../errors";
import type { MachineOperation, MachineRequest, MachineTransport } from "../types";

export function validateCloudRequest(req: MachineRequest, transport: MachineTransport, supports: readonly MachineOperation[]): MachineRequest {
  const envelope = MachineRequestSchema.safeParse(req);
  if (!envelope.success || req.target.transport !== transport) throw new MachineOperationError("invalid_request", "the cloud machine request is malformed");
  if (!isImplementedOperation(req.operation) || !supports.includes(req.operation)) throw new MachineOperationError("unsupported_operation", "this cloud transport cannot perform the requested guest operation");
  const parsed = parseMachineArgs(req.operation, envelope.data.args);
  if (!parsed.ok) throw new MachineOperationError("invalid_args", "arguments failed validation", { issues: parsed.issues });
  if (req.operation === "machine.exec" && Number((parsed.args as Record<string, unknown>).timeoutSec) > req.timeoutSec) throw new MachineOperationError("limit_exceeded", "the command timeout exceeds the request budget");
  return { ...envelope.data, args: parsed.args } as MachineRequest;
}

export function requestBudget(timeoutSec: number, parent: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  timer.unref();
  return { signal: AbortSignal.any([parent, controller.signal]), dispose: () => clearTimeout(timer) };
}

/** Always static messages: provider error bodies and exception causes may contain secret values. */
export const invalidCloudArgs = (): MachineOperationError => new MachineOperationError("invalid_args", "parameters failed the fixed guest script contract");
