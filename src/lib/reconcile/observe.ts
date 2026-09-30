/**
 * The observe step: read every reconcilable node through its driver, inside
 * ONE read-only credential session per provider, with bounded concurrency and
 * a per-node timeout.
 *
 * The rule that shapes it: a node Zenith could not read is reported, never
 * skipped. Every failure mode becomes an explicit observation —
 *
 *   no driver / driver cannot observe      presence `unknown`, says so
 *   access denied (401/403, expired creds)  presence `inaccessible`
 *   any other error, timeout, deadline      presence `unknown`
 *   credential session could not be opened  every node of that provider gets
 *                                           the matching `inaccessible`/`unknown`
 *
 * — and `computeDriftV2` turns those into `unknown`/`inaccessible` findings.
 * A failure message is scrubbed (`redactText`) before it is stored; the session
 * is only ever passed into the driver call and is never stored or returned.
 * Drivers are read-only by contract; this module calls `observe` and `runtime`
 * and nothing else.
 */
import type { DriverContext, ResourceDriver } from "@/lib/drivers/types";
import type { Observation, Presence, ProviderKey, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { describeError, isAccessDenied, redactText, scrubValue } from "./redact";
import type { ReconcileEnvironment, ReconcilePorts, ResolvedReconcileOptions, StoredResourceRef } from "./types";
import { cmp, mapPool, raceTimeout, TimeoutError } from "./util";

export interface ObservableNode {
  node: ResourceNode;
  resource: StoredResourceRef;
  driver: ResourceDriver | undefined;
}

export interface ObservedNode {
  node: ResourceNode;
  resource: StoredResourceRef;
  observation: Observation;
  /** absent when the driver has no runtime capability */
  runtime?: RuntimeState;
}

type ObservingDriver = ResourceDriver & Required<Pick<ResourceDriver, "observe">>;
type RuntimeDriver = ResourceDriver & Required<Pick<ResourceDriver, "runtime">>;
interface ReadableNode extends ObservableNode {
  driver: ObservingDriver;
}

const PRESENCES: readonly Presence[] = ["present", "missing", "inaccessible", "unknown"];
const MAX_SIGNALS = 20;

const canObserve = (d: ResourceDriver | undefined): d is ObservingDriver => d !== undefined && d.capabilities.observe && typeof d.observe === "function";

const canRuntime = (d: ResourceDriver | undefined): d is RuntimeDriver => d !== undefined && d.capabilities.runtime && typeof d.runtime === "function";

/** An observation the CONTROLLER made up for a node it could not read. It claims nothing but "unknown" or "inaccessible". */
export function failureObservation(item: ObservableNode, reason: unknown, at: Date): Observation {
  const presence: Presence = isAccessDenied(reason) ? "inaccessible" : "unknown";
  return {
    address: item.node.address,
    presence,
    attributes: {},
    observedAt: at.toISOString(),
    source: item.driver?.id ?? "reconciler",
    simulated: item.node.provider === "sandbox",
    error: describeError(reason),
  };
}

function noDriverObservation(item: ObservableNode, at: Date): Observation {
  const why = item.driver
    ? `driver ${item.driver.id} cannot observe`
    : `no resource driver is registered for ${item.node.provider} ${item.node.nativeType}`;
  return {
    address: item.node.address,
    presence: "unknown",
    attributes: {},
    observedAt: at.toISOString(),
    source: "reconciler",
    simulated: item.node.provider === "sandbox",
    error: redactText(`${why}, so this resource was not read`),
  };
}

/** Accept a driver's answer only if it is well formed and about this node; otherwise the caller records an unknown. */
function normalizeObservation(raw: Observation, item: ObservableNode, at: Date): Observation | string {
  if (raw === null || typeof raw !== "object" || raw.address !== item.node.address) return "the driver returned an observation for a different resource";
  if (!PRESENCES.includes(raw.presence)) return "the driver returned an unrecognised presence";
  const observedAt = typeof raw.observedAt === "string" && !Number.isNaN(Date.parse(raw.observedAt)) ? raw.observedAt : at.toISOString();
  return {
    ...raw,
    // Defense in depth: a credential-shaped string in an attribute or the native bag is replaced before it is compared, stored or echoed.
    attributes: raw.attributes !== null && typeof raw.attributes === "object" ? scrubValue(raw.attributes) : {},
    ...(raw.native !== undefined && raw.native !== null ? { native: scrubValue(raw.native) } : {}),
    observedAt,
    source: typeof raw.source === "string" && raw.source ? raw.source : (item.driver?.id ?? "reconciler"),
    simulated: raw.simulated === true,
    ...(typeof raw.error === "string" ? { error: redactText(raw.error) } : {}),
  };
}

const unknownRuntime = (item: ObservableNode, signals: string[], at: Date, simulated: boolean): RuntimeState => ({
  address: item.node.address,
  health: "unknown",
  counts: {},
  signals,
  observedAt: at.toISOString(),
  source: item.driver?.id ?? "reconciler",
  simulated,
});

function normalizeRuntime(raw: RuntimeState, item: ObservableNode, at: Date): RuntimeState {
  if (raw === null || typeof raw !== "object" || raw.address !== item.node.address) return unknownRuntime(item, ["runtime_address_mismatch"], at, false);
  return {
    ...raw,
    counts: raw.counts !== null && typeof raw.counts === "object" ? raw.counts : {},
    signals: (Array.isArray(raw.signals) ? raw.signals : []).slice(0, MAX_SIGNALS).map((s) => redactText(String(s), 120)),
    observedAt: typeof raw.observedAt === "string" && !Number.isNaN(Date.parse(raw.observedAt)) ? raw.observedAt : at.toISOString(),
    simulated: raw.simulated === true,
  };
}

/** What a stored runtime says when the node could not be read: unknown, with the reason as a signal. */
function placeholderRuntime(item: ObservableNode, observation: Observation, at: Date): RuntimeState {
  const signal = observation.presence === "missing" ? "resource_missing" : observation.presence === "inaccessible" ? "observe_inaccessible" : "observe_failed";
  return unknownRuntime(item, [signal], at, observation.simulated);
}

interface ObserveArgs {
  environment: ReconcileEnvironment;
  items: readonly ObservableNode[];
  ports: Pick<ReconcilePorts, "now" | "withObserveSession" | "log">;
  options: ResolvedReconcileOptions;
  correlationId: string;
  /** epoch ms: nothing may start, and nothing may run past, this instant */
  deadlineAt: number;
  /** aborts the whole observation (the lease was lost); reads stop and the rest are reported unread */
  signal?: AbortSignal;
}

export async function observeNodes(args: ObserveArgs): Promise<ObservedNode[]> {
  const { environment, items, ports, options, correlationId, deadlineAt, signal: outer } = args;
  const results = new Map<string, ObservedNode>();
  const readable: ReadableNode[] = [];
  for (const item of items) {
    if (canObserve(item.driver)) readable.push({ ...item, driver: item.driver });
    else results.set(item.node.address, { ...item, observation: noDriverObservation(item, ports.now()) });
  }

  const byProvider = new Map<ProviderKey, ReadableNode[]>();
  for (const item of readable) byProvider.set(item.node.provider, [...(byProvider.get(item.node.provider) ?? []), item]);

  for (const provider of [...byProvider.keys()].sort(cmp)) {
    const group = byProvider.get(provider) ?? [];
    const groupBudget = Math.max(0, deadlineAt - Date.now());
    const groupAbort = new AbortController();
    const groupTimer = setTimeout(() => groupAbort.abort(new TimeoutError(groupBudget)), groupBudget);
    const onOuterAbort = (): void => groupAbort.abort(outer?.reason ?? new TimeoutError(0));
    if (outer?.aborted) onOuterAbort();
    else outer?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      await ports.withObserveSession(
        {
          workspaceId: environment.workspaceId,
          ...(environment.projectId ? { projectId: environment.projectId } : {}),
          environmentId: environment.environmentId,
          provider,
          region: environment.region,
          ...(environment.connection ? { connectionId: environment.connection.id } : {}),
          correlationId,
          signal: groupAbort.signal,
        },
        async (session) => {
          await mapPool(group, options.nodeConcurrency, async (item) => {
            results.set(item.node.address, await observeOne({ item, session, args, signal: groupAbort.signal }));
          });
        }
      );
    } catch (err) {
      // The session could not be opened (or was torn down badly): every node of
      // this provider that has no answer yet is unread, for THIS reason.
      for (const item of group)
        if (!results.has(item.node.address)) results.set(item.node.address, { ...item, observation: failureObservation(item, err, ports.now()) });
    } finally {
      clearTimeout(groupTimer);
      outer?.removeEventListener("abort", onOuterAbort);
      // The abandoned callback (a hung session acquisition) must not keep reading after we return.
      if (!groupAbort.signal.aborted) groupAbort.abort(new TimeoutError(0));
    }
    for (const item of group)
      if (!results.has(item.node.address))
        results.set(item.node.address, { ...item, observation: failureObservation(item, "the observation session ended before this resource was read", ports.now()) });
  }

  return [...results.values()].sort((a, b) => cmp(a.node.address, b.node.address));
}

