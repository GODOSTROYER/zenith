/**
 * Read-only GCP machine inspection over Compute and OS Inventory REST APIs.
 * OS/guest policies reconcile desired state; patch-job pre/post steps are patch
 * execution, not an exactly-once generic guest command transport. Neither is used
 * to disguise an on-demand machine operation. Only machine.inspect is supported;
 * mutations, runtime metrics, processes, files and logs require zenithd.
 * Inventory is a cached snapshot: its timestamp/state is returned explicitly;
 * unavailable fields remain absent. Compute metadata, startup scripts, labels,
 * service accounts and package inventories are never copied into results.
 * Fake HTTP contract tests only; no live Google project has been verified.
 */
import type { GcpSession } from "@/lib/credentials/types";
import { gcpCall, type RestContext, type RestResult } from "@/lib/providers/gcp/rest";
import { MachineOperationError } from "../errors";
import { MachineResultDataSchemas } from "../results";
import { redactDeep } from "../redact";
import { MACHINE_OPERATIONS, type MachineDriver } from "../types";
import { parseGcpInstanceTargetId } from "./cloud-targets";
import { requestBudget, validateCloudRequest } from "./cloud-request";

export const GCP_MACHINE_REFUSAL = "GCP OS management provides inventory and desired-state policies, not a safe generic on-demand guest execution API; use zenithd for guest operations";

export interface GcpOsManagementDriverOptions { now?: () => number }

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): string | undefined => typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;

function isGcpSession(s: unknown): s is GcpSession {
  return typeof s === "object" && s !== null && (s as GcpSession).provider === "gcp" && typeof (s as GcpSession).authorizedFetch === "function";
}

function requireCompute(result: RestResult): void {
  if (result.outcome === "ok") return;
  const code = result.outcome === "missing" ? "target_unreachable" : result.outcome === "inaccessible" ? "denied" : "transport_error";
  throw new MachineOperationError(code, "the Compute instance could not be read");
}

export function createGcpOsManagementMachineDriver(options: GcpOsManagementDriverOptions = {}): MachineDriver {
  const now = options.now ?? Date.now;
  const supports = ["machine.inspect"] as const;
  return {
    transport: "gcp_os_management", simulated: false, supports,
    unsupported: Object.fromEntries(MACHINE_OPERATIONS.filter((op) => op !== "machine.inspect").map((op) => [op, GCP_MACHINE_REFUSAL])),
    async execute(raw, session, parent) {
      if (raw.operation !== "machine.inspect") throw new MachineOperationError("unsupported_operation", GCP_MACHINE_REFUSAL);
      const req = validateCloudRequest(raw, "gcp_os_management", supports);
      if (!isGcpSession(session)) throw new MachineOperationError("transport_error", "gcp_os_management requires a GCP broker session");
      const target = parseGcpInstanceTargetId(req.target.targetId);
      if (!target) throw new MachineOperationError("invalid_request", "GCP targetId must identify a project, zone and Compute instance");
      if (target.project !== session.projectId) throw new MachineOperationError("denied", "the instance is outside the broker session's project");
      if (parent.aborted) throw new MachineOperationError("aborted", "the GCP machine request was aborted before it started");
      const startedAt = new Date(now()).toISOString();
      const budget = requestBudget(req.timeoutSec, parent);
      const ctx: RestContext = { session, signal: budget.signal };
      try {
        const compute = await gcpCall(ctx, "GET", `https://compute.googleapis.com/compute/v1/${target.path}`);
        requireCompute(compute);
        const id = compute.json.id;
        const name = compute.json.name;
        if (typeof id !== "string" || !/^[1-9][0-9]{0,19}$/.test(id) || typeof name !== "string" || (!/^[0-9]+$/.test(target.instance) && name !== target.instance) || (/^[0-9]+$/.test(target.instance) && id !== target.instance)) {
          throw new MachineOperationError("protocol_violation", "Compute returned no matching instance identity");
        }
        const inventory = await gcpCall(ctx, "GET", `https://osconfig.googleapis.com/v1/projects/${target.project}/locations/${target.zone}/instances/${id}/inventory?view=BASIC`);
        const state = inventory.outcome === "ok" ? "available" : inventory.outcome === "missing" ? "missing" : inventory.outcome === "inaccessible" ? "inaccessible" : "unavailable";
        const data: Record<string, unknown> = { inventory: { state } };
        if (inventory.outcome === "ok") {
          const identity = typeof inventory.json.name === "string" ? /^projects\/([^/]+)\/locations\/([^/]+)\/instances\/([0-9]+)\/inventory$/.exec(inventory.json.name) : null;
          if (!identity || identity[2] !== target.zone || identity[3] !== id || (identity[1] !== target.project && !/^[0-9]+$/.test(identity[1]))) {
            throw new MachineOperationError("protocol_violation", "OS Inventory returned no matching instance identity");
          }
          const os = record(inventory.json.osInfo);
          const osData = { id: text(os.shortName, 64), version: text(os.version, 64), pretty: text(os.longName, 200) };
          data.hostname = text(os.hostname, 253);
          data.os = osData;
          data.kernel = text(os.kernelRelease, 128);
          data.arch = text(os.architecture, 32);
          const observedAt = typeof inventory.json.updateTime === "string" && Number.isFinite(Date.parse(inventory.json.updateTime)) ? new Date(inventory.json.updateTime).toISOString() : undefined;
          data.inventory = { state, ...(observedAt ? { observedAt } : {}) };
        }
        const validated = MachineResultDataSchemas["machine.inspect"].safeParse(redactDeep(data));
        if (!validated.success) throw new MachineOperationError("protocol_violation", "OS Inventory failed the machine result contract");
        if (Buffer.byteLength(JSON.stringify(validated.data)) > req.maxOutputBytes) return { ok: false, operation: req.operation, data: { error: "output_limit" }, startedAt, finishedAt: new Date(now()).toISOString(), transport: "gcp_os_management", simulated: false };
        return { ok: true, operation: req.operation, data: validated.data, startedAt, finishedAt: new Date(now()).toISOString(), transport: "gcp_os_management", simulated: false };
      } catch (e) {
        if (budget.signal.aborted) throw new MachineOperationError(parent.aborted ? "aborted" : "target_unreachable", "the GCP machine read was cancelled or exceeded its budget");
        if (e instanceof MachineOperationError) throw e;
        throw new MachineOperationError("transport_error", "the GCP machine API call failed");
      } finally { budget.dispose(); }
    },
  };
}
