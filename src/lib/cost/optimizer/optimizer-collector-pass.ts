import type { Sql } from "@/lib/controlplane/types";
import { runOptimizerPass, type OptimizerPassOptions, type OptimizerPassPorts, type OptimizerPassResult } from "@/lib/platform/optimizer-pass";
import { createMeasurementCollector, type MeasurementCollectorDeps } from "./measurement-collector";
import { createOptimizerOwnership } from "./optimizer-ownership";
import { getOptimizerSettings } from "@/lib/controlplane/db/repos/optimizer-settings";

/** Join for the existing durable sweep. Each scope gets its own ownership adapter, with no shared mutable scope. */
export async function runMeasuredOptimizerPass(db: Sql, ports: OptimizerPassPorts, deps: MeasurementCollectorDeps, options: OptimizerPassOptions = {}): Promise<OptimizerPassResult> {
  const targets = await ports.listOptedIn(options.maxEnvironments ?? 25);
  const result: OptimizerPassResult = { environments: 0, proposed: 0, refused: 0, skipped: 0, noMeasurements: 0, busy: 0, failed: 0 };
  const collector = createMeasurementCollector(deps);
  const measurements: OptimizerPassPorts["measurements"] = { async load(environment, graph, signal) {
    // Called inside the existing environment guard, immediately before measurement.
    if (!(await getOptimizerSettings(db, environment.workspaceId, environment.environmentId)).enabled) return undefined;
    return collector.load(environment, graph, signal);
  } };
  for (const target of targets) {
    options.signal?.throwIfAborted();
    const run = await runOptimizerPass({ ...ports, measurements, ownership: createOptimizerOwnership(db, target, ports.now),
      // Re-read the scheduling list too; never construct a target from an untrusted request.
      listOptedIn: async () => (await ports.listOptedIn(100)).filter(t => t.workspaceId === target.workspaceId && t.environmentId === target.environmentId) }, options);
    for (const key of Object.keys(result) as (keyof OptimizerPassResult)[]) result[key] += run[key];
  }
  return result;
}
