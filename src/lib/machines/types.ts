/**
 * Machine / workload control plane contract (spec §18, §19, ADR-0012).
 *
 * One semantic API over several transports: AWS SSM, Kubernetes exec/API,
 * Azure Run Command, GCP OS management, and zenithd (Zenith's own outbound
 * agent). Callers ask for a semantic operation (`service.status`,
 * `container.logs`, `network.portCheck`); each driver maps it to a fixed,
 * parameter-validated implementation. Arguments are never concatenated into
 * a shell string.
 *
 * `machine.exec` / `container.exec` are the escape hatch: separate capability,
 * strongest policy gate, disabled by default on zenithd, bounded by timeout
 * and output limits, and recorded in full in the evidence log.
 * No path requires public SSH.
 */

export const MACHINE_OPERATIONS = [
  "machine.inspect",
  "process.list",
  "service.status",
  "machine.service.restart",
  "container.list",
  "container.inspect",
  "container.logs",
  "container.exec",
  "file.read",
  "file.write",
  "file.upload",
  "package.install",
  "network.portCheck",
  "network.dnsCheck",
  "system.metrics",
  "system.logs",
  "machine.exec",
] as const;
export type MachineOperation = (typeof MACHINE_OPERATIONS)[number];

export type MachineTransport = "aws_ssm" | "kubernetes" | "azure_run_command" | "gcp_os_management" | "zenithd";

export interface MachineTarget {
  workspaceId: string;
  environmentId?: string;
  /** Zenith resource address, e.g. `compute_instance/worker-1` or a pod selector address */
  address?: string;
  transport: MachineTransport;
  /** EC2 instance id, `namespace/pod[/container]`, zenithd machine id, … */
  targetId: string;
}

export interface MachineRequest {
  operationId: string;
  target: MachineTarget;
  operation: MachineOperation;
  /** operation-specific, validated per operation (see `MachineArgsSchemas` in the machines module) */
  args: Record<string, unknown>;
  /** hard limits the transport enforces */
  timeoutSec: number;
  maxOutputBytes: number;
}

export interface MachineResult {
  ok: boolean;
  operation: MachineOperation;
  /** structured, bounded, redacted result */
  data: Record<string, unknown>;
  /** raw stdout/stderr for exec-style operations, truncated */
  output?: { stdout: string; stderr: string; exitCode: number | null; truncated: boolean };
  startedAt: string;
  finishedAt: string;
  transport: MachineTransport;
  /** transport request id (SSM command id, zenithd request id) */
  transportRef?: string;
  simulated: boolean;
}

export interface MachineDriver {
  transport: MachineTransport;
  supports: readonly MachineOperation[];
  execute(req: MachineRequest, session: unknown, signal: AbortSignal): Promise<MachineResult>;
}
