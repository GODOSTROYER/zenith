/**
 * zenithd transport (ADR-0010, RUNNER-PROTOCOL §5): semantic operations on a
 * machine that runs Zenith's outbound agent.
 *
 * This driver signs nothing and opens no connection. It hands a validated
 * request plus the compact grant JWS to an injected `MachineRequestDispatcher`
 * (implemented server-side by WS-RUNSRV over the signed request queue),
 * waits for the agent's result, and validates what comes back against
 * `MachineResultDataSchemas` (the contract the Go agent implements; see
 * `results.ts`). Unknown keys in an agent result are stripped; a result that
 * does not parse is reported as `malformed_result`, never passed through.
 *
 * Status mapping (agent statuses from the wire protocol):
 *   succeeded → ok: true
 *   failed    → ok: false (command/tool failure; agent's `result` may carry a failure code)
 *   rejected  → ok: false, `refused` (a local guard on the machine said no:
 *               `exec.enabled: false`, `files.readAllow`, `services.restartAllow`, …)
 *   timed_out → ok: false, `timeout` (the agent's own deadline; definitive)
 *   uncertain → throws `uncertain` (the control plane lost the agent past the
 *               deadline, RUNNER-PROTOCOL §6; never re-dispatched)
 * A local deadline or a failed wait after dispatch is uncertain for every
 * operation. An explicit user abort of a read remains aborted; a mutating
 * request is uncertain. None of these outcomes permits re-dispatch.
 */
import { capability } from "@/lib/capabilities/catalog";
import { isImplementedOperation, parseMachineArgs, type ImplementedOperation } from "../args";
import { MachineOperationError } from "../errors";
import { redactText, truncateUtf8 } from "../redact";
import { MachineFailureDataSchema, MachineResultDataSchemas, type MachineFailureCode } from "../results";
import type { MachineDispatchOutcome, MachineDriver, MachineOperation, MachineRequest, MachineRequestDispatcher, MachineResult, ZenithdSession } from "../types";

export interface ZenithdDriverOptions {
  dispatcher: MachineRequestDispatcher;
  /** seconds beyond `timeoutSec` to wait for a queued request to be picked up and answered (default 30) */
  queueGraceSec?: number;
  now?: () => number;
}

const SUPPORTED: readonly MachineOperation[] = [
  "machine.inspect",
  "process.list",
  "service.status",
  "machine.service.restart",
  "container.list",
  "container.inspect",
  "container.logs",
  "container.exec",
  "file.read",
  "network.portCheck",
  "network.dnsCheck",
  "system.metrics",
  "system.logs",
  "machine.exec",
];

const UNSUPPORTED: Partial<Record<MachineOperation, string>> = {
  "file.write": "file.write is not implemented by zenithd or any machine transport yet",
  "file.upload": "file.upload is not implemented by zenithd or any machine transport yet",
  "package.install": "package.install is not implemented by zenithd or any machine transport yet",
};

const validIso = (v: string | undefined): string | undefined => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);

const MACHINE_ID = /^[A-Za-z0-9_-]{4,80}$/;
const isExecOp = (op: MachineOperation): boolean => op === "machine.exec" || op === "container.exec";

function isZenithdSession(s: unknown): s is ZenithdSession {
  return typeof s === "object" && s !== null && typeof (s as { grantJws?: unknown }).grantJws === "string" && (s as { grantJws: string }).grantJws.length > 0;
}

const failure = (code: MachineFailureCode, reason?: string, extra: { status?: string; exitCode?: number | null; timedOut?: boolean } = {}): Record<string, unknown> =>
  MachineFailureDataSchema.parse({ error: code, ...(reason ? { reason: redactText(reason).text.slice(0, 1000) } : {}), ...extra });

