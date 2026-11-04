import { productReads } from "@/lib/agent-access/v3/adapters";
import type { Broker } from "@/lib/capabilities/platform";
import type { Sql } from "@/lib/controlplane/types";
import { workerStoreScope } from "@/lib/execution/product-port";
import { composeAgentPorts } from "@/lib/platform/agent-ports";
import { platformCredentialBroker } from "@/lib/platform/credentials";
import { composeOptimizerPorts } from "@/lib/platform/optimizer";
import type { OptimizerPassOptions } from "@/lib/platform/optimizer-pass";
import type { ReconcilePassPorts } from "@/lib/reconcile/pass-types";
import { createMeasurementDeps } from "./measurement-ports";
import { runMeasuredOptimizerPass } from "./optimizer-collector-pass";

/** Existing sweep only, canonical authority only; consent gates collection and every proposal. */
export async function runSweepOptimizer(db: Sql, reconcile: ReconcilePassPorts, broker: Broker, options: OptimizerPassOptions) {
  options.signal?.throwIfAborted();
  return workerStoreScope(async () => {
    const reads = productReads(), now = () => new Date();
    const { observability } = composeAgentPorts(db, platformCredentialBroker(db), { reads, now });
    return runMeasuredOptimizerPass(db, composeOptimizerPorts(db, reconcile, broker), createMeasurementDeps(broker, observability, reads, now), options);
  });
}
