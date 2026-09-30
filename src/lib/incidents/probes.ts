/**
 * The probe plan and runner (spec §21, ADR-0014).
 *
 * `planTasks` maps each hop of the request path to its fixed set of read-only
 * probes, in path order, then appends the whole-environment probes (end-to-end
 * HTTP when a prober exists, recent changes, drift). `runTasks` executes them
 * with bounded concurrency (default 4). Each port call is capped at
 * `probeTimeoutMs`; a task as a whole at 4x that.
 *
 * Failure handling is part of the contract: a probe that throws or overruns
 * does not abort the investigation and is never read as a pass. Every check it
 * declares comes back as `unknown` evidence saying why. Results are collected
 * by task index, so the evidence order depends only on the plan, never on which
 * port answered first.
 */
import type { InvestigationPorts } from "./ports";
import type { ProbeContext } from "./probe-context";
import { changesProbe, deployProbe, driftProbe } from "./probes-change";
import { cacheProbe, computeProbe, databaseProbe, identityProbe, queueProbe, secretProbe, storageProbe } from "./probes-dependencies";
import { dnsProbe, firewallProbe, httpProbe, lbProbe, tlsProbe } from "./probes-edge";
import { applicationProbe, capacityProbe, serviceProbe } from "./probes-workload";
import type { Probe } from "./probe-types";
import { sanitizeText } from "./sanitize";
import type { RequestPath } from "./traverse";
import type { Evidence, Hop } from "./types";

export interface ProbeTask {
  /** `<probe id>@<address>` or `<probe id>` for environment-wide probes */
  id: string;
  hop: Hop;
  address?: string;
  checks: readonly string[];
  run(ctx: ProbeContext): Promise<Evidence[]>;
}

const PROBES_BY_HOP: Readonly<Partial<Record<Hop, readonly Probe[]>>> = {
  dns: [dnsProbe],
  tls: [tlsProbe],
  load_balancer: [lbProbe],
  firewall: [firewallProbe],
  container: [serviceProbe, capacityProbe],
  application: [applicationProbe],
  compute: [computeProbe],
  database: [databaseProbe],
  cache: [cacheProbe],
  queue: [queueProbe],
  storage: [storageProbe],
  secret: [secretProbe],
  identity: [identityProbe],
};

export function planTasks(path: RequestPath, ports: Pick<InvestigationPorts, "httpProbe">): ProbeTask[] {
  const tasks: ProbeTask[] = [];
  for (const step of path.steps) {
    for (const probe of PROBES_BY_HOP[step.hop] ?? []) {
      tasks.push({
        id: `${probe.id}@${step.address}`,
        hop: probe.hop,
        address: step.address,
        checks: probe.checks,
        run: (ctx) => probe.run(step, ctx, path),
      });
    }
  }
  const globals = [...(ports.httpProbe ? [httpProbe] : []), changesProbe, deployProbe, driftProbe];
  for (const g of globals) tasks.push({ id: g.id, hop: g.hop, address: g.address, checks: g.checks, run: (ctx) => g.run(ctx, path) });
  return tasks;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** A probe task may make several sequential port calls, each capped at `probeTimeoutMs`. */
const TASK_TIMEOUT_FACTOR = 4;

async function runOne(task: ProbeTask, ctx: ProbeContext): Promise<Evidence[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // each port call is already capped at probeTimeoutMs; a probe makes a few in sequence, so the task backstop is a multiple
  const limit = ctx.config.probeTimeoutMs * TASK_TIMEOUT_FACTOR;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the ${task.id} probe did not finish within ${limit} ms`)), limit);
    });
    const evidence = await Promise.race([task.run(ctx), timeout]);
    return Array.isArray(evidence) ? evidence : [];
  } catch (e) {
    const why = sanitizeText(e instanceof Error ? e.message : String(e), 200);
    return task.checks.map((c) => ctx.unknown(task.hop, task.address, c, why));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runTasks(tasks: readonly ProbeTask[], ctx: ProbeContext, concurrency = 4): Promise<Evidence[]> {
  const limit = Math.min(Math.max(1, Math.floor(concurrency)), 8);
  const batches = await mapPool(tasks, limit, (t) => runOne(t, ctx));
  return batches.flat();
}