export function createZenithdMachineDriver(options: ZenithdDriverOptions): MachineDriver {
  const { dispatcher } = options;
  const graceMs = (options.queueGraceSec ?? 30) * 1000;
  const now = options.now ?? Date.now;

  async function execute(req: MachineRequest, session: unknown, signal: AbortSignal): Promise<MachineResult> {
    if (!isZenithdSession(session)) throw new MachineOperationError("transport_error", "zenithd requires a session carrying the compact grant JWS");
    if (!SUPPORTED.includes(req.operation) || !isImplementedOperation(req.operation)) {
      throw new MachineOperationError("unsupported_operation", UNSUPPORTED[req.operation] ?? `${req.operation} is not implemented for zenithd`);
    }
    if (!MACHINE_ID.test(req.target.targetId)) throw new MachineOperationError("invalid_request", "zenithd targetId must be a registered machine id");
    const parsed = parseMachineArgs(req.operation, req.args);
    if (!parsed.ok) throw new MachineOperationError("invalid_args", "arguments failed validation", { issues: parsed.issues });

    const mutating = capability(req.operation).mutates;
    const startedAt = new Date(now()).toISOString();
    // the agent receives the NORMALIZED arguments (defaults filled, paths canonical), never the caller's raw object
    const normalized: MachineRequest = { ...req, args: parsed.args as Record<string, unknown> };

    let id: string;
    try {
      id = await dispatcher.enqueue(normalized, session.grantJws);
    } catch (e) {
      throw new MachineOperationError("transport_error", "could not queue the machine request", { retryable: true, cause: e });
    }

    const deadline = AbortSignal.timeout(req.timeoutSec * 1000 + graceMs);
    const wait = AbortSignal.any([signal, deadline]);
    let outcome: MachineDispatchOutcome;
    try {
      outcome = await dispatcher.await(id, wait);
    } catch (e) {
      if (signal.aborted || wait.aborted) {
        const userAbort = signal.aborted;
        if (mutating || !userAbort) throw new MachineOperationError("uncertain", "the request was queued for the machine but waiting for its result ended; its outcome is unknown", { transportRef: id, cause: e });
        if (userAbort) throw new MachineOperationError("aborted", "the machine request was aborted", { transportRef: id, cause: e });
      }
      throw new MachineOperationError("uncertain", "waiting for the dispatched machine result failed; its outcome is unknown", { transportRef: id, cause: e });
    }
    return map(req, outcome, id, startedAt);
  }

  function map(req: MachineRequest, o: MachineDispatchOutcome, id: string, startedAt: string): MachineResult {
    const result = (ok: boolean, data: Record<string, unknown>, output?: MachineResult["output"]): MachineResult => ({
      ok,
      operation: req.operation,
      data: isExecOp(req.operation) ? { ...data, exitCode: typeof data.exitCode === "number" && Number.isInteger(data.exitCode) ? data.exitCode : null } : data,
      ...(isExecOp(req.operation) ? { output: output ?? { stdout: "", stderr: "", exitCode: null, truncated: false } } : output ? { output } : {}),
      // agent-supplied timestamps are data: use them only when they parse
      startedAt: validIso(o.startedAt) ?? startedAt,
      finishedAt: validIso(o.finishedAt) ?? new Date(now()).toISOString(),
      transport: "zenithd",
      transportRef: id,
      simulated: false,
    });

    if (o.status === "uncertain") {
      throw new MachineOperationError("uncertain", "the machine went silent past the request deadline; the request may or may not have run", { transportRef: id });
    }
    if (o.status === "rejected") {
      const coded = MachineFailureDataSchema.safeParse(o.result);
      return result(false, coded.success ? coded.data : failure("refused", o.error ?? "the machine's local policy refused the request"));
    }
    if (o.status === "timed_out") return result(false, failure("timeout", o.error, { timedOut: true }));

    if (isExecOp(req.operation)) {
      if (o.output && (typeof o.output.stdout !== "string" || typeof o.output.stderr !== "string")) return result(false, failure("malformed_result", "the agent returned malformed exec output"));
      const out = o.output ? { stdout: truncateUtf8(o.output.stdout, req.maxOutputBytes), stderr: truncateUtf8(o.output.stderr, req.maxOutputBytes), truncated: o.output.truncated === true } : undefined;
      const exitCode = typeof o.exitCode === "number" && Number.isInteger(o.exitCode) ? o.exitCode : null;
      const output = out
        ? { stdout: out.stdout.text, stderr: out.stderr.text, exitCode, truncated: out.truncated || out.stdout.truncated || out.stderr.truncated }
        : { stdout: "", stderr: "", exitCode, truncated: false };
      const ok = o.status === "succeeded" && exitCode === 0;
      const coded = MachineFailureDataSchema.safeParse(o.result);
      return result(ok, ok ? { exitCode } : coded.success ? { ...coded.data, exitCode } : failure(exitCode === null ? "malformed_result" : "command_failed", o.error, { exitCode }), output);
    }

    if (o.status === "failed") {
      const coded = MachineFailureDataSchema.safeParse(o.result);
      return result(false, coded.success ? coded.data : failure("command_failed", o.error));
    }

    const schema = MachineResultDataSchemas[req.operation as ImplementedOperation];
    const parsed = schema.safeParse(o.result);
    if (!parsed.success) {
      return result(false, failure("malformed_result", `the agent's result does not match the ${req.operation} contract (${parsed.error.issues[0]?.path.join(".") || "root"})`, { status: o.status }));
    }
    return result(true, parsed.data as Record<string, unknown>);
  }

  return { transport: "zenithd", supports: SUPPORTED, unsupported: UNSUPPORTED, execute };
}
