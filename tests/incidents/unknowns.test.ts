/**
 * "Unknown" is a value. Everything the engine cannot read, or that a port
 * answers wrongly, slowly or not at all, becomes `unknown` evidence: never a
 * pass, never a throw, and always a lower confidence than the same finding
 * with the evidence in hand.
 */
import { describe, expect, it } from "vitest";
import { investigate, InvestigationInputError, type Investigation, type InvestigationPorts } from "@/lib/incidents";
import type { Observation } from "@/lib/resources/types";
import { ADDR, ENV, PROJECT, WORKSPACE, buildGraph, driftReport, healthyWorld, log, makePorts, newCalls, obs, removeDbIngress, rt, series, type World } from "./fixtures";

const env = { workspaceId: WORKSPACE, projectId: PROJECT, environmentId: ENV };
const go = (world: World, opts: { timeout?: number; ports?: (p: InvestigationPorts) => InvestigationPorts } = {}) => {
  const base = makePorts(world);
  return investigate({ graph: buildGraph(), environment: env, symptom: "503s" }, opts.ports ? opts.ports(base) : base, opts.timeout ? { probeTimeoutMs: opts.timeout } : {});
};
const ev = (inv: Investigation, check: string, address?: string) => inv.evidence.find((e) => e.check === check && (address === undefined || e.address === address))!;
const sg = (inv: Investigation) => inv.hypotheses.find((h) => h.code === "db_unreachable_security_group");

describe("unreadable state lowers confidence and is never fabricated as a pass", () => {
  it("observe() throwing for the firewall leaves the rule unknown and the hypothesis weaker than with the evidence", async () => {
    const full = await go(removeDbIngress(healthyWorld()));
    const w = removeDbIngress(healthyWorld());
    w.observations[ADDR.fwWebDb] = new Error("AccessDenied: not authorized to perform ec2:DescribeSecurityGroupRules");
    const inv = await go(w);
    const e = ev(inv, "firewall.ingress_rule", ADDR.fwWebDb);
    expect(e.outcome).toBe("unknown");
    expect(e.finding).toMatch(/could not be completed/);
    expect(e.finding).toMatch(/observe\(firewall\/web-to-db\) failed/);
    expect(inv.path.find((p) => p.hop === "firewall" && p.address === ADDR.fwWebDb)?.status).toBe("unknown");
    expect(sg(inv)).toBeDefined();
    expect(sg(inv)!.confidence).toBeLessThan(sg(full)!.confidence);
    expect(sg(inv)!.confidence).toBeLessThan(0.8);
    expect(sg(inv)!.supportingEvidence).not.toContain(e.id);
  });

  it("an inaccessible presence is unknown, with the provider's reason kept short", async () => {
    const w = removeDbIngress(healthyWorld());
    w.observations[ADDR.fwWebDb] = obs(ADDR.fwWebDb, "inaccessible", {}, { error: "UnauthorizedOperation: you are not allowed" });
    const e = ev(await go(w), "firewall.ingress_rule", ADDR.fwWebDb);
    expect(e.outcome).toBe("unknown");
    expect(e.finding).toMatch(/access to read it was denied/);
    expect(e.data.presence).toBe("inaccessible");
  });

  it("when nothing can be observed, there are no passes from observation, and the fallback says so below the threshold", async () => {
    const w = healthyWorld();
    for (const k of Object.keys(w.observations)) w.observations[k] = new Error("boom");
    for (const k of Object.keys(w.runtimes)) w.runtimes[k] = new Error("boom");
    w.logs[ADDR.web] = new Error("boom");
    w.metrics = { [ADDR.lb]: new Error("boom"), [ADDR.web]: new Error("boom") };
    w.changes = new Error("boom");
    w.drift = new Error("boom");
    const inv = await go(w);
    expect(inv.evidence.every((e) => e.outcome === "unknown")).toBe(true);
    expect(inv.path.every((p) => p.status === "unknown")).toBe(true);
    expect(inv.hypotheses).toHaveLength(1);
    expect(inv.hypotheses[0].code).toBe("unknown");
    expect(inv.hypotheses[0].confidence).toBeLessThan(0.3);
    expect(inv.hypotheses[0].title).toMatch(/could not be completed/);
    expect(inv.hypotheses[0].nextSteps?.join(" ")).toMatch(/could not be completed/);
    expect(inv.notes?.join(" ")).toMatch(/Recent changes could not be read/);
  });

  it("a runtime the provider could not read is unknown, not healthy", async () => {
    const w = healthyWorld();
    w.runtimes[ADDR.web] = rt(ADDR.web, "unknown", {}, ["read_failed:AccessDenied", "counts_not_read"]);
    w.runtimes[ADDR.lb] = rt(ADDR.lb, "unknown", {}, ["read_failed:AccessDenied"]);
    w.runtimes[ADDR.db] = rt(ADDR.db, "unknown", {}, ["read_failed:Throttling"]);
    const inv = await go(w);
    for (const c of ["service.running_vs_desired", "service.stopped_tasks", "service.rollout", "service.image_pull"]) expect(ev(inv, c).outcome).toBe("unknown");
    expect(ev(inv, "lb.target_health").outcome).toBe("unknown");
    expect(ev(inv, "lb.target_health").finding).toMatch(/AccessDenied/);
    expect(ev(inv, "db.available").outcome).toBe("unknown");
    expect(inv.hypotheses.map((h) => h.code)).toEqual(["unknown"]);
  });

  it("attributes nobody read are not treated as matching", async () => {
    const w = healthyWorld();
    w.observations[ADDR.dns] = { ...obs(ADDR.dns, "present"), attributes: { target: { state: "unknown", reason: "not_inspected" } } } as Observation;
    w.observations[ADDR.tls] = obs(ADDR.tls, "present", {});
    w.observations[ADDR.lb] = obs(ADDR.lb, "present", {});
    const inv = await go(w);
    expect(ev(inv, "dns.record_present").outcome).toBe("pass");
    expect(ev(inv, "dns.record_target").outcome).toBe("unknown");
    expect(ev(inv, "tls.certificate_issued").outcome).toBe("unknown");
    expect(ev(inv, "tls.certificate_expiry").outcome).toBe("unknown");
    expect(ev(inv, "lb.listeners_present").outcome).toBe("unknown");
  });

  it("a firewall rule that exists but whose attributes were not read passes on existence only, and says so", async () => {
    const w = healthyWorld();
    w.observations[ADDR.fwWebDb] = obs(ADDR.fwWebDb, "present");
    const e = ev(await go(w), "firewall.ingress_rule", ADDR.fwWebDb);
    expect(e.outcome).toBe("pass");
    expect(e.finding).toMatch(/only its existence is established/);
    expect(e.data.compared).toBe(0);
  });

  it("the expected-attributes port failing does not turn a present rule into a verified one", async () => {
    const w = healthyWorld();
    w.expected[ADDR.fwWebDb] = new Error("driver crashed");
    const e = ev(await go(w), "firewall.ingress_rule", ADDR.fwWebDb);
    expect(e.outcome).toBe("pass");
    expect(e.data.expectedUnavailable).toBe(true);
    expect(e.finding).toMatch(/only its existence/);
  });
});

