/**
 * Machine / workload control plane (spec §18, §19, ADR-0012).
 *
 * `executeMachineOperation` is the entry point; `createMachineDrivers` builds
 * the transport table (AWS SSM, Kubernetes, Azure, GCP, zenithd, or all-simulated for
 * sandbox environments); `machineTransportFor` resolves a target to its driver.
 * GCP exposes inventory inspection only; other guest operations are refused.
 */
import { MachineOperationError } from "./errors";
import { createAwsSsmMachineDriver, type AwsSsmDriverOptions } from "./transports/aws-ssm";
import { createKubernetesMachineDriver, type KubernetesDriverOptions } from "./transports/kubernetes";
import { createSimulatedMachineDriver } from "./transports/simulated";
import { createZenithdMachineDriver } from "./transports/zenithd";
import { createAzureRunCommandMachineDriver, type AzureRunCommandDriverOptions } from "./transports/azure-run-command";
import { createGcpOsManagementMachineDriver, type GcpOsManagementDriverOptions } from "./transports/gcp-os-management";
import type { MachineDriver, MachineDrivers, MachineRequestDispatcher, MachineTarget, MachineTransport } from "./types";

export * from "./types";
export * from "./errors";
export * from "./limits";
export * from "./args";
export * from "./results";
export * from "./guards";
export { executeMachineOperation, capabilityForOperation, type MachineExecutionContext } from "./service";
export { evidenceForRejection, evidenceForResult } from "./evidence";
export { redactText, redactDeep } from "./redact";
export { argvToCommandLine, shellQuote } from "./shell";
export { createAwsSsmMachineDriver, ssmCommentFor, type AwsSsmDriverOptions } from "./transports/aws-ssm";
export {
  buildSsmDocuments,
  ssmDocumentsTofu,
  ZENITH_SSM_DOCUMENTS,
  OPERATION_DOCUMENTS,
  type SsmCommandDocument,
  type SsmDocumentOptions,
  type SsmTofuOptions,
} from "./transports/aws-ssm-docs";
export { createKubernetesMachineDriver, defaultK8sClientFactory, type K8sClients, type KubernetesDriverOptions } from "./transports/kubernetes";
export { createZenithdMachineDriver, type ZenithdDriverOptions } from "./transports/zenithd";
export { createSimulatedMachineDriver } from "./transports/simulated";
export { createAzureRunCommandMachineDriver, type AzureRunCommandDriverOptions } from "./transports/azure-run-command";
export { createGcpOsManagementMachineDriver, type GcpOsManagementDriverOptions } from "./transports/gcp-os-management";
export { parseAzureVmTargetId, parseGcpInstanceTargetId } from "./transports/cloud-targets";
export { createRunnerMachineDispatcher } from "./dispatcher";
export { createMachineSessionProvider, type MachineSessionOptions } from "./sessions";

export interface MachineDriverOptions {
  /** sandbox environments: every transport is simulated and nothing real is contacted */
  sandbox?: boolean;
  /** required to enable the zenithd transport (implemented server-side by WS-RUNSRV) */
  dispatcher?: MachineRequestDispatcher;
  ssm?: AwsSsmDriverOptions;
  kubernetes?: KubernetesDriverOptions;
  azure?: AzureRunCommandDriverOptions;
  gcp?: GcpOsManagementDriverOptions;
  queueGraceSec?: number;
}

const ALL_TRANSPORTS: readonly MachineTransport[] = ["aws_ssm", "kubernetes", "azure_run_command", "gcp_os_management", "zenithd"];

/** The transport → driver table for one deployment. Transports without a driver are simply absent. */
export function createMachineDrivers(options: MachineDriverOptions = {}): MachineDrivers {
  if (options.sandbox) {
    return Object.fromEntries(ALL_TRANSPORTS.map((t) => [t, createSimulatedMachineDriver(t)])) as MachineDrivers;
  }
  return {
    aws_ssm: createAwsSsmMachineDriver(options.ssm),
    kubernetes: createKubernetesMachineDriver(options.kubernetes),
    azure_run_command: createAzureRunCommandMachineDriver(options.azure),
    gcp_os_management: createGcpOsManagementMachineDriver(options.gcp),
    ...(options.dispatcher ? { zenithd: createZenithdMachineDriver({ dispatcher: options.dispatcher, queueGraceSec: options.queueGraceSec }) } : {}),
  };
}

/** Resolve a target to the driver for its transport, or refuse with `unsupported_transport`. */
export function machineTransportFor(target: MachineTarget, drivers: MachineDrivers): MachineDriver {
  const d = drivers[target.transport];
  if (!d) throw new MachineOperationError("unsupported_transport", `no machine driver is configured for transport ${target.transport}`);
  return d;
}
