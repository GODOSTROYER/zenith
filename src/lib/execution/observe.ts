/**
 * Reading an environment: observe, runtime and (optionally) verify for every
 * node of the desired graph, bounded in parallel, inside ONE brokered observe
 * session — shared by `verifyInfrastructure`, `observeEnvironment` and the
 * reconcile pass.
 *
 * Honesty rules (spec §42, invariant 7 "Unknown is a value"):
 *   - a driver that throws, times out or returns something for another address
 *     yields an `unknown` observation carrying a scrubbed reason — never a
 *     missing entry and never a guess;
 *   - a node whose driver has no `observe` simply has no observation, which drift
 *     reports as `unknown` ("nobody read it"), not as a match;
 *   - only MANAGED nodes are verified; referenced nodes are read, never judged;
 *   - what a driver returns is persisted as returned (drivers own redaction of
 *     their `native` bag); `error` strings are scrubbed here.
 *
 * Persistence is best effort per node: the store refuses secret-shaped values,
 * and one bad row must not hide everything else that was observed. Failures are
 * counted and reported in the caller's evidence.
 */
import type { ProviderConnection, ProviderSession } from "@/lib/credentials/types";
import type { ResourceDriver, VerificationResult } from "@/lib/drivers/types";
import type { Observation, ResourceGraph, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { mapLimit, raceAbort } from "./concurrency";
import type { ExecLike } from "./context";
import type { StoredResource } from "./ports";
import type { Runtime } from "./runtime";
import { driverContext } from "./session";
import { errorText, safeText } from "./text";

export interface NodeState {
  node: ResourceNode;
  driver?: ResourceDriver;
  observation?: Observation;
  runtime?: RuntimeState;
  verification?: VerificationResult;
}

const unknownObservation = (rt: Runtime, node: ResourceNode, driver: ResourceDriver, err: unknown): Observation => ({
  address: node.address,
  presence: "unknown",
  attributes: {},
  observedAt: rt.iso(),
  source: driver.id,
  simulated: false,
  error: errorText(err, 200),
});

export async function collectState(
  rt: Runtime,
  ec: ExecLike,
  graph: ResourceGraph,
  session: ProviderSession,
  signal: AbortSignal,
  opts: { verify: boolean; stored: ReadonlyMap<string, StoredResource>; connection?: ProviderConnection }
): Promise<NodeState[]> {
  const nodes = graph.nodes.filter((n) => n.ownership !== "external");
  return mapLimit(nodes, rt.limits.concurrency, async (node): Promise<NodeState> => {
    const driver = rt.drivers(node.provider, node.nativeType);
    const state: NodeState = { node, ...(driver ? { driver } : {}) };
    if (!driver) return state;
    const externalId = opts.stored.get(node.address)?.externalId;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(rt.limits.nodeTimeoutMs)]);
    const ctx = driverContext(rt, ec, session, bounded, { node, connection: opts.connection });

    if (driver.observe) {
      try {
        const observation = await raceAbort(driver.observe(ctx, node, externalId), bounded);
        state.observation =
          observation.address === node.address
            ? { ...observation, ...(observation.error ? { error: safeText(observation.error, 200) } : {}) }
            : unknownObservation(rt, node, driver, `the driver returned an observation for ${safeText(observation.address, 80)}, not ${node.address}`);
      } catch (err) {
        state.observation = unknownObservation(rt, node, driver, err);
      }
    }
    if (driver.runtime) {
      try {
        const runtime = await raceAbort(driver.runtime(ctx, node, externalId), bounded);
        if (runtime.address === node.address) state.runtime = runtime;
      } catch (err) {
        rt.log("warn", "runtime read failed", { address: node.address, error: errorText(err) });
      }
    }
    if (opts.verify && node.ownership === "managed" && driver.verify && state.observation) {
      try {
        const verification = await raceAbort(driver.verify(ctx, node, state.observation, state.runtime), bounded);
        state.verification = verification.address === node.address ? verification : undefined;
      } catch (err) {
        state.verification = {
          address: node.address,
          status: "unknown",
          checks: [{ id: "verify_error", description: "the driver could not complete verification", passed: "unknown", detail: errorText(err, 200) }],
          checkedAt: rt.iso(),
          simulated: false,
        };
      }
    }
    return state;
  });
}

/** Write observations and runtime state to the platform store; returns how many rows could not be written. */
export async function persistState(rt: Runtime, ec: Pick<ExecLike, "workspaceId">, states: readonly NodeState[], stored: ReadonlyMap<string, StoredResource>): Promise<number> {
  let failures = 0;
  for (const state of states) {
    const row = stored.get(state.node.address);
    if (!row) continue;
    try {
      if (state.observation) await rt.d.resources.appendObservation({ workspaceId: ec.workspaceId, resourceId: row.id, observation: state.observation });
      if (state.runtime) await rt.d.resources.upsertRuntime({ workspaceId: ec.workspaceId, resourceId: row.id, runtime: state.runtime });
    } catch (err) {
      failures++;
      rt.log("warn", "could not persist an observation", { address: state.node.address, error: errorText(err) });
    }
  }
  return failures;
}

export async function storedResources(rt: Runtime, ec: Pick<ExecLike, "workspaceId" | "environmentId">): Promise<Map<string, StoredResource>> {
  return new Map((await rt.d.resources.list(ec.workspaceId, ec.environmentId)).map((r) => [r.address, r]));
}