describe("logs, metrics, changes and drift", () => {
  it("a log query that fails makes every log-derived check unknown (and image_pull only claims what it looked at)", async () => {
    const w = healthyWorld();
    w.logs[ADDR.web] = new Error("CloudWatch throttled");
    const inv = await go(w);
    expect(ev(inv, "logs.error_signatures").outcome).toBe("unknown");
    expect(ev(inv, "secret.resolution_error").outcome).toBe("unknown");
    expect(ev(inv, "identity.access_denied").outcome).toBe("unknown");
    const pull = ev(inv, "service.image_pull");
    expect(pull.outcome).toBe("pass");
    expect(pull.data.coverage).toEqual(["runtime"]);
  });

  it("zero log lines is unknown, not 'no errors'", async () => {
    const w = healthyWorld();
    w.logs[ADDR.web] = [];
    const e = ev(await go(w), "logs.error_signatures");
    expect(e.outcome).toBe("unknown");
    expect(e.finding).toMatch(/No log lines were returned/);
  });

  it("a partly unavailable log backend with no matches is unknown; with a match it is still a failure", async () => {
    const w = healthyWorld();
    w.logUnavailable = [{ source: "loki", reason: "connection refused" }];
    expect(ev(await go(w), "logs.error_signatures").outcome).toBe("unknown");
    w.logs[ADDR.web] = [log(ADDR.web, "connect ETIMEDOUT 10.0.3.15:5432", 2)];
    expect(ev(await go(w), "logs.db_connect_timeout").outcome).toBe("fail");
  });

  it("log lines that belong to another environment or service are dropped, not used", async () => {
    const w = removeDbIngress(healthyWorld());
    w.logs[ADDR.web] = [
      log(ADDR.web, "connect ETIMEDOUT 10.0.3.15:5432", 3, "error", { environmentId: "env_other" }),
      log(ADDR.web, "connect ETIMEDOUT 10.0.3.15:5432", 2, "error", { address: "container_service/other" }),
    ];
    const inv = await go(w);
    expect(inv.evidence.some((e) => e.check === "logs.db_connect_timeout")).toBe(false);
    const app = ev(inv, "logs.error_signatures");
    expect(app.outcome).toBe("unknown");
  });

  it("missing metrics are unknown for the 5xx and capacity checks", async () => {
    const w = healthyWorld();
    w.metrics = {};
    const inv = await go(w);
    expect(ev(inv, "lb.http_5xx").outcome).toBe("unknown");
    expect(ev(inv, "capacity.cpu").outcome).toBe("unknown");
    expect(ev(inv, "capacity.memory").outcome).toBe("unknown");
  });

  it("a single 5xx sample is a blip, not a burst", async () => {
    const w = healthyWorld();
    w.metrics[ADDR.lb] = [series("http.5xx.rate", [0, 0, 0, 3, 0, 0], "count/min", ADDR.lb)];
    expect(ev(await go(w), "lb.http_5xx").outcome).toBe("pass");
  });

  it("no drift report, a report for another graph, a stale report and another environment's report are all unknown and unused", async () => {
    const missing = removeDbIngress(healthyWorld());
    missing.drift = null;
    expect(ev(await go(missing), "drift.report").outcome).toBe("unknown");

    const otherGraph = removeDbIngress(healthyWorld());
    otherGraph.drift = driftReport([], { graphDigest: "some-other-digest" });
    const a = await go(otherGraph);
    expect(ev(a, "drift.report").outcome).toBe("unknown");
    expect(ev(a, "drift.report").finding).toMatch(/different revision/);
    expect(a.evidence.some((e) => e.check === "drift.missing")).toBe(false);

    const stale = removeDbIngress(healthyWorld());
    stale.drift = driftReport([], { computedAt: new Date(Date.parse("2026-09-30T12:00:00.000Z") - 10 * 3_600_000).toISOString() });
    expect(ev(await go(stale), "drift.report").finding).toMatch(/hours old/);

    const foreign = healthyWorld();
    foreign.drift = driftReport([], { environmentId: "env_other" });
    const f = await go(foreign);
    expect(ev(f, "drift.report").outcome).toBe("unknown");
    expect(ev(f, "drift.report").finding).toMatch(/different environment/);
  });

  it("drift findings for nodes that could not be observed keep the summary unknown, not passing", async () => {
    const w = healthyWorld();
    w.drift = driftReport([], { unobserved: [ADDR.db] });
    const e = ev(await go(w), "drift.report");
    expect(e.outcome).toBe("unknown");
    expect(e.finding).toContain(ADDR.db);
  });

  it("the changes port failing is unknown, and recentChanges is empty rather than invented", async () => {
    const w = healthyWorld();
    w.changes = new Error("ledger unavailable");
    const inv = await go(w);
    expect(ev(inv, "changes.recent").outcome).toBe("unknown");
    expect(inv.recentChanges).toEqual([]);
  });
});

