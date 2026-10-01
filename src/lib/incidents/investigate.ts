/**
 * The investigation orchestrator (spec §21, ADR-0014).
 *
 *   graph + entry ──▶ traverse (ordered request path)
 *                 ──▶ probes (read-only, bounded concurrency 4, per-probe time
 *                     limit; a failure becomes `unknown` evidence, never a throw)
 *                 ──▶ recent changes, drift
 *                 ──▶ rules (weighted clauses → ranked hypotheses)
 *                 ──▶ remediation options (exact capability requests, policy
 *                     dry-run decides `approvalRequired`)
 *
 * Deterministic: for the same graph, entry and port answers the result is the
 * same, apart from the investigation id and timestamps, which come from the
 * injected `newId()` and `now()`. Evidence ids are derived from the check and
 * address, never random. The engine performs no I/O of its own; every read goes
 * through `InvestigationPorts`.
 *
 * It throws only for a malformed REQUEST (a graph for a different environment,
 * an entry that is not in the graph, an empty workspace id). Everything about
 * the environment being unreadable, slow or hostile is reported as evidence.
 */
import { digest } from "@/lib/controlplane/digest";
import type { ResourceGraph } from "@/lib/resources/types";
import type { InvestigationPorts } from "./ports";
import { DEFAULT_PROBE_CONFIG, ProbeContext, type ProbeConfig } from "./probe-context";
import { planTasks, runTasks } from "./probes";
import { attachRemediations } from "./remediation";
import { rankHypotheses } from "./rules";
import { sanitizeText } from "./sanitize";
import { traverse, TraversalError, type RequestPath } from "./traverse";
import type { Evidence, Hop, Investigation } from "./types";

export interface InvestigationEnvironment {
  workspaceId: string;
  projectId?: string;
  environmentId: string;
}

export interface InvestigateInput {
  graph: ResourceGraph;
  environment: InvestigationEnvironment;
  /** a dns_record (address or host), the load balancer, or a container service (address or name) */
  entry?: string;
  /** what the reporter sees; untrusted text, kept only redacted and bounded */
  symptom?: string;
  incidentId?: string;
}

export interface InvestigateOptions {
  /** probe tasks in flight at once (default 4, at most 8) */
  concurrency?: number;
  /** limit for each probe task and each port call, ms (default 15 000) */
  probeTimeoutMs?: number;
  logWindowMinutes?: number;
  changeWindowMinutes?: number;
  deploymentLookbackMinutes?: number;
}

export class InvestigationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigationInputError";
  }
}

const minutes = (n: number | undefined, fallback: number): number => (n !== undefined && Number.isFinite(n) && n > 0 ? n * 60_000 : fallback);

function configFrom(o: InvestigateOptions): ProbeConfig {
  return {
    logWindowMs: minutes(o.logWindowMinutes, DEFAULT_PROBE_CONFIG.logWindowMs),
    changeWindowMs: minutes(o.changeWindowMinutes, DEFAULT_PROBE_CONFIG.changeWindowMs),
    deploymentLookbackMs: minutes(o.deploymentLookbackMinutes, DEFAULT_PROBE_CONFIG.deploymentLookbackMs),
    probeTimeoutMs: o.probeTimeoutMs !== undefined && Number.isFinite(o.probeTimeoutMs) && o.probeTimeoutMs > 0 ? Math.floor(o.probeTimeoutMs) : DEFAULT_PROBE_CONFIG.probeTimeoutMs,
  };
}

/** Give duplicate ids a stable suffix, in evidence order. */
function uniqueIds(evidence: Evidence[]): Evidence[] {
  const seen = new Map<string, number>();
  return evidence.map((e) => {
    const n = (seen.get(e.id) ?? 0) + 1;
    seen.set(e.id, n);
    return n === 1 ? e : { ...e, id: `${e.id}#${n}` };
  });
}

