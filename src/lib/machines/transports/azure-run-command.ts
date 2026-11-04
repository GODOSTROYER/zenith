/**
 * Azure managed Run Command v2 over the broker session's ARM client. Every
 * operation has fixed Linux source and named, validated environment parameters.
 * Poll instanceView, never provisioningState alone or a response-supplied URL.
 * Deterministic request names and a preflight GET reuse prior executions; ARM
 * PUT has no documented atomic create-only guarantee, so the caller's operation
 * lease is still required to prevent racing dispatches across workers. Resources
 * are retained for duplicate detection (deleting a running command cancels it).
 * Any lost mutating submission/result or timeout is uncertain and not retryable.
 * Contract tests and local collector tests only; no live subscription verified.
 */
import { z } from "zod";
import { capability } from "@/lib/capabilities/catalog";
import { digest } from "@/lib/controlplane/digest";
import type { AzureSession } from "@/lib/credentials/types";
import { armClient, ArmError, type ArmClient, type ArmResource } from "@/lib/providers/azure/arm";
import { MachineOperationError } from "../errors";
import { MachineFailureDataSchema, type MachineFailureCode } from "../results";
import { redactDeep, redactText, truncateUtf8 } from "../redact";
import type { MachineDriver, MachineRequest, MachineResult } from "../types";
import { defaultSleep } from "./aws-ssm";
import { parseSsmOutput } from "./aws-ssm-parse";
import { parseAzureVmTargetId } from "./cloud-targets";
import { requestBudget, validateCloudRequest } from "./cloud-request";
import { AZURE_STDERR_BYTES, AZURE_STDOUT_BYTES, AZURE_SUPPORTED, AZURE_WIRE_HEADER, azureScriptPlans, type AzureScriptPlan } from "./azure-scripts";

export const AZURE_RUN_COMMAND_API = "2025-04-01";