describe("slow, wrong and malformed port answers", () => {
  it("a port that never answers is abandoned after the probe time limit and reported unknown", async () => {
    const w = healthyWorld();
    w.observations[ADDR.db] = "hang";
    const started = Date.now();
    const inv = await go(w, { timeout: 60 });
    expect(Date.now() - started).toBeLessThan(3000);
    const e = ev(inv, "db.exists");
    expect(e.outcome).toBe("unknown");
    expect(e.finding).toMatch(/did not answer within 60 ms/);
    // the rest of the investigation completed normally
    expect(ev(inv, "dns.record_present").outcome).toBe("pass");
  });

  it("an observation for a different address is rejected instead of being believed", async () => {
    const w = healthyWorld();
    w.observations[ADDR.db] = obs("postgres/someone-elses-db", "present");
    const e = ev(await go(w), "db.exists");
    expect(e.outcome).toBe("unknown");
    expect(e.finding).toMatch(/different address or with a malformed result/);
  });

  it("a runtime answer for a different address is rejected too", async () => {
    const w = healthyWorld();
    w.runtimes[ADDR.web] = rt("container_service/other", "healthy", { desired: 1, running: 1 });
    expect(ev(await go(w), "service.running_vs_desired").outcome).toBe("unknown");
  });

  it("a malformed log result (a port bug) becomes unknown evidence; the investigation still completes", async () => {
    const inv = await go(healthyWorld(), { ports: (p) => ({ ...p, searchLogs: (async () => undefined) as never }) });
    expect(ev(inv, "logs.error_signatures").outcome).toBe("unknown");
    expect(ev(inv, "logs.error_signatures").finding).toMatch(/answered with something malformed/);
    expect(inv.evidence.length).toBeGreaterThan(10);
  });

  it("a synchronously throwing port is handled like an asynchronous one", async () => {
    const inv = await go(healthyWorld(), {
      ports: (p) => ({
        ...p,
        observe: ((address: string) => {
          if (address === ADDR.db) throw new Error("sync boom");
          return p.observe(address);
        }) as never,
      }),
    });
    expect(ev(inv, "db.exists").outcome).toBe("unknown");
  });

  it("timestamps in the future or unparseable change records are dropped, not believed", async () => {
    const w = healthyWorld();
    w.changes = [
      { at: "not a date", kind: "deployment", summary: "x" },
      { at: "2027-01-01T00:00:00Z", kind: "deployment", summary: "from the future" },
      { at: "2026-09-30T11:50:00Z", kind: "deployment", summary: "real" },
    ];
    const inv = await go(w);
    expect(inv.recentChanges.map((c) => c.summary)).toEqual(["real"]);
    expect(ev(inv, "changes.recent").data.droppedMalformed).toBe(2);
  });
});

