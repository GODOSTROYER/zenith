/**
 * `resourceHealth`: what is running right now, per resource in scope
 * (spec §8 runtime state), read from the provider.
 *
 * This is the observability-side runtime read. It overlaps with resource
 * drivers' `runtime()` deliberately so incident traversal can use it before
 * every driver exists; drivers may later delegate here. It is read-only and
 * returns exactly one `RuntimeState` per health-relevant node in scope:
 *
 *   - AWS / LocalStack `container_service`, `load_balancer`, `postgres`,
 *     `mysql`: read through the injected `AwsSession` (see `aws-health.ts`;
 *     evidence level `contract`).
 *   - sandbox nodes: the simulated health from the sandbox source, labeled
 *     `simulated: true`.
 *   - everything else that has a health notion (redis, queue, function,
 *     compute_instance, other providers): `unknown` with a signal saying why.
 *     "Not read" is a value; it is never reported as healthy.
 *
 * Structural kinds with no runtime health (network, subnet, firewall, DNS,
 * certificates, secrets, identity, log groups, registries, …) are not
 * returned. Sessions are injected and must be used inside the credential
 * broker's `withSession` callback.
 */
import type { AwsSession } from "@/lib/credentials/types";
import type { Observation, ResourceGraph, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { throwIfAborted } from "./abort";
import { ObservabilityInputError, parseScope } from "./query";
import { AWS_HEALTH_KINDS, HEALTH_SOURCE, awsHealth, readFailedSignal } from "./sources/aws-health";
import { nodesInScope } from "./sources/scope";
import { FRESHNESS_BUDGET_MS, answeredProvenance, buildEnvelope, describeSession, evidenceOf, failedProvenance, type TelemetryEnvelope, type TelemetrySession } from "./telemetry";
import type { SignalScope } from "./types";

export interface HealthDeps {
  /** required to read AWS/LocalStack nodes */
  aws?: AwsSession;
  /** the sandbox source (or anything with its `health`), for sandbox nodes */
  sandbox?: { health(scope: SignalScope): Promise<RuntimeState[]> };
  /** latest driver observations — the preferred source of native identifiers */
  observations?: readonly Observation[];
  signal?: AbortSignal;
  now?: () => Date;
}

/** Kinds for which "is it running?" is a meaningful question. */
export const HEALTH_KINDS: ReadonlySet<string> = new Set(["container_service", "load_balancer", "postgres", "mysql", "redis", "queue", "function", "compute_instance"]);
const isHealthNode = (n: ResourceNode) => HEALTH_KINDS.has(n.kind);
const AWS_READABLE: ReadonlySet<string> = new Set(AWS_HEALTH_KINDS);

const unknownFor = (node: ResourceNode, observedAt: string, signal: string, simulated = false): RuntimeState => ({
  address: node.address,
  health: "unknown",
  counts: {},
  signals: [signal],
  observedAt,
  source: HEALTH_SOURCE.unsupported,
  simulated,
});

export async function resourceHealth(scopeInput: SignalScope, graph: ResourceGraph, deps: HealthDeps = {}): Promise<RuntimeState[]> {
  const scope = parseScope(scopeInput);
  if (graph.environmentId !== scope.environmentId) throw new ObservabilityInputError(["scope.environmentId does not match the resource graph"]);
  const now = deps.now ?? (() => new Date());
  const signal = deps.signal ?? new AbortController().signal;
  const observedAt = now().toISOString();

  const nodes = nodesInScope(graph, scope, isHealthNode);
  const states = new Map<string, RuntimeState>();

  const sandboxNodes = nodes.filter((n) => n.provider === "sandbox");
  const awsNodes = nodes.filter((n) => n.provider === "aws" || n.provider === "localstack");
  const otherNodes = nodes.filter((n) => !sandboxNodes.includes(n) && !awsNodes.includes(n));

  if (sandboxNodes.length > 0) {
    let failure: string | undefined;
    if (deps.sandbox) {
      try {
        const got = await deps.sandbox.health({ ...scope, addresses: sandboxNodes.map((n) => n.address) });
        for (const s of got) states.set(s.address, s);
      } catch (err) {
        throwIfAborted(signal);
        failure = readFailedSignal(err);
      }
    }
    for (const n of sandboxNodes) if (!states.has(n.address)) states.set(n.address, unknownFor(n, observedAt, failure ?? (deps.sandbox ? "not_served" : "no_sandbox_health_source"), true));
  }

  if (awsNodes.length > 0) {
    const readable = awsNodes.filter((n) => AWS_READABLE.has(n.kind));
    if (deps.aws && readable.length > 0) {
      const got = await awsHealth(readable, { session: deps.aws, graph, observations: deps.observations, signal, now });
      for (const s of got) states.set(s.address, s);
    }
    for (const n of awsNodes) {
      if (states.has(n.address)) continue;
      const signalName = !AWS_READABLE.has(n.kind) ? `health_not_implemented:${n.kind}` : "no_aws_session";
      states.set(n.address, unknownFor(n, observedAt, signalName));
    }
  }

  for (const n of otherNodes) states.set(n.address, unknownFor(n, observedAt, `health_unsupported:${n.provider}`));

  return [...states.values()].sort((a, b) => a.address.localeCompare(b.address));
}

/* ------------------------------ telemetry envelope ------------------------------ */

export interface HealthTelemetry {
  states: RuntimeState[];
  telemetry: TelemetryEnvelope;
}

function healthEvidence(state: RuntimeState): { level: string; basis: string } {
  if (state.simulated) return { level: "simulated", basis: "generated by the sandbox health source; never presented as real" };
  if (state.source.startsWith("observability.aws.")) return evidenceOf("aws.health");
  return { level: "unknown", basis: "no health reader is implemented for this resource, so nothing was read" };
}

/**
 * Wrap per-resource runtime states in the telemetry envelope: one provenance
 * entry per resource. A state whose health is `unknown` becomes `inaccessible`
 * when its signals say the provider refused the read, otherwise `unknown`; a
 * read state is `fresh` or `stale` by the age of its `observedAt`.
 */
export function describeHealthTelemetry(
  scopeInput: SignalScope,
  states: readonly RuntimeState[],
  opts: { observedAt: string; session?: TelemetrySession; budgetMs?: number }
): TelemetryEnvelope {
  const budgetMs = opts.budgetMs ?? FRESHNESS_BUDGET_MS.health;
  const provenance = states.map((s) => {
    const evidence = healthEvidence(s);
    if (s.health === "unknown") {
      return failedProvenance({ source: s.source, address: s.address, reason: s.signals.length ? s.signals.join(",") : "health was not read", observedAt: s.observedAt, simulated: s.simulated, evidence });
    }
    return answeredProvenance({ source: s.source, address: s.address, provider: s.source.split(".")[1] ?? "unknown", simulated: s.simulated, timestamps: [s.observedAt], observedAt: opts.observedAt, budgetMs, evidence });
  });
  return buildEnvelope({ signal: "health", scope: scopeInput, ...(opts.session ? { session: opts.session } : {}), observedAt: opts.observedAt, provenance, budgetMs });
}

/** `resourceHealth` plus its telemetry envelope; the AWS session (if any) is described, never exposed. */
export async function resourceHealthWithTelemetry(scopeInput: SignalScope, graph: ResourceGraph, deps: HealthDeps = {}): Promise<HealthTelemetry> {
  const now = deps.now ?? (() => new Date());
  const states = await resourceHealth(scopeInput, graph, { ...deps, now });
  const session = describeSession(deps.aws);
  return { states, telemetry: describeHealthTelemetry(scopeInput, states, { observedAt: now().toISOString(), ...(session ? { session } : {}) }) };
}
