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
 *
 * Additive changes made by the machines workstream (WS-MACH), all optional so
 * existing producers keep compiling: `MachineTarget.resourceId`,
 * `MachineResult.evidenceId`, `MachineDriver.unsupported`, and the ports at the
 * bottom of this file (`MachineErrorCode`, `MachineDrivers`,
 * `MachineSessionProvider`, `MachineEvidenceSink`, `MachineRequestDispatcher`).
 */
import type { CapabilityGrantClaims, EvidenceRecord } from "@/lib/controlplane/types";
import type { KubernetesSession } from "@/lib/credentials/types";

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
  /**
   * Zenith resource id (platform store) the capability grant was issued for.
   * The service refuses when a grant names a resource and this differs.
   */
  resourceId?: string;
  /** Zenith resource address, e.g. `compute_instance/worker-1` or a pod selector address */
  address?: string;
  transport: MachineTransport;
  /**
   * EC2 instance id (`i-…`, `mi-…`) for aws_ssm; `namespace`, `namespace/pod`
   * or `namespace/pod/container` for kubernetes; zenithd machine id for zenithd;
   * full virtual machine ARM id for Azure; `projects/{project}/zones/{zone}/instances/{instance}`
   * (or the corresponding Compute selfLink) for GCP. Bare names lack scope and are refused.
   */
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
  /** id of the `machine_request` EvidenceRecord written for this request (set by the service) */
  evidenceId?: string;
}

export interface MachineDriver {
  transport: MachineTransport;
  /** true for sandbox drivers that fabricate results; the service copies it into evidence of rejected requests */
  readonly simulated?: boolean;
  supports: readonly MachineOperation[];
  /**
   * Why an operation in `MACHINE_OPERATIONS` is not in `supports`, in words a
   * caller can show. The service surfaces it in `unsupported_operation`.
   */
  unsupported?: Partial<Record<MachineOperation, string>>;
  execute(req: MachineRequest, session: unknown, signal: AbortSignal): Promise<MachineResult>;
}

/* ---------------------------------- ports ---------------------------------- */

export type MachineErrorCode =
  /** the request envelope itself is malformed */
  | "invalid_request"
  /** operation arguments failed validation (never echoes argument values) */
  | "invalid_args"
  /** the verified grant does not authorize exactly this request */
  | "grant_mismatch"
  | "grant_expired"
  /** no driver for the target's transport, or the driver was not configured */
  | "unsupported_transport"
  /** the transport does not implement the operation (see `MachineDriver.unsupported`) */
  | "unsupported_operation"
  /** a hard limit (timeout, output, argv size) was exceeded */
  | "limit_exceeded"
  /** refused by a local guard (namespace allowlist, path allowlist, protected unit) */
  | "denied"
  | "target_unreachable"
  | "transport_error"
  | "aborted"
  /** the request was dispatched but its outcome cannot be determined; never auto-retried */
  | "uncertain"
  /** the far side answered with something that violates the wire contract */
  | "protocol_violation"
  /** the operation ran (or was refused) but the evidence record could not be written */
  | "evidence_failed";

/** transport → driver, keyed by `MachineTarget.transport` */
export type MachineDrivers = Partial<Record<MachineTransport, MachineDriver>>;

/**
 * Supplies the transport-specific `session` for one request, inside a scope
 * that ends when the request settles. The composition root builds this from
 * the credential broker: `aws_ssm` → an `AwsSession`, Azure/GCP → their brokered
 * provider sessions, `kubernetes` → a
 * `KubernetesMachineSession`, `zenithd` → a `ZenithdSession` carrying the
 * compact grant JWS, sandbox → `undefined`. Machine code never sees
 * credentials; it only receives the session object the broker already scoped.
 */
export interface MachineSessionRequest {
  target: MachineTarget;
  operation: MachineOperation;
  operationId: string;
  grant: CapabilityGrantClaims;
}
export interface MachineSessionProvider {
  withSession<T>(req: MachineSessionRequest, fn: (session: unknown) => Promise<T>): Promise<T>;
}

/** What the zenithd driver needs besides the request: the signed grant it forwards verbatim. */
export interface ZenithdSession {
  /** compact JWS capability grant (`typ: zenith-grant+jwt`); forwarded, never inspected here */
  grantJws: string;
}

/**
 * A Kubernetes session plus the namespace allowlist of the connection it was
 * minted from (`KubernetesConnectionConfig.namespaces`). An empty list means
 * "no namespace is allowlisted", and every request is refused.
 */
export interface KubernetesMachineSession extends KubernetesSession {
  readonly namespaces: readonly string[];
}

export type MachineEvidenceInput = Omit<EvidenceRecord, "id" | "createdAt" | "blobRef"> & {
  /**
   * The redacted full output of an escape-hatch execution (`machine.exec`,
   * `container.exec`), for the store to persist and reference via `blobRef`.
   * Never set for `file.read`.
   */
  blob?: string;
};
export interface MachineEvidenceSink {
  record(input: MachineEvidenceInput): Promise<EvidenceRecord>;
}

/**
 * What the zenithd transport needs from the server side (implemented by
 * WS-RUNSRV over the machine request queue, RUNNER-PROTOCOL §5). The driver
 * hands over the request and the signed grant and waits for the agent's
 * result; it never signs anything itself.
 */
export interface MachineDispatchOutcome {
  /**
   * `succeeded | failed | rejected | timed_out` are the agent's own result
   * statuses (RUNNER-PROTOCOL §4/§5). `uncertain` is the control plane's:
   * the agent went silent past the request's deadline and the outcome is
   * unknown (§6); it is never re-dispatched.
   */
  status: "succeeded" | "failed" | "rejected" | "timed_out" | "uncertain";
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  /** the agent's structured result (see `MachineResultDataSchemas`); validated by the driver */
  result?: unknown;
  /** raw exec output for exec-style operations */
  output?: { stdout: string; stderr: string; truncated?: boolean };
  error?: string;
}
export interface MachineRequestDispatcher {
  /** persist + queue the signed request for the machine; resolves with the request id (`mreq_…`) */
  enqueue(req: MachineRequest, grantJws: string): Promise<string>;
  /** resolves when the agent reported (or the control plane settled) the request; rejects on abort */
  await(id: string, signal: AbortSignal): Promise<MachineDispatchOutcome>;
}