export interface AzureRunCommandDriverOptions {
  fileReadPrefixes?: readonly string[];
  restartAllow?: readonly string[];
  backoff?: { initialMs: number; maxMs: number; factor: number };
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

const Wire = z.object({
  stdout: z.string().max(AZURE_STDOUT_BYTES * 4 / 3).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  stderr: z.string().max(AZURE_STDERR_BYTES * 4 / 3).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  exitCode: z.number().int().min(-255).max(255),
  truncated: z.boolean(),
  timedOut: z.boolean(),
}).strict();

const FAILURE_EXIT: Record<number, MachineFailureCode> = { 64: "invalid_parameters", 65: "refused", 66: "not_found", 69: "unavailable" };

function failure(code: MachineFailureCode): Record<string, unknown> {
  return MachineFailureDataSchema.parse({ error: code });
}

/** No raw operation or argument values in ARM names/tags. Identity includes tenant and fixed source. */
export function azureCommandIdentity(req: MachineRequest, plan: AzureScriptPlan): { name: string; requestDigest: string } {
  const requestDigest = digest({ request: req, plan });
  return { name: `zenith-${requestDigest.slice(0, 48)}`, requestDigest };
}

function isAzureSession(session: unknown): session is AzureSession {
  return typeof session === "object" && session !== null && (session as AzureSession).provider === "azure" && typeof (session as AzureSession).subscriptionId === "string" && typeof (session as AzureSession).authorizedFetch === "function";
}

export function createAzureRunCommandMachineDriver(options: AzureRunCommandDriverOptions = {}): MachineDriver {
  const planFor = azureScriptPlans(options);
  const backoff = options.backoff ?? { initialMs: 500, maxMs: 5000, factor: 1.6 };
  if (!(backoff.initialMs > 0 && backoff.maxMs >= backoff.initialMs && backoff.factor >= 1) || !Object.values(backoff).every(Number.isFinite)) throw new Error("Invalid Azure poll backoff");
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  return {
    transport: "azure_run_command", simulated: false, supports: AZURE_SUPPORTED,
    unsupported: { "container.exec": "Azure container.exec has no fixed implementation; use zenithd for container argv execution" },
    async execute(raw, session, parent) {
      const req = validateCloudRequest(raw, "azure_run_command", AZURE_SUPPORTED);
      if (!isAzureSession(session)) throw new MachineOperationError("transport_error", "azure_run_command requires an Azure broker session");
      const target = parseAzureVmTargetId(req.target.targetId);
      if (!target) throw new MachineOperationError("invalid_request", "Azure targetId must be a complete virtual machine ARM id");
      if (target.subscriptionId !== session.subscriptionId.toLowerCase()) throw new MachineOperationError("denied", "the VM is outside the broker session's subscription");
      if (parent.aborted) throw new MachineOperationError("aborted", "the Azure machine request was aborted before dispatch");
      const plan = planFor(req);
      const identity = azureCommandIdentity(req, plan);
      const ref = `${target.path}/runCommands/${identity.name}`;
      const mutating = capability(req.operation).mutates;
      const startedAt = new Date(now()).toISOString();
      const deadline = now() + req.timeoutSec * 1000;
      const budget = requestBudget(req.timeoutSec, parent);
      const client = armClient(session, budget.signal);
      let dispatched = false;
      let submitting = false;

      try {
        const vm = await client.get<ArmResource>(target.path, { apiVersion: AZURE_RUN_COMMAND_API });
        const storage = vm.body?.properties?.storageProfile as { osDisk?: { osType?: unknown } } | undefined;
        if (storage?.osDisk?.osType !== "Linux") throw new MachineOperationError("unsupported_operation", "Azure's fixed machine scripts require a verified Linux OS type");
        if (typeof vm.body.location !== "string" || !/^[a-z0-9-]{1,80}$/i.test(vm.body.location)) throw new MachineOperationError("protocol_violation", "Azure did not supply a valid VM location");

        let resource = await getCommand(client, ref, true);
        if (resource) {
          if (resource.tags?.["zenith-request-digest"] !== identity.requestDigest || resource.properties?.source?.script !== plan.script) {
            throw new MachineOperationError("protocol_violation", "the prior Azure command does not match this request");
          }
          dispatched = true;
        } else {
          submitting = true;
          await client.put(ref, { apiVersion: AZURE_RUN_COMMAND_API, body: {
            location: vm.body.location,
            tags: { "zenith-request-digest": identity.requestDigest },
            properties: { source: { script: plan.script }, parameters: plan.parameters, protectedParameters: plan.protectedParameters, asyncExecution: true, timeoutInSeconds: req.timeoutSec, treatFailureAsDeploymentFailure: false },
          } });
          dispatched = true;
          submitting = false;
        }
        let delay = backoff.initialMs;
        for (;;) {
          if (budget.signal.aborted || now() >= deadline) throw new MachineOperationError(mutating ? "uncertain" : parent.aborted ? "aborted" : "target_unreachable", "the Azure command did not complete within the request budget", { transportRef: ref });
          if (resource) {
            if (resource.tags?.["zenith-request-digest"] !== identity.requestDigest || resource.properties?.source?.script !== plan.script) throw new MachineOperationError("protocol_violation", "the Azure command changed while its execution was being observed", { transportRef: ref });
            const result = commandResult(req, plan, resource, ref, startedAt, now());
            if (result) return result;
          }
          await sleep(Math.min(delay, Math.max(1, deadline - now())), budget.signal);
          delay = Math.min(backoff.maxMs, delay * backoff.factor);
          resource = await getCommand(client, ref, false);
        }
      } catch (e) {
        // A received 4xx PUT response proves rejection; network/5xx/bad JSON cannot.
        const rejectedPut = submitting && e instanceof ArmError && e.status >= 400 && e.status < 500;
        if (mutating && (dispatched || (submitting && !rejectedPut))) {
          throw new MachineOperationError("uncertain", "the Azure machine request may have executed; its outcome is unknown", { transportRef: ref });
        }
        if (e instanceof MachineOperationError) throw e;
        if (budget.signal.aborted) throw new MachineOperationError(parent.aborted ? "aborted" : "target_unreachable", "the Azure request was cancelled or exceeded its budget", dispatched ? { transportRef: ref } : {});
        const code = e instanceof ArmError && e.kind === "not_found" ? "target_unreachable" : e instanceof ArmError && e.kind === "forbidden" ? "denied" : e instanceof ArmError && e.kind === "bad_response" ? "protocol_violation" : "transport_error";
        throw new MachineOperationError(code, "the Azure machine API call failed", dispatched ? { transportRef: ref } : {});
      } finally {
        budget.dispose();
      }
    },
  };
}

interface RunCommand {
  tags?: Record<string, string>;
  properties?: {
    source?: { script?: string };
    provisioningState?: string;
    instanceView?: { executionState?: string; exitCode?: number; output?: string; error?: string };
  };
}

async function getCommand(client: ArmClient, ref: string, absentOk: boolean): Promise<RunCommand | undefined> {
  try {
    const body = (await client.get<RunCommand>(ref, { apiVersion: AZURE_RUN_COMMAND_API, query: { "$expand": "instanceView" } })).body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new MachineOperationError("protocol_violation", "Azure returned an invalid managed command resource");
    return body;
  } catch (e) {
    if (absentOk && e instanceof ArmError && e.kind === "not_found") return;
    throw e;
  }
}

function commandResult(req: MachineRequest, plan: AzureScriptPlan, resource: RunCommand, ref: string, startedAt: string, now: number): MachineResult | undefined {
  const iv = resource?.properties?.instanceView;
  const state = iv?.executionState;
  // Provisioning success means only that the async script started.
  if (!state || ["Pending", "Running", "Unknown"].includes(state)) {
    if (["Failed", "Canceled"].includes(resource?.properties?.provisioningState ?? "")) throw new MachineOperationError("transport_error", "Azure could not provision the managed command", { transportRef: ref });
    return;
  }
  const base = { operation: req.operation, transport: "azure_run_command" as const, startedAt, finishedAt: new Date(now).toISOString(), simulated: false, transportRef: ref };
  if (["TimedOut", "Canceled", "Cancelled"].includes(state)) {
    if (capability(req.operation).mutates) throw new MachineOperationError("uncertain", "the Azure command stopped with an unknown mutating outcome", { transportRef: ref });
    return { ...base, ok: false, data: failure(state === "TimedOut" ? "timeout" : "cancelled") };
  }
  if (!["Succeeded", "Failed"].includes(state)) throw new MachineOperationError("protocol_violation", "Azure returned an unknown command execution state", { transportRef: ref });
  // Python absence is an explicit guest refusal, before the fixed operation ran.
  if (iv?.exitCode === 69) return { ...base, ok: false, data: failure("unavailable") };
  if (typeof iv?.output !== "string" || !iv.output.startsWith(AZURE_WIRE_HEADER) || iv.exitCode !== 0) throw new MachineOperationError("protocol_violation", "Azure returned no complete fixed-script result", { transportRef: ref });
  let decoded: unknown;
  try { decoded = JSON.parse(iv.output.slice(AZURE_WIRE_HEADER.length)); } catch { throw new MachineOperationError("protocol_violation", "Azure returned a malformed fixed-script result", { transportRef: ref }); }
  const parsed = Wire.safeParse(decoded);
  if (!parsed.success) throw new MachineOperationError("protocol_violation", "Azure returned an invalid fixed-script result", { transportRef: ref });
  const wire = parsed.data;
  if (wire.timedOut && capability(req.operation).mutates) throw new MachineOperationError("uncertain", "the fixed guest command timed out after dispatch", { transportRef: ref });
  const stdout = Buffer.from(wire.stdout, "base64").toString("utf8");
  const stderr = Buffer.from(wire.stderr, "base64").toString("utf8");
  const out = truncateUtf8(redactText(stdout).text, req.maxOutputBytes);
  const err = truncateUtf8(redactText(stderr).text, Math.max(0, req.maxOutputBytes - Buffer.byteLength(out.text)));
  const output = { stdout: out.text, stderr: err.text, exitCode: wire.exitCode, truncated: wire.truncated || out.truncated || err.truncated };
  if (wire.timedOut || wire.exitCode !== 0 || state === "Failed") return { ...base, ok: false, data: failure(wire.timedOut ? "timeout" : FAILURE_EXIT[wire.exitCode] ?? "command_failed"), ...(req.operation === "machine.exec" ? { output } : {}) };
  if (req.operation === "machine.exec") return { ...base, ok: true, data: { exitCode: wire.exitCode }, output };
  // A clipped base64 file is never claimed to be an intact read.
  if (wire.truncated && req.operation === "file.read") return { ...base, ok: false, data: failure("output_limit") };
  const safeStdout = wire.truncated ? stdout.slice(0, stdout.lastIndexOf("\n") + 1) : stdout;
  const data = parseSsmOutput(plan.docOp!, safeStdout, req.args);
  if (!data.ok) {
    if (capability(req.operation).mutates) throw new MachineOperationError("protocol_violation", "the mutating guest command returned no valid semantic result", { transportRef: ref });
    return { ...base, ok: false, data: failure("unexpected_output") };
  }
  const redaction = { changed: false };
  let result = redactDeep(data.data, redaction);
  if (wire.truncated) result = { ...result, truncated: true };
  if (typeof result.content === "string") {
    const bounded = truncateUtf8(result.content, req.maxOutputBytes);
    result = { ...result, content: bounded.text, truncated: result.truncated === true || bounded.truncated, ...(redaction.changed ? { redacted: true } : {}) };
    if (req.operation.endsWith("logs")) result.lines = bounded.text.split("\n").filter(Boolean).length;
  }
  if (typeof result.content !== "string" && Buffer.byteLength(JSON.stringify(result)) > req.maxOutputBytes) return { ...base, ok: false, data: failure("output_limit") };
  return { ...base, ok: true, data: result };
}