async function observeOne(input: { item: ReadableNode; session: unknown; args: ObserveArgs; signal: AbortSignal }): Promise<ObservedNode> {
  const { item, session, args, signal } = input;
  const { environment, ports, options, deadlineAt } = args;
  const { driver } = item;
  const externalId = item.node.externalRef ?? item.resource.externalId;
  const context = (s: AbortSignal): DriverContext => ({
    provider: item.node.provider,
    region: item.node.region || environment.region,
    workspaceId: environment.workspaceId,
    environmentId: environment.environmentId,
    session,
    signal: s,
    log: ports.log ?? (() => undefined),
    tags: { ...item.node.labels, "zenith:workspace": environment.workspaceId, "zenith:environment": environment.environmentId, "zenith:resource": item.node.address },
    now: () => ports.now(),
  });
  const budget = (): number => Math.min(options.nodeTimeoutMs, deadlineAt - Date.now());

  let observation: Observation;
  if (budget() <= 0) observation = failureObservation(item, "the observation deadline was reached before this resource was read", ports.now());
  else {
    try {
      const answer = normalizeObservation(await raceTimeout((s) => driver.observe(context(s), item.node, externalId), budget(), signal), item, ports.now());
      observation = typeof answer === "string" ? failureObservation(item, answer, ports.now()) : answer;
    } catch (err) {
      observation = failureObservation(item, err, ports.now());
    }
  }

  let runtime: RuntimeState | undefined;
  if (options.observeRuntime && canRuntime(driver)) {
    if (observation.presence !== "present") runtime = placeholderRuntime(item, observation, ports.now());
    else if (budget() <= 0) runtime = unknownRuntime(item, ["runtime_not_read_deadline"], ports.now(), observation.simulated);
    else {
      try {
        const rt = await raceTimeout((s) => driver.runtime(context(s), item.node, observation.externalId ?? externalId), budget(), signal);
        runtime = normalizeRuntime(rt, item, ports.now());
      } catch (err) {
        runtime = unknownRuntime(item, [isAccessDenied(err) ? "runtime_inaccessible" : "runtime_failed"], ports.now(), observation.simulated);
      }
    }
  }
  return { ...item, observation, ...(runtime ? { runtime } : {}) };
}
