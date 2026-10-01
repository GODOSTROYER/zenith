/**
 * Machine / workload control plane (spec §18, §19, ADR-0012).
 *
 * `executeMachineOperation` is the entry point; `createMachineDrivers` builds
 * the transport table (AWS SSM, Kubernetes, zenithd, or all-simulated for
 * sandbox environments); `machineTransportFor` resolves a target to its driver.
 * Azure Run Command and GCP OS management are declared in the contract but have
 * no driver yet: a target using them is refused with `unsupported_transport`.
 */
import { MachineOperationError } from "./errors";
import { createAwsSsmMachineDriver, type AwsSsmDriverOptions } from "./transports/aws-ssm";
import { createKubernetesMachineDriver, type KubernetesDriverOptions } from "./transports/kubernetes";
import { createSimulatedMachineDriver } from "./transports/simulated";
import { createZenithdMachineDriver } from "./transports/zenithd";
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
export { createRunnerMachineDispatcher } from "./dispatcher";
export { createMachineSessionProvider, type MachineSessionOptions } from "./sessions";

export interface MachineDriverOptions {
  /** sandbox environments: every transport is simulated and nothing real is contacted */
  sandbox?: boolean;
  /** required to enable the zenithd transport (implemented server-side by WS-RUNSRV) */
  dispatcher?: MachineRequestDispatcher;
  ssm?: AwsSsmDriverOptions;
  kubernetes?: KubernetesDriverOptions;
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
    ...(options.dispatcher ? { zenithd: createZenithdMachineDriver({ dispatcher: options.dispatcher, queueGraceSec: options.queueGraceSec }) } : {}),
  };
}

/** Resolve a target to the driver for its transport, or refuse with `unsupported_transport`. */
export function machineTransportFor(target: MachineTarget, drivers: MachineDrivers): MachineDriver {
  const d = drivers[target.transport];
  if (!d) throw new MachineOperationError("unsupported_transport", `no machine driver is configured for transport ${target.transport}`);
  return d;
}
