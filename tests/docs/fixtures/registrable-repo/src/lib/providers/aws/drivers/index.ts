/**
 * Test fixture for the capability-matrix generator: a provider drivers index in
 * the shape DRIVER-CONVENTIONS.md asks for (an idempotent `register<Provider>Drivers`
 * export). The drivers are fakes with declared evidence; they prove the
 * generator's discovery and rendering, not anything about AWS.
 */
import { registerDriver, type ResourceDriver } from "@/lib/drivers/types";

const noop = async (): Promise<never> => {
  throw new Error("fixture driver: not callable");
};

export const FIXTURE_DRIVERS: ResourceDriver[] = [
  {
    id: "aws.ecs_service@1",
    provider: "aws",
    kind: "container_service",
    nativeType: "aws:ecs_service",
    capabilities: {
      compile: true,
      observe: true,
      runtime: true,
      verify: false,
      discover: false,
      operations: ["service.scale", "service.restart"],
      evidence: { compile: "contract", observe: "contract", runtime: "contract", "service.restart": "contract", "service.scale": "emulated" },
    },
    compile: () => ({ addresses: [] }),
    observe: noop,
    runtime: noop,
    operations: { "service.restart": noop, "service.scale": noop },
  },
  {
    id: "aws.rds_instance@1",
    provider: "aws",
    kind: "postgres",
    nativeType: "aws:rds_instance",
    capabilities: {
      compile: true,
      observe: true,
      runtime: false,
      verify: false,
      discover: false,
      operations: ["database.snapshot", "service.restart"],
      evidence: { compile: "contract", observe: "contract", "database.snapshot": "contract", "service.restart": "simulated" },
    },
    compile: () => ({ addresses: [] }),
    observe: noop,
    operations: { "database.snapshot": noop, "service.restart": noop },
  },
];

export function registerAwsDrivers(): void {
  for (const driver of FIXTURE_DRIVERS) registerDriver(driver);
}