describe("the simulated flag", () => {
  it("is true when any evidence came from simulated data, and never otherwise", async () => {
    const real = await go(healthyWorld());
    expect(real.simulated).toBe(false);
    const w = healthyWorld();
    w.runtimes[ADDR.db] = rt(ADDR.db, "healthy", {}, ["db_status:available"], { simulated: true });
    const inv = await go(w);
    expect(inv.simulated).toBe(true);
    expect(ev(inv, "db.available").simulated).toBe(true);
    expect(ev(inv, "dns.record_present").simulated).toBe(false);
  });

  it("simulated logs mark the evidence derived from them", async () => {
    const w = healthyWorld();
    w.simulated = true;
    const inv = await go(w);
    expect(ev(inv, "logs.error_signatures").simulated).toBe(true);
    expect(inv.simulated).toBe(true);
  });
});

describe("a malformed request is the one thing that throws", () => {
  it("rejects a graph for another environment", async () => {
    await expect(investigate({ graph: buildGraph(), environment: { ...env, environmentId: "env_staging" } }, makePorts(healthyWorld()))).rejects.toThrow(InvestigationInputError);
  });

  it("rejects an entry that is not in the graph, without echoing more than a bounded excerpt", async () => {
    const calls = newCalls();
    await expect(investigate({ graph: buildGraph(), environment: env, entry: `nope-${"x".repeat(190)}` }, makePorts(healthyWorld(), calls))).rejects.toThrow(/is not an address, DNS host or service name/);
    const err = await investigate({ graph: buildGraph(), environment: env, entry: `nope-${"x".repeat(190)}` }, makePorts(healthyWorld(), calls)).catch((e: Error) => e);
    expect((err as Error).message.length).toBeLessThan(260);
    await expect(investigate({ graph: buildGraph(), environment: env, entry: "y".repeat(201) }, makePorts(healthyWorld(), calls))).rejects.toThrow(/at most 200/);
    expect(calls.observe).toEqual([]); // nothing was read for a bad request
  });

  it("rejects an entry that is not an entry point", async () => {
    await expect(investigate({ graph: buildGraph(), environment: env, entry: ADDR.db }, makePorts(healthyWorld()))).rejects.toThrow(/must be a dns_record/);
  });

  it("rejects a missing workspace id", async () => {
    await expect(investigate({ graph: buildGraph(), environment: { ...env, workspaceId: "" } }, makePorts(healthyWorld()))).rejects.toThrow(/workspaceId/);
  });
});