function statusOf(evidence: readonly Evidence[]): "healthy" | "failing" | "unknown" {
  if (evidence.some((e) => e.outcome === "fail")) return "failing";
  if (evidence.length === 0 || evidence.some((e) => e.outcome === "unknown")) return "unknown";
  return "healthy";
}

function pathStatuses(path: RequestPath, evidence: readonly Evidence[]): Investigation["path"] {
  const out: Investigation["path"] = path.steps.map((s) => ({
    hop: s.hop,
    address: s.address,
    status: statusOf(evidence.filter((e) => e.hop === s.hop && e.address === s.address)),
  }));
  // whole-environment hops, always probed: what changed, and drift
  for (const hop of ["deployment", "drift"] as Hop[]) out.push({ hop, status: statusOf(evidence.filter((e) => e.hop === hop)) });
  return out;
}

export async function investigate(input: InvestigateInput, ports: InvestigationPorts, options: InvestigateOptions = {}): Promise<Investigation> {
  const { graph, environment } = input;
  if (!environment?.workspaceId || typeof environment.workspaceId !== "string") throw new InvestigationInputError("environment.workspaceId is required.");
  if (!environment.environmentId || environment.environmentId !== graph.environmentId)
    throw new InvestigationInputError(`The graph belongs to environment ${graph.environmentId}, not ${String(environment.environmentId).slice(0, 80)}.`);
  if (input.entry !== undefined && (typeof input.entry !== "string" || input.entry.length > 200)) throw new InvestigationInputError("entry must be a string of at most 200 characters.");

  let path: RequestPath;
  try {
    path = traverse(graph, input.entry);
  } catch (e) {
    if (e instanceof TraversalError) throw new InvestigationInputError(e.message);
    throw e;
  }

  const config = configFrom(options);
  const startedAt = ports.now();
  const startedIso = startedAt.toISOString();
  const id = ports.newId?.() ?? `inv_${digest({ environmentId: graph.environmentId, startedAt: startedIso, entry: path.entry.address }).slice(0, 20)}`;
  const scope = { workspaceId: environment.workspaceId, ...(environment.projectId ? { projectId: environment.projectId } : {}), environmentId: graph.environmentId };
  const ctx = new ProbeContext(graph, scope, ports, config, startedAt);

  const evidence = uniqueIds(await runTasks(planTasks(path, ports), ctx, options.concurrency ?? 4));

  const symptom = input.symptom !== undefined ? sanitizeText(input.symptom, 300) : undefined;
  const ranked = rankHypotheses(evidence, { hasSymptom: Boolean(symptom) });
  const hypotheses = await attachRemediations(ranked, {
    investigationId: id,
    workspaceId: environment.workspaceId,
    projectId: environment.projectId,
    environmentId: graph.environmentId,
    graph,
    evidence,
    ports,
    timeoutMs: config.probeTimeoutMs,
  });

  const changes = await ctx.changes();
  const notes = [...path.notes];
  if (!ports.httpProbe) notes.push("No end-to-end HTTP probe was made: no prober is configured for this investigation.");
  if (!ports.searchEvents) notes.push("Provider events were not searched: no event source is configured, so image-pull and scheduler failures are visible only through runtime state.");
  if (!changes.ok) notes.push(`Recent changes could not be read: ${changes.message}`);

  return {
    id,
    ...(input.incidentId ? { incidentId: sanitizeText(input.incidentId, 120) } : {}),
    workspaceId: environment.workspaceId,
    environmentId: graph.environmentId,
    startedAt: startedIso,
    finishedAt: ports.now().toISOString(),
    path: pathStatuses(path, evidence),
    evidence,
    hypotheses,
    recentChanges: changes.ok ? changes.value.changes.map((c) => ({ at: c.at, kind: c.kind, summary: c.summary, ...(c.operationId ? { operationId: c.operationId } : {}) })) : [],
    simulated: evidence.some((e) => e.simulated),
    entry: path.entry,
    ...(symptom ? { symptom } : {}),
    ...(notes.length ? { notes } : {}),
  };
}
