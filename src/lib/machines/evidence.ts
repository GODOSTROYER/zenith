/**
 * Evidence for machine requests (`EvidenceRecord.kind = "machine_request"`).
 *
 * Every request the service handles, including refused ones, produces one
 * record: who/what/where, the outcome, a digest of the output and a small
 * redacted summary. The summary is built from per-operation ALLOWLISTS of
 * scalar fields, never by copying `data`, so content can only reach it by being
 * added here on purpose:
 *   - `file.read` summaries carry the path, sizes and flags — never contents;
 *   - log operations carry line counts, never lines;
 *   - exec operations carry the (redacted) argv and exit code, and hand the
 *     redacted full output to the store as `blob` so "recorded in full" holds
 *     without putting it in the model-visible summary.
 * Redaction is best-effort (see `redact.ts`).
 */
import { digest } from "@/lib/controlplane/digest";
import { redactDeep, redactText } from "./redact";
import type { MachineErrorCode, MachineEvidenceInput, MachineOperation, MachineRequest, MachineResult } from "./types";

const clip = (s: string, n = 512): string => redactText(s).text.slice(0, n);

/** keep only scalars (numbers, booleans, short redacted strings) under the listed keys */
function pickScalars(src: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!src) return out;
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = clip(v, 200);
  }
  return out;
}

const ARG_KEYS: Partial<Record<MachineOperation, readonly string[]>> = {
  "process.list": ["limit", "sortBy"],
  "service.status": ["unit"],
  "machine.service.restart": ["unit"],
  "container.list": ["all", "limit", "labelSelector"],
  "container.inspect": ["container"],
  "container.logs": ["container", "since", "lines", "timestamps"],
  "container.exec": ["container", "timeoutSec"],
  "file.read": ["path", "maxBytes"],
  "network.portCheck": ["host", "port", "timeoutSec"],
  "network.dnsCheck": ["name", "recordType"],
  "system.logs": ["unit", "since", "lines"],
  "machine.exec": ["cwd", "timeoutSec"],
};

/** result fields that are safe and useful in a summary; content-bearing fields (`content`, `answers`, …) are absent on purpose */
const RESULT_KEYS: Partial<Record<MachineOperation, readonly string[]>> = {
  "service.status": ["loadState", "activeState", "subState"],
  "machine.service.restart": ["restarted", "activeState", "subState"],
  "container.inspect": ["state", "running", "exitCode", "restartCount"],
  "container.logs": ["lines", "truncated", "redacted"],
  "container.exec": ["exitCode", "timedOut"],
  "file.read": ["sizeBytes", "bytesRead", "truncated", "binary", "redacted"],
  "network.portCheck": ["open", "latencyMs"],
  "network.dnsCheck": ["resolved"],
  "system.logs": ["lines", "truncated", "redacted"],
  "machine.exec": ["exitCode", "timedOut"],
  // failure results
};

const argsSummary = (op: MachineOperation, args: Record<string, unknown> | undefined): Record<string, unknown> => {
  const out = pickScalars(args, ARG_KEYS[op] ?? []);
  if ((op === "machine.exec" || op === "container.exec") && Array.isArray(args?.argv)) {
    out.argv = (args.argv as unknown[]).slice(0, 32).map((a) => clip(String(a), 512));
  }
  return out;
};

const base = (req: MachineRequest) => ({
  operation: req.operation,
  targetId: req.target.targetId,
  transport: req.target.transport,
  ...(req.target.address ? { address: req.target.address } : {}),
  ...(req.target.environmentId ? { environmentId: req.target.environmentId } : {}),
  ...(req.target.resourceId ? { resourceId: req.target.resourceId } : {}),
});

/** Evidence for a request that ran (successfully or not) and produced a `MachineResult`. */
export function evidenceForResult(req: MachineRequest, parsedArgs: Record<string, unknown>, result: MachineResult): MachineEvidenceInput {
  const data = result.data;
  const summary: Record<string, unknown> = {
    ...base(req),
    outcome: result.ok ? "succeeded" : "failed",
    ok: result.ok,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt)) || 0,
    ...(result.transportRef ? { transportRef: result.transportRef } : {}),
    args: argsSummary(req.operation, parsedArgs),
    result: result.ok ? pickScalars(data, RESULT_KEYS[req.operation] ?? []) : pickScalars(data, ["error", "status", "timedOut", "exitCode"]),
    ...(req.operation === "container.list" && Array.isArray(data.containers) ? { count: data.containers.length } : {}),
    ...(req.operation === "process.list" && Array.isArray(data.processes) ? { count: data.processes.length } : {}),
    ...(req.operation === "network.dnsCheck" && Array.isArray(data.answers) ? { answerCount: data.answers.length } : {}),
    ...(result.output
      ? {
          exitCode: result.output.exitCode,
          stdoutBytes: Buffer.byteLength(result.output.stdout),
          stderrBytes: Buffer.byteLength(result.output.stderr),
          truncated: result.output.truncated,
        }
      : {}),
    simulated: result.simulated,
  };
  const isExec = req.operation === "machine.exec" || req.operation === "container.exec";
  const blob =
    isExec && result.output
      ? JSON.stringify(
          redactDeep({
            argv: Array.isArray(parsedArgs.argv) ? parsedArgs.argv : [],
            cwd: parsedArgs.cwd,
            stdout: result.output.stdout,
            stderr: result.output.stderr,
            exitCode: result.output.exitCode,
            truncated: result.output.truncated,
          })
        )
      : undefined;
  return {
    workspaceId: req.target.workspaceId,
    operationId: req.operationId,
    kind: "machine_request",
    // digest of exactly what the caller receives (post-redaction), so it can be re-derived from the result
    digest: digest({ data: result.data, output: result.output ?? null }),
    summary,
    simulated: result.simulated,
    ...(blob ? { blob } : {}),
  };
}

/** Evidence for a request that was refused or failed before/without producing a result. */
export function evidenceForRejection(req: MachineRequest, code: MachineErrorCode, message: string, simulated: boolean, issues?: string[], transportRef?: string): MachineEvidenceInput {
  return {
    workspaceId: req.target.workspaceId,
    operationId: req.operationId,
    kind: "machine_request",
    digest: digest({ operationId: req.operationId, operation: req.operation, target: req.target.targetId, code }),
    summary: {
      ...base(req),
      outcome: code === "uncertain" ? "uncertain" : "rejected",
      code,
      message: clip(message, 300),
      ...(issues?.length ? { issues: issues.slice(0, 8).map((i) => clip(i, 200)) } : {}),
      ...(transportRef ? { transportRef } : {}),
    },
    simulated,
  };
}
