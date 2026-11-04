/**
 * Test fixture: a driver GROUP module with no provider-level index above it, the
 * shape of drivers that are merged but not yet registered by anything. The
 * generator must list these as "not registered", and must not call anything.
 */
import type { ResourceDriver } from "@/lib/drivers/types";

const noop = async (): Promise<never> => {
  throw new Error("fixture driver: not callable");
};

export const deploymentDriver: ResourceDriver = {
  id: "kubernetes.deployment@1",
  provider: "kubernetes",
  kind: "container_service",
  nativeType: "k8s:Deployment",
  capabilities: { compile: true, observe: true, runtime: false, verify: false, discover: false, operations: [], evidence: { compile: "contract", observe: "contract" } },
  compile: () => ({ addresses: [] }),
  observe: noop,
};

export const workloadDrivers: ResourceDriver[] = [deploymentDriver];
