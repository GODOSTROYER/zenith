/**
 * The probe plan and runner in isolation: which probes run for which hops, how
 * failures and overruns are reported, and that concurrency and ordering hold.
 */
import { describe, expect, it } from "vitest";
import { traverse } from "@/lib/incidents";
import { DEFAULT_PROBE_CONFIG, ProbeContext } from "@/lib/incidents/probe-context";
import { mapPool, planTasks, runTasks, type ProbeTask } from "@/lib/incidents/probes";
import { ADDR, ENV, NOW, WORKSPACE, buildGraph, healthyWorld, makePorts } from "./fixtures";

const ctxFor = (timeoutMs = 50) => new ProbeContext(buildGraph(), { workspaceId: WORKSPACE, environmentId: ENV }, makePorts(healthyWorld()), { ...DEFAULT_PROBE_CONFIG, probeTimeoutMs: timeoutMs }, NOW);

const task = (id: string, run: (ctx: ProbeContext) => Promise<never[]>, checks = [`${id}.check`]): ProbeTask => ({ id, hop: "application", address: `a/${id}`, checks, run });

describe("planTasks", () => {
  it("plans each hop's fixed probes in path order, then the whole-environment probes", () => {
    const tasks = planTasks(traverse(buildGraph()), makePorts(healthyWorld()));
    expect(tasks.map((t) => t.id)).toEqual([
      `dns@${ADDR.dns}`,
      `tls@${ADDR.tls}`,
      `firewall@${ADDR.fw443}`,
      `firewall@${ADDR.fw80}`,
      `load_balancer@${ADDR.lb}`,
      `firewall@${ADDR.fwLbWeb}`,
      `service@${ADDR.web}`,
      `capacity@${ADDR.web}`,
      `application@${ADDR.web}`,
      `firewall@${ADDR.fwWebDb}`,
      `database@${ADDR.db}`,
      `secret@${ADDR.secret}`,
      `identity@${ADDR.identity}`,
      "changes",
      "deploy_correlation",
      "drift",
    ]);
  });

  it("adds the end-to-end HTTP probe only when the caller supplied a prober", () => {
    const world = healthyWorld();
    world.http = {};
    const ids = planTasks(traverse(buildGraph()), makePorts(world)).map((t) => t.id);
    expect(ids.indexOf("http")).toBe(ids.indexOf("changes") - 1);
    expect(planTasks(traverse(buildGraph()), makePorts(healthyWorld())).map((t) => t.id)).not.toContain("http");
  });

  it("every task declares the checks it can emit, so a failure can be reported check by check", () => {
    for (const t of planTasks(traverse(buildGraph()), makePorts(healthyWorld()))) expect(t.checks.length).toBeGreaterThan(0);
  });
});

describe("runTasks", () => {
  it("turns a throwing probe into unknown evidence for each declared check, with a sanitized reason, and runs the rest", async () => {
    const tasks = [
      task("ok", async () => []),
      task("boom", async () => {
        throw new Error(`exploded password=hunter2-canary ${"x ".repeat(500)}`);
      }, ["boom.a", "boom.b"]),
      task("after", async () => []),
    ];
    const evidence = await runTasks(tasks, ctxFor());
    expect(evidence.map((e) => [e.check, e.outcome])).toEqual([["boom.a", "unknown"], ["boom.b", "unknown"]]);
    expect(evidence[0].address).toBe("a/boom");
    expect(evidence[0].finding).toMatch(/could not be completed/);
    expect(JSON.stringify(evidence)).not.toContain("hunter2-canary");
    expect(evidence[0].finding.length).toBeLessThanOrEqual(400);
  });

  it("abandons a probe that overruns its limit (4x the per-call limit) and reports it unknown", async () => {
    const started = Date.now();
    const evidence = await runTasks([task("slow", () => new Promise(() => {}))], ctxFor(20));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].outcome).toBe("unknown");
    expect(evidence[0].finding).toMatch(/did not finish within 80 ms/);
  });

  it("treats a probe that returns something other than a list as having produced nothing", async () => {
    expect(await runTasks([task("odd", (async () => undefined) as never)], ctxFor())).toEqual([]);
  });

  it("keeps task order in the output whatever order the probes finish in", async () => {
    const delayed = (id: string, ms: number): ProbeTask => ({
      id,
      hop: "application",
      checks: [`${id}.c`],
      run: async (ctx) => {
        await new Promise((r) => setTimeout(r, ms));
        return [ctx.unknown("application", undefined, `${id}.c`, "x")];
      },
    });
    const evidence = await runTasks([delayed("a", 30), delayed("b", 1), delayed("c", 15)], ctxFor(1000), 3);
    expect(evidence.map((e) => e.check)).toEqual(["a.c", "b.c", "c.c"]);
  });
});

describe("mapPool", () => {
  it("never runs more than `limit` at once, returns results in input order, and clamps the limit to at least 1", async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapPool([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60, 70]);
    expect(max).toBe(3);
    expect(await mapPool([1, 2], 0, async (n) => n)).toEqual([1, 2]);
    expect(await mapPool([], 4, async (n) => n)).toEqual([]);
  });
});
